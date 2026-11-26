"""Continuity Pack service: MAP PHASE, REDUCE & MERGE, Deterministic XML Builder, and Shared-Surname-Safe Alias Indexer."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from pydantic import BaseModel, Field

from app.core.database import db_session
from app.core.gemini_pool import GeminiPool, gemini_pool
from app.services.languages.base import normalize_term_key

logger = logging.getLogger(__name__)

MISSING_REVERSE_PREFIX = "[Thiếu chiều ngược]"

_NAME_PART_SPLIT_RE = re.compile(r"[・·•\s　/]+")
_ASCII_WORD_RE = re.compile(r"^[A-Za-z0-9_-]+$")


# ---------- Gemini Structured Response Schemas ----------

class MapCharacterEntry(BaseModel):
    name: str
    display_name: str = ""
    aliases: list[str] = Field(default_factory=list)


class DialogueInteractionEntry(BaseModel):
    speaker: str
    listener: str
    self_pronoun_raw: str = ""
    address_raw: str = ""
    suggested_pair_vi: str = ""
    emotion_note: str = ""
    evidence_quote: str = ""


class ChapterMapSchema(BaseModel):
    main_events: list[str] = Field(default_factory=list)
    characters_actual: list[MapCharacterEntry] = Field(default_factory=list)
    characters_mentioned: list[MapCharacterEntry] = Field(default_factory=list)
    dialogue_interactions: list[DialogueInteractionEntry] = Field(default_factory=list)


class SubArcStateEntry(BaseModel):
    character_name: str
    subarc: str = ""
    current_state: str = ""
    notes: str = ""


class VolumeReduceSchema(BaseModel):
    volume_summary: str = ""
    rtas_current_avg: float = 3.5
    rtas_drift: str = ""
    sub_arc_states: list[SubArcStateEntry] = Field(default_factory=list)


_MAP_SYSTEM_PROMPT = """Bạn là chuyên gia phân tích cốt truyện và xưng hô Light Novel / Web Novel.
Nhiệm vụ: Đọc chương truyện gốc và trích xuất JSON chính xác theo schema yêu cầu.

QUY TẮC BẮT BUỘC:
1. `main_events`: 3–8 sự kiện chính theo đúng trình tự thời gian, viết ngắn gọn bằng tiếng Việt.
2. `characters_actual`: danh sách nhân vật trực tiếp có mặt/hành động/thoại trong chương (gồm `name` tên gốc trong raw, `display_name` tên Romaji/Việt, `aliases` biệt danh xuất hiện trong chương).
3. `characters_mentioned`: nhân vật chỉ được nhắc tên gián tiếp, không xuất hiện trực tiếp trong cảnh.
4. `dialogue_interactions`: trích xuất MỌI cặp tương tác hội thoại trực tiếp giữa 2 nhân vật cụ thể trong chương:
   - `speaker`: tên người nói (khớp với tên trong `characters_actual`)
   - `listener`: tên người nghe (khớp với tên trong `characters_actual`)
   - `self_pronoun_raw`: đại từ tự xưng trong bản gốc (VD: 俺, 私, 僕, わし, 我, 나...)
   - `address_raw`: cách gọi đối phương trong bản gốc (VD: お前, 貴様, ルディ, 師匠, 선배...)
   - `suggested_pair_vi`: gợi ý cặp xưng hô tiếng Việt dạng "Tự xưng-Gọi đối phương" (VD: "Anh-Em", "Em-Anh", "Tôi-Cậu", "Ta-Nhóc", "Con-Cha", "Em-Sư phụ")
   - `emotion_note`: sắc thái quan hệ/cảm xúc ngắn gọn
   - `evidence_quote`: trích nguyên văn 1 câu thoại ngắn tiêu biểu từ văn bản gốc chứng minh cách xưng hô đó.
5. Trả về đúng JSON hợp lệ, không thêm lời giải thích ngoài JSON."""


_REDUCE_SYSTEM_PROMPT = """Bạn là biên tập viên tổng hợp Continuity Pack cho Light Novel / Web Novel tiếng Việt.
Dựa trên tóm tắt sự kiện các chương và danh sách nhân vật của tập, hãy trả về JSON ngắn gọn gồm:
- `volume_summary`: đoạn tóm tắt mạch truyện chính của cả tập bằng tiếng Việt (5–10 câu, súc tích, chính xác).
- `rtas_current_avg`: điểm trung bình mức độ gắn kết/sắc thái cảm xúc của tập (số thực từ 1.0 đến 5.0).
- `rtas_drift`: nhận xét ngắn về xu hướng biến động cảm xúc/quan hệ so với nền (VD: "Positive - ..." hoặc "Tense - ...").
- `sub_arc_states`: danh sách trạng thái phát triển tâm lý/arc (`character_name`, `subarc`, `current_state`, `notes`) cho các nhân vật quan trọng có chuyển biến trong tập.

TUYỆT ĐỐI KHÔNG xuất XML và KHÔNG liệt kê Glossary."""


def _norm_key(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip().lower()


def _parse_json_object(raw_text: str) -> dict[str, Any]:
    text = (raw_text or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("Phản hồi Gemini không chứa JSON object hợp lệ.")
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Phản hồi Gemini không phải dạng JSON object.")
    return parsed


def _coerce_map_result(raw_dict: dict[str, Any]) -> ChapterMapSchema:
    """Normalize slightly loose LLM JSON shapes into strict ChapterMapSchema."""
    def _coerce_char_list(raw_list: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not isinstance(raw_list, list):
            return out
        for item in raw_list:
            if isinstance(item, str) and item.strip():
                out.append({"name": item.strip(), "display_name": "", "aliases": []})
            elif isinstance(item, dict):
                name = str(item.get("name") or item.get("canonical_name") or item.get("display_name") or "").strip()
                if not name:
                    continue
                display = str(item.get("display_name") or item.get("romaji") or "").strip()
                raw_aliases = item.get("aliases") or []
                if isinstance(raw_aliases, str):
                    aliases = [a.strip() for a in re.split(r"[|,、]", raw_aliases) if a.strip()]
                elif isinstance(raw_aliases, list):
                    aliases = [str(a).strip() for a in raw_aliases if str(a).strip()]
                else:
                    aliases = []
                out.append({"name": name, "display_name": display, "aliases": aliases})
        return out

    interactions: list[dict[str, Any]] = []
    raw_inter = raw_dict.get("dialogue_interactions") or []
    if isinstance(raw_inter, list):
        for item in raw_inter:
            if not isinstance(item, dict):
                continue
            speaker = str(item.get("speaker") or "").strip()
            listener = str(item.get("listener") or "").strip()
            if not speaker or not listener:
                continue
            interactions.append(
                {
                    "speaker": speaker,
                    "listener": listener,
                    "self_pronoun_raw": str(item.get("self_pronoun_raw") or "").strip(),
                    "address_raw": str(item.get("address_raw") or "").strip(),
                    "suggested_pair_vi": str(item.get("suggested_pair_vi") or "").strip(),
                    "emotion_note": str(item.get("emotion_note") or "").strip(),
                    "evidence_quote": str(item.get("evidence_quote") or "").strip(),
                }
            )

    raw_events = raw_dict.get("main_events") or []
    events = [str(e).strip() for e in raw_events if str(e).strip()] if isinstance(raw_events, list) else []

    return ChapterMapSchema(
        main_events=events,
        characters_actual=[MapCharacterEntry(**c) for c in _coerce_char_list(raw_dict.get("characters_actual"))],
        characters_mentioned=[MapCharacterEntry(**c) for c in _coerce_char_list(raw_dict.get("characters_mentioned"))],
        dialogue_interactions=[DialogueInteractionEntry(**d) for d in interactions],
    )


def _load_existing_aliases(aliases_json: str | None) -> list[str]:
    if not aliases_json:
        return []
    try:
        parsed = json.loads(aliases_json)
        if isinstance(parsed, list):
            return [str(x).strip() for x in parsed if str(x).strip()]
    except (ValueError, TypeError):
        pass
    return []


def _merge_aliases(existing: Iterable[str], additions: Iterable[str], exclude_names: set[str]) -> list[str]:
    seen: set[str] = {_norm_key(n) for n in exclude_names if n}
    merged: list[str] = []
    for raw in list(existing) + list(additions):
        cleaned = raw.strip()
        key = _norm_key(cleaned)
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(cleaned)
    return merged


# ---------- 1. MAP PHASE ----------

def run_map_phase(
    volume_id: int,
    *,
    force_rerun: bool = False,
    chapter_ids: list[int] | None = None,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Run MAP PHASE per chapter using GeminiPool + structured JSON response_schema, caching in chapters.summary_json."""
    active_pool = pool or gemini_pool

    with db_session(db_path) as conn:
        vol_row = conn.execute(
            """
            SELECT v.id, v.series_id, v.volume_number, v.title, s.title AS series_title, s.source_lang
            FROM volumes v
            JOIN series s ON s.id = v.series_id
            WHERE v.id = ?
            """,
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

        series_id = int(vol_row["series_id"])
        source_lang = str(vol_row["source_lang"])
        series_title = str(vol_row["series_title"])

        if chapter_ids:
            placeholders = ",".join("?" for _ in chapter_ids)
            chapters = conn.execute(
                f"""
                SELECT id, chapter_index, title, raw_text, summary_json, status
                FROM chapters
                WHERE volume_id = ? AND id IN ({placeholders})
                ORDER BY chapter_index ASC
                """,
                [volume_id, *chapter_ids],
            ).fetchall()
        else:
            chapters = conn.execute(
                """
                SELECT id, chapter_index, title, raw_text, summary_json, status
                FROM chapters
                WHERE volume_id = ?
                ORDER BY chapter_index ASC
                """,
                (volume_id,),
            ).fetchall()

        if not chapters:
            raise ValueError("Tập này chưa có chương nào để chạy MAP PHASE.")

        # Gather known character hints from existing Roster & approved Glossary
        known_chars = conn.execute(
            "SELECT canonical_name, display_name FROM characters WHERE series_id = ? ORDER BY id ASC LIMIT 80",
            (series_id,),
        ).fetchall()
        approved_char_terms = conn.execute(
            """
            SELECT source_term, vi_term FROM glossary_terms
            WHERE series_id = ? AND status = 'approved' AND term_type = 'Character'
            ORDER BY total_freq DESC LIMIT 80
            """,
            (series_id,),
        ).fetchall()

    hint_lines: list[str] = []
    seen_hints: set[str] = set()
    for r in known_chars:
        k = _norm_key(r["canonical_name"])
        if k not in seen_hints:
            seen_hints.add(k)
            hint_lines.append(f"- {r['canonical_name']} ({r['display_name']})")
    for r in approved_char_terms:
        k = _norm_key(r["source_term"])
        if k not in seen_hints:
            seen_hints.add(k)
            hint_lines.append(f"- {r['source_term']} ({r['vi_term']})")

    hints_block = (
        "Danh sách nhân vật đã biết của bộ truyện (ưu tiên dùng đúng tên chuẩn nếu khớp):\n"
        + "\n".join(hint_lines[:60])
        + "\n\n"
        if hint_lines
        else ""
    )

    processed = 0
    skipped_cached = 0
    used_slots: list[str] = []
    chapter_results: list[dict[str, Any]] = []

    for ch in chapters:
        ch_id = int(ch["id"])
        existing_json = ch["summary_json"]
        if not force_rerun and existing_json:
            try:
                cached = json.loads(existing_json)
                if isinstance(cached, dict) and "main_events" in cached:
                    skipped_cached += 1
                    chapter_results.append(
                        {
                            "chapter_id": ch_id,
                            "chapter_index": int(ch["chapter_index"]),
                            "title": str(ch["title"] or ""),
                            "cached": True,
                            "events_count": len(cached.get("main_events") or []),
                            "interactions_count": len(cached.get("dialogue_interactions") or []),
                        }
                    )
                    continue
            except (ValueError, TypeError):
                pass

        prompt = (
            f"Bộ truyện: {series_title} (Ngôn ngữ gốc: {source_lang.upper()})\n"
            f"Tập {vol_row['volume_number']} — Chương {ch['chapter_index']}: {ch['title']}\n\n"
            f"{hints_block}"
            f"Nội dung chương gốc:\n{ch['raw_text']}"
        )

        resp = active_pool.generate_content(
            prompt,
            system_instruction=_MAP_SYSTEM_PROMPT,
            temperature=0.2,
            response_mime_type="application/json",
            response_schema=ChapterMapSchema,
        )
        if resp.slot_id not in used_slots:
            used_slots.append(resp.slot_id)

        raw_obj = _parse_json_object(resp.text)
        validated = _coerce_map_result(raw_obj)
        serialized = validated.model_dump_json()

        with db_session(db_path) as conn:
            conn.execute(
                """
                UPDATE chapters
                SET summary_json = ?,
                    status = CASE WHEN status IN ('pending', 'failed') THEN 'summarized' ELSE status END,
                    used_slot = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (serialized, resp.slot_id, ch_id),
            )

        processed += 1
        chapter_results.append(
            {
                "chapter_id": ch_id,
                "chapter_index": int(ch["chapter_index"]),
                "title": str(ch["title"] or ""),
                "cached": False,
                "events_count": len(validated.main_events),
                "interactions_count": len(validated.dialogue_interactions),
            }
        )

    return {
        "volume_id": volume_id,
        "total_chapters": len(chapters),
        "processed_chapters": processed,
        "skipped_cached": skipped_cached,
        "used_slots": used_slots,
        "chapters": chapter_results,
    }


# ---------- 2. REDUCE & MERGE ----------

def run_reduce_and_merge(
    volume_id: int,
    *,
    skip_ai_summary: bool = False,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Reconcile MAP PHASE results in Python (characters, relationships, lock protection, symmetry check) + 1 compact AI summary call."""
    active_pool = pool or gemini_pool

    with db_session(db_path) as conn:
        vol_row = conn.execute(
            """
            SELECT v.id, v.series_id, v.volume_number, v.title, v.rtas_baseline,
                   s.title AS series_title, s.source_lang
            FROM volumes v
            JOIN series s ON s.id = v.series_id
            WHERE v.id = ?
            """,
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

        series_id = int(vol_row["series_id"])
        volume_number = int(vol_row["volume_number"])
        series_title = str(vol_row["series_title"])

        chapter_rows = conn.execute(
            """
            SELECT id, chapter_index, title, summary_json
            FROM chapters
            WHERE volume_id = ? AND summary_json IS NOT NULL AND TRIM(summary_json) != ''
            ORDER BY chapter_index ASC
            """,
            (volume_id,),
        ).fetchall()
        if not chapter_rows:
            raise ValueError(
                "Chưa có chương nào có dữ liệu MAP PHASE (summary_json). Hãy chạy MAP PHASE trước."
            )

        # Load approved glossary for character reconciliation
        glossary_rows = conn.execute(
            """
            SELECT source_term, normalized_key, vi_term, reading, term_type
            FROM glossary_terms
            WHERE series_id = ? AND status = 'approved'
            """,
            (series_id,),
        ).fetchall()
        glossary_by_key: dict[str, dict[str, Any]] = {}
        for g in glossary_rows:
            k_src = _norm_key(g["source_term"])
            glossary_by_key[k_src] = dict(g)
            if (g["vi_term"] or "").strip():
                glossary_by_key.setdefault(_norm_key(g["vi_term"]), dict(g))

        # Load existing series characters and build lookup map
        char_rows = conn.execute(
            "SELECT * FROM characters WHERE series_id = ? ORDER BY id ASC",
            (series_id,),
        ).fetchall()
        chars_by_id: dict[int, dict[str, Any]] = {}
        name_to_char_id: dict[str, int] = {}

        def _register_char_in_index(char_dict: dict[str, Any]) -> None:
            cid = int(char_dict["id"])
            chars_by_id[cid] = char_dict
            for cand in [
                char_dict["canonical_name"],
                char_dict["display_name"],
                *_load_existing_aliases(char_dict.get("aliases_json")),
            ]:
                nk = _norm_key(cand)
                if nk and nk not in name_to_char_id:
                    name_to_char_id[nk] = cid

        for cr in char_rows:
            _register_char_in_index(dict(cr))

        def _upsert_character(
            raw_name: str,
            display_hint: str = "",
            extra_aliases: list[str] | None = None,
        ) -> int:
            extra_aliases = extra_aliases or []
            candidates = [raw_name, display_hint, *extra_aliases]

            matched_id: int | None = None
            for cand in candidates:
                nk = _norm_key(cand)
                if nk and nk in name_to_char_id:
                    matched_id = name_to_char_id[nk]
                    break

            # Cross-check with approved glossary_terms
            gl_match = None
            for cand in candidates:
                nk = _norm_key(cand)
                if nk and nk in glossary_by_key:
                    gl_match = glossary_by_key[nk]
                    break

            if matched_id is not None:
                c = chars_by_id[matched_id]
                new_aliases = _merge_aliases(
                    _load_existing_aliases(c["aliases_json"]),
                    [raw_name, display_hint, *extra_aliases],
                    {c["canonical_name"], c["display_name"]},
                )
                new_aliases_json = json.dumps(new_aliases, ensure_ascii=False)
                if new_aliases_json != c["aliases_json"]:
                    conn.execute(
                        "UPDATE characters SET aliases_json = ? WHERE id = ?",
                        (new_aliases_json, matched_id),
                    )
                    c["aliases_json"] = new_aliases_json
                    _register_char_in_index(c)
                return matched_id

            canonical = (
                str(gl_match["source_term"]).strip()
                if gl_match and (gl_match.get("term_type") == "Character")
                else raw_name.strip()
            )
            display = (
                display_hint.strip()
                or (
                    str(gl_match["vi_term"]).strip()
                    if gl_match and (gl_match.get("vi_term") or "").strip()
                    else ""
                )
                or (
                    str(gl_match["reading"]).strip()
                    if gl_match and (gl_match.get("reading") or "").strip()
                    else ""
                )
                or canonical
            )
            aliases = _merge_aliases(
                [],
                [raw_name, display_hint, *extra_aliases],
                {canonical, display},
            )
            aliases_json = json.dumps(aliases, ensure_ascii=False)

            cur = conn.execute(
                """
                INSERT INTO characters (
                    series_id, canonical_name, display_name, aliases_json,
                    archetype, default_pair, rtas_baseline
                )
                VALUES (?, ?, ?, ?, 'NORMAL', 'Tôi-Cậu', 3.5)
                """,
                (series_id, canonical, display, aliases_json),
            )
            new_id = int(cur.lastrowid)
            new_dict = {
                "id": new_id,
                "series_id": series_id,
                "canonical_name": canonical,
                "display_name": display,
                "aliases_json": aliases_json,
                "archetype": "NORMAL",
                "default_pair": "Tôi-Cậu",
                "rtas_baseline": 3.5,
            }
            _register_char_in_index(new_dict)
            return new_id

        # Aggregate MAP data across all summarized chapters
        actual_char_ids: set[int] = set()
        mentioned_char_ids: set[int] = set()
        chapter_events_for_ai: list[str] = []
        all_interactions: list[DialogueInteractionEntry] = []

        for ch in chapter_rows:
            try:
                parsed = _coerce_map_result(json.loads(ch["summary_json"]))
            except Exception:
                continue

            if parsed.main_events:
                chapter_events_for_ai.append(
                    f"Chương {ch['chapter_index']} ({ch['title']}): "
                    + "; ".join(parsed.main_events)
                )

            for c_entry in parsed.characters_actual:
                cid = _upsert_character(c_entry.name, c_entry.display_name, c_entry.aliases)
                actual_char_ids.add(cid)

            for c_entry in parsed.characters_mentioned:
                cid = _upsert_character(c_entry.name, c_entry.display_name, c_entry.aliases)
                mentioned_char_ids.add(cid)

            all_interactions.extend(parsed.dialogue_interactions)

        # Upsert volume_character_states (ACTUAL takes precedence over MENTIONED)
        for cid in actual_char_ids:
            conn.execute(
                """
                INSERT INTO volume_character_states (volume_id, character_id, appearance)
                VALUES (?, ?, 'ACTUAL')
                ON CONFLICT(volume_id, character_id) DO UPDATE SET appearance = 'ACTUAL'
                """,
                (volume_id, cid),
            )
        for cid in mentioned_char_ids - actual_char_ids:
            conn.execute(
                """
                INSERT INTO volume_character_states (volume_id, character_id, appearance)
                VALUES (?, ?, 'MENTIONED')
                ON CONFLICT(volume_id, character_id) DO NOTHING
                """,
                (volume_id, cid),
            )

        # Merge dialogue interactions into relationships (respecting is_locked = 1!)
        relationships_added = 0
        relationships_updated = 0
        locked_preserved = 0
        active_pairs_in_vol: set[tuple[int, int]] = set()

        for inter in all_interactions:
            src_id = _upsert_character(inter.speaker)
            tgt_id = _upsert_character(inter.listener)
            if src_id == tgt_id:
                continue

            # Speakers/listeners in direct dialogue are ACTUAL in this volume
            for cid in (src_id, tgt_id):
                if cid not in actual_char_ids:
                    actual_char_ids.add(cid)
                    conn.execute(
                        """
                        INSERT INTO volume_character_states (volume_id, character_id, appearance)
                        VALUES (?, ?, 'ACTUAL')
                        ON CONFLICT(volume_id, character_id) DO UPDATE SET appearance = 'ACTUAL'
                        """,
                        (volume_id, cid),
                    )

            active_pairs_in_vol.add((src_id, tgt_id))

            raw_hint = ""
            if inter.self_pronoun_raw or inter.address_raw:
                raw_hint = f"[Raw: {inter.self_pronoun_raw or '?'} -> {inter.address_raw or '?'}]"
            note_combined = " ".join(p for p in [inter.emotion_note, raw_hint] if p).strip()

            existing_rel = conn.execute(
                """
                SELECT * FROM relationships
                WHERE series_id = ? AND source_char_id = ? AND target_char_id = ?
                """,
                (series_id, src_id, tgt_id),
            ).fetchone()

            if existing_rel is not None:
                if int(existing_rel["is_locked"]) == 1:
                    # NEVER overwrite locked relationships!
                    locked_preserved += 1
                    continue

                updates: list[str] = ["last_updated_vol = ?"]
                params: list[Any] = [volume_number]
                if not (existing_rel["pair_pronoun"] or "").strip() and inter.suggested_pair_vi:
                    updates.append("pair_pronoun = ?")
                    params.append(inter.suggested_pair_vi)
                    updates.append("needs_review = 1")
                if not (existing_rel["evidence_quote"] or "").strip() and inter.evidence_quote:
                    updates.append("evidence_quote = ?")
                    params.append(inter.evidence_quote)
                if (
                    not (existing_rel["notes"] or "").strip()
                    or str(existing_rel["notes"] or "").startswith(MISSING_REVERSE_PREFIX)
                ) and note_combined:
                    updates.append("notes = ?")
                    params.append(note_combined)
                params.append(int(existing_rel["id"]))
                conn.execute(
                    f"UPDATE relationships SET {', '.join(updates)} WHERE id = ?",
                    params,
                )
                relationships_updated += 1
            else:
                conn.execute(
                    """
                    INSERT INTO relationships (
                        series_id, source_char_id, target_char_id,
                        pair_pronoun, rtas_score, notes, evidence_quote,
                        needs_review, is_locked, last_updated_vol
                    )
                    VALUES (?, ?, ?, ?, 3.5, ?, ?, 1, 0, ?)
                    """,
                    (
                        series_id,
                        src_id,
                        tgt_id,
                        inter.suggested_pair_vi,
                        note_combined,
                        inter.evidence_quote,
                        volume_number,
                    ),
                )
                relationships_added += 1

        # Automatic Symmetry Check:
        # If A -> B exists and both A & B are ACTUAL in this volume, but B -> A does not exist yet,
        # create a draft B -> A with needs_review=1 and "Thiếu chiều ngược" warning.
        all_series_rels = conn.execute(
            "SELECT * FROM relationships WHERE series_id = ?",
            (series_id,),
        ).fetchall()
        existing_pair_set = {
            (int(r["source_char_id"]), int(r["target_char_id"])) for r in all_series_rels
        }
        missing_reverse_created = 0

        for rel in all_series_rels:
            a = int(rel["source_char_id"])
            b = int(rel["target_char_id"])
            if a == b:
                continue
            if a in actual_char_ids and b in actual_char_ids and (b, a) not in existing_pair_set:
                src_name = chars_by_id[a]["display_name"] if a in chars_by_id else str(a)
                tgt_name = chars_by_id[b]["display_name"] if b in chars_by_id else str(b)
                warning_note = (
                    f"{MISSING_REVERSE_PREFIX} Đã có chiều {src_name} → {tgt_name} "
                    f"({rel['pair_pronoun'] or 'chưa chốt'}), cần duyệt chiều ngược {tgt_name} → {src_name}."
                )
                conn.execute(
                    """
                    INSERT INTO relationships (
                        series_id, source_char_id, target_char_id,
                        pair_pronoun, rtas_score, notes, evidence_quote,
                        needs_review, is_locked, last_updated_vol
                    )
                    VALUES (?, ?, ?, '', ?, ?, ?, 1, 0, ?)
                    """,
                    (
                        series_id,
                        b,
                        a,
                        float(rel["rtas_score"] or 3.5),
                        warning_note,
                        str(rel["evidence_quote"] or ""),
                        volume_number,
                    ),
                )
                existing_pair_set.add((b, a))
                missing_reverse_created += 1

        # Prepare compact input for the single AI REDUCE call
        actual_names = [
            f"{chars_by_id[cid]['display_name']} ({chars_by_id[cid]['canonical_name']})"
            for cid in sorted(actual_char_ids)
            if cid in chars_by_id
        ]

    # Step C: Single compact AI request for volume_summary, rtas_analytics, sub_arc_state
    ai_used_slot: str | None = None
    volume_summary = ""
    rtas_current_avg = float(vol_row["rtas_baseline"] or 3.0)
    rtas_drift = ""
    sub_arc_updated = 0

    if not skip_ai_summary:
        reduce_prompt = (
            f"Bộ truyện: {series_title} — Tập {volume_number}: {vol_row['title']}\n"
            f"RTAS nền đầu tập: {vol_row['rtas_baseline']}\n\n"
            f"Nhân vật xuất hiện chính (ACTUAL): {', '.join(actual_names[:40])}\n\n"
            f"Diễn biến chính theo từng chương:\n"
            + "\n".join(chapter_events_for_ai)
        )
        resp = active_pool.generate_content(
            reduce_prompt,
            system_instruction=_REDUCE_SYSTEM_PROMPT,
            temperature=0.3,
            response_mime_type="application/json",
            response_schema=VolumeReduceSchema,
        )
        ai_used_slot = resp.slot_id
        raw_reduce = _parse_json_object(resp.text)
        reduce_obj = VolumeReduceSchema.model_validate(raw_reduce)
        volume_summary = reduce_obj.volume_summary.strip()
        rtas_current_avg = max(1.0, min(5.0, float(reduce_obj.rtas_current_avg)))
        rtas_drift = reduce_obj.rtas_drift.strip()

        with db_session(db_path) as conn:
            conn.execute(
                """
                UPDATE volumes
                SET volume_summary = ?,
                    rtas_current_avg = ?,
                    rtas_drift = ?,
                    status = 'continuity_done'
                WHERE id = ?
                """,
                (volume_summary, rtas_current_avg, rtas_drift, volume_id),
            )
            for item in reduce_obj.sub_arc_states:
                nk = _norm_key(item.character_name)
                cid = name_to_char_id.get(nk)
                if cid is None:
                    # Try partial display_name match for unique characters
                    for cand_id, c_info in chars_by_id.items():
                        if nk and (nk in _norm_key(c_info["display_name"]) or nk in _norm_key(c_info["canonical_name"])):
                            cid = cand_id
                            break
                if cid is not None:
                    conn.execute(
                        """
                        INSERT INTO volume_character_states (
                            volume_id, character_id, appearance, subarc, current_state, notes
                        )
                        VALUES (?, ?, 'ACTUAL', ?, ?, ?)
                        ON CONFLICT(volume_id, character_id) DO UPDATE SET
                            subarc = excluded.subarc,
                            current_state = excluded.current_state,
                            notes = excluded.notes
                        """,
                        (
                            volume_id,
                            cid,
                            item.subarc.strip(),
                            item.current_state.strip(),
                            item.notes.strip(),
                        ),
                    )
                    sub_arc_updated += 1
    else:
        with db_session(db_path) as conn:
            conn.execute(
                "UPDATE volumes SET status = 'continuity_done' WHERE id = ?",
                (volume_id,),
            )

    return {
        "volume_id": volume_id,
        "series_id": series_id,
        "chapters_reduced": len(chapter_rows),
        "actual_characters": len(actual_char_ids),
        "mentioned_characters": len(mentioned_char_ids - actual_char_ids),
        "relationships_added": relationships_added,
        "relationships_updated": relationships_updated,
        "locked_preserved": locked_preserved,
        "missing_reverse_created": missing_reverse_created,
        "sub_arc_updated": sub_arc_updated,
        "volume_summary": volume_summary,
        "rtas_current_avg": rtas_current_avg,
        "rtas_drift": rtas_drift,
        "used_slot": ai_used_slot,
    }


# ---------- 3. DETERMINISTIC XML BUILDER ----------

def render_continuity_xml(
    volume_id: int, db_path: Path | str | None = None
) -> tuple[str, str]:
    """Deterministically build vol{N}_continuity_pack.xml strictly from SQLite via ElementTree.

    Returns (filename, xml_string).
    """
    with db_session(db_path) as conn:
        vol_row = conn.execute(
            """
            SELECT v.*, s.title AS series_title, s.source_lang
            FROM volumes v
            JOIN series s ON s.id = v.series_id
            WHERE v.id = ?
            """,
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

        series_id = int(vol_row["series_id"])
        vol_num = int(vol_row["volume_number"])
        source_lang = str(vol_row["source_lang"])

        last_ch_row = conn.execute(
            "SELECT COALESCE(MAX(chapter_index), 0) AS last_ch FROM chapters WHERE volume_id = ?",
            (volume_id,),
        ).fetchone()
        last_chapter = int(last_ch_row["last_ch"])

        # Roster & Sub-Arc for this volume (join series characters with volume_character_states)
        char_rows = conn.execute(
            """
            SELECT c.*,
                   COALESCE(vcs.appearance, 'MENTIONED') AS appearance,
                   COALESCE(vcs.subarc, '') AS subarc,
                   COALESCE(vcs.current_state, '') AS current_state,
                   COALESCE(vcs.notes, '') AS state_notes,
                   CASE WHEN vcs.volume_id IS NOT NULL THEN 1 ELSE 0 END AS in_volume
            FROM characters c
            LEFT JOIN volume_character_states vcs
                ON vcs.character_id = c.id AND vcs.volume_id = ?
            WHERE c.series_id = ?
            ORDER BY
                CASE WHEN vcs.appearance = 'ACTUAL' THEN 0
                     WHEN vcs.appearance = 'MENTIONED' THEN 1
                     ELSE 2 END,
                c.id ASC
            """,
            (volume_id, series_id),
        ).fetchall()

        # Relationships for series (with display names)
        rel_rows = conn.execute(
            """
            SELECT r.*,
                   sc.display_name AS source_name,
                   tc.display_name AS target_name
            FROM relationships r
            JOIN characters sc ON sc.id = r.source_char_id
            JOIN characters tc ON tc.id = r.target_char_id
            WHERE r.series_id = ?
            ORDER BY r.is_locked DESC, r.id ASC
            """,
            (series_id,),
        ).fetchall()

        # ONLY approved glossary terms that appear in THIS volume (via volume_glossary_freq)
        glossary_rows = conn.execute(
            """
            SELECT g.source_term, g.vi_term, g.reading, g.han_viet, g.term_type, vgf.freq
            FROM glossary_terms g
            JOIN volume_glossary_freq vgf ON vgf.term_id = g.id
            WHERE g.series_id = ?
              AND vgf.volume_id = ?
              AND g.status = 'approved'
              AND TRIM(g.vi_term) != ''
            ORDER BY vgf.freq DESC, g.id ASC
            """,
            (series_id, volume_id),
        ).fetchall()

    root = ET.Element("CONTINUITY_DATA_PACK", {"version": "1.0"})

    # 1. META
    meta_el = ET.SubElement(root, "META")
    ET.SubElement(meta_el, "SERIES").text = str(vol_row["series_title"])
    ET.SubElement(meta_el, "VOLUME_END").text = str(vol_num)
    ET.SubElement(meta_el, "LAST_CHAPTER").text = str(last_chapter)

    # 2. SUB_ARC_STATE
    subarc_el = ET.SubElement(root, "SUB_ARC_STATE")
    for c in char_rows:
        if c["subarc"] or c["current_state"] or c["state_notes"]:
            ET.SubElement(
                subarc_el,
                "CHAR",
                {
                    "name": str(c["display_name"]),
                    "subarc": str(c["subarc"]),
                    "current_state": str(c["current_state"]),
                    "notes": str(c["state_notes"]),
                },
            )

    # 3. ROSTER
    roster_el = ET.SubElement(root, "ROSTER")
    for c in char_rows:
        aliases_list = _load_existing_aliases(c["aliases_json"])
        ET.SubElement(
            roster_el,
            "CHAR",
            {
                "name": str(c["canonical_name"]),
                "romaji": str(c["display_name"]),
                "aliases": "|".join(aliases_list),
                "archetype": str(c["archetype"] or "NORMAL"),
                "pair": str(c["default_pair"] or "Tôi-Cậu"),
                "rtas_baseline": f"{float(c['rtas_baseline'] or 3.5):.1f}",
                "appearance": str(c["appearance"]),
            },
        )

    # 4. RELATIONSHIPS
    rels_el = ET.SubElement(root, "RELATIONSHIPS")
    for r in rel_rows:
        if not (r["pair_pronoun"] or "").strip():
            continue
        ET.SubElement(
            rels_el,
            "PAIR",
            {
                "source": str(r["source_name"]),
                "target": str(r["target_name"]),
                "rtas": f"{float(r['rtas_score'] or 3.5):.1f}",
                "pair": str(r["pair_pronoun"]),
                "notes": str(r["notes"] or ""),
            },
        )

    # 5. GLOSSARY (strictly approved terms present in this volume)
    glossary_el = ET.SubElement(root, "GLOSSARY")
    for g in glossary_rows:
        if source_lang == "ja":
            attrs = {
                "jp": str(g["source_term"]),
                "vn": str(g["vi_term"]),
                "romaji": str(g["reading"] or ""),
                "type": str(g["term_type"] or "Concept"),
            }
        else:
            attrs = {
                "source": str(g["source_term"]),
                "vn": str(g["vi_term"]),
                "reading": str(g["reading"] or ""),
                "type": str(g["term_type"] or "Concept"),
            }
            if (g["han_viet"] or "").strip():
                attrs["han_viet"] = str(g["han_viet"])
        ET.SubElement(glossary_el, "TERM", attrs)

    # 6. RTAS_ANALYTICS
    rtas_el = ET.SubElement(root, "RTAS_ANALYTICS")
    ET.SubElement(rtas_el, "BASELINE").text = f"{float(vol_row['rtas_baseline'] or 3.0):.1f}"
    ET.SubElement(rtas_el, "CURRENT_AVG").text = f"{float(vol_row['rtas_current_avg'] or 3.0):.1f}"
    ET.SubElement(rtas_el, "DRIFT").text = str(vol_row["rtas_drift"] or "")

    # 7. VOLUME_SUMMARY
    summary_el = ET.SubElement(root, "VOLUME_SUMMARY")
    summary_el.text = str(vol_row["volume_summary"] or "")

    ET.indent(root, space="  ")
    xml_text = ET.tostring(root, encoding="unicode")
    filename = f"vol{vol_num}_continuity_pack.xml"
    return filename, xml_text


# ---------- 4. ALIAS INDEXER (SHARED-SURNAME-SAFE) & RELEVANT CONTEXT ----------

def _build_unambiguous_alias_index(
    characters: list[dict[str, Any]],
) -> tuple[dict[int, list[str]], list[str]]:
    """Build per-character search aliases while EXCLUDING any split name part shared by >= 2 characters.

    Fixes shared surname false positives (e.g., 'Greyrat' / 'グレイラット').
    Returns (char_id -> unambiguous_aliases, sorted_ignored_shared_parts).
    """
    raw_candidates_per_char: dict[int, set[str]] = {}
    owner_counts: dict[str, set[int]] = defaultdict(set)
    norm_to_original: dict[str, str] = {}

    for c in characters:
        cid = int(c["id"])
        full_names = [
            str(c.get("canonical_name") or "").strip(),
            str(c.get("display_name") or "").strip(),
            *_load_existing_aliases(c.get("aliases_json")),
        ]
        cands: set[str] = set()
        for name in full_names:
            if not name:
                continue
            cands.add(name)
            # Split by middle dot (・) or whitespace to auto-generate component aliases
            parts = [p.strip() for p in _NAME_PART_SPLIT_RE.split(name) if p.strip()]
            for part in parts:
                # Avoid tiny 1-char fragments from splits
                if len(part) >= 2:
                    cands.add(part)

        raw_candidates_per_char[cid] = cands
        for cand in cands:
            nk = _norm_key(cand)
            if not nk:
                continue
            owner_counts[nk].add(cid)
            norm_to_original.setdefault(nk, cand)

    # Identify all shared components owned by >= 2 distinct characters (e.g., family names)
    shared_norms = {nk for nk, owners in owner_counts.items() if len(owners) >= 2}
    ignored_shared = sorted(norm_to_original[nk] for nk in shared_norms)

    clean_index: dict[int, list[str]] = {}
    for cid, cands in raw_candidates_per_char.items():
        filtered = [
            cand
            for cand in cands
            if _norm_key(cand) not in shared_norms and len(cand.strip()) >= 2
        ]
        # Sort longest first for clean matching
        filtered.sort(key=lambda s: (-len(s), s))
        clean_index[cid] = filtered

    return clean_index, ignored_shared


def _alias_matches_text(alias: str, text_nfkc: str, text_lower: str) -> bool:
    alias_nfkc = unicodedata.normalize("NFKC", alias).strip()
    if not alias_nfkc:
        return False
    if _ASCII_WORD_RE.match(alias_nfkc):
        # Word-boundary match for Latin/Romaji names (case-insensitive)
        pattern = r"(?<![A-Za-z0-9])" + re.escape(alias_nfkc.lower()) + r"(?![A-Za-z0-9])"
        return re.search(pattern, text_lower) is not None
    return alias_nfkc in text_nfkc


def build_relevant_context(
    volume_id: int,
    chapter_text: str,
    *,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Filter Continuity Pack to ONLY characters, relationships, sub-arcs, and approved glossary relevant to `chapter_text`.

    Automatically ignores split name parts shared across >= 2 characters (e.g. 'Greyrat' / 'グレイラット').
    """
    text_nfkc = unicodedata.normalize("NFKC", chapter_text or "")
    text_lower = text_nfkc.lower()

    with db_session(db_path) as conn:
        vol_row = conn.execute(
            "SELECT id, series_id, volume_number FROM volumes WHERE id = ?",
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")
        series_id = int(vol_row["series_id"])

        char_rows = [
            dict(r)
            for r in conn.execute(
                """
                SELECT c.*,
                       COALESCE(vcs.appearance, 'MENTIONED') AS appearance,
                       COALESCE(vcs.subarc, '') AS subarc,
                       COALESCE(vcs.current_state, '') AS current_state,
                       COALESCE(vcs.notes, '') AS state_notes
                FROM characters c
                LEFT JOIN volume_character_states vcs
                    ON vcs.character_id = c.id AND vcs.volume_id = ?
                WHERE c.series_id = ?
                ORDER BY c.id ASC
                """,
                (volume_id, series_id),
            ).fetchall()
        ]

        rel_rows = [
            dict(r)
            for r in conn.execute(
                """
                SELECT r.*,
                       sc.display_name AS source_name,
                       tc.display_name AS target_name
                FROM relationships r
                JOIN characters sc ON sc.id = r.source_char_id
                JOIN characters tc ON tc.id = r.target_char_id
                WHERE r.series_id = ?
                """,
                (series_id,),
            ).fetchall()
        ]

        glossary_rows = [
            dict(r)
            for r in conn.execute(
                """
                SELECT id, source_term, vi_term, reading, han_viet, term_type
                FROM glossary_terms
                WHERE series_id = ? AND status = 'approved' AND TRIM(vi_term) != ''
                ORDER BY LENGTH(source_term) DESC, total_freq DESC
                """,
                (series_id,),
            ).fetchall()
        ]

    alias_index, ignored_shared_parts = _build_unambiguous_alias_index(char_rows)

    matched_chars: list[dict[str, Any]] = []
    matched_char_ids: set[int] = set()

    for c in char_rows:
        cid = int(c["id"])
        hits = [
            alias
            for alias in alias_index.get(cid, [])
            if _alias_matches_text(alias, text_nfkc, text_lower)
        ]
        if hits:
            matched_char_ids.add(cid)
            matched_chars.append(
                {
                    "id": cid,
                    "canonical_name": c["canonical_name"],
                    "display_name": c["display_name"],
                    "archetype": c["archetype"],
                    "default_pair": c["default_pair"],
                    "appearance": c["appearance"],
                    "subarc": c["subarc"],
                    "current_state": c["current_state"],
                    "state_notes": c["state_notes"],
                    "matched_aliases": hits,
                }
            )

    matched_rels = [
        {
            "id": int(r["id"]),
            "source_char_id": int(r["source_char_id"]),
            "target_char_id": int(r["target_char_id"]),
            "source_name": r["source_name"],
            "target_name": r["target_name"],
            "pair_pronoun": r["pair_pronoun"],
            "rtas_score": float(r["rtas_score"] or 3.5),
            "notes": r["notes"] or "",
            "is_locked": bool(r["is_locked"]),
        }
        for r in rel_rows
        if int(r["source_char_id"]) in matched_char_ids
        and int(r["target_char_id"]) in matched_char_ids
        and (r["pair_pronoun"] or "").strip()
    ]

    matched_terms = [
        {
            "id": int(g["id"]),
            "source_term": g["source_term"],
            "vi_term": g["vi_term"],
            "reading": g["reading"] or "",
            "han_viet": g["han_viet"] or "",
            "term_type": g["term_type"] or "Concept",
        }
        for g in glossary_rows
        if normalize_term_key(g["source_term"]) in text_nfkc
    ]

    return {
        "volume_id": volume_id,
        "matched_characters": matched_chars,
        "matched_relationships": matched_rels,
        "matched_glossary": matched_terms,
        "ignored_shared_parts": ignored_shared_parts,
    }


def get_continuity_status(
    volume_id: int, db_path: Path | str | None = None
) -> dict[str, Any]:
    """Return pipeline readiness & review queue counts for a volume."""
    with db_session(db_path) as conn:
        vol_row = conn.execute(
            """
            SELECT id, series_id, volume_number, title, volume_summary,
                   rtas_baseline, rtas_current_avg, rtas_drift, status
            FROM volumes
            WHERE id = ?
            """,
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

        series_id = int(vol_row["series_id"])
        ch_stats = conn.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN summary_json IS NOT NULL AND TRIM(summary_json) != '' THEN 1 ELSE 0 END) AS summarized
            FROM chapters
            WHERE volume_id = ?
            """,
            (volume_id,),
        ).fetchone()
        char_count = int(
            conn.execute(
                "SELECT COUNT(*) AS c FROM characters WHERE series_id = ?",
                (series_id,),
            ).fetchone()["c"]
        )
        rel_stats = conn.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS needs_review,
                   SUM(CASE WHEN is_locked = 1 THEN 1 ELSE 0 END) AS locked,
                   SUM(CASE WHEN notes LIKE ? THEN 1 ELSE 0 END) AS missing_reverse
            FROM relationships
            WHERE series_id = ?
            """,
            (f"{MISSING_REVERSE_PREFIX}%", series_id),
        ).fetchone()

    return {
        "volume_id": volume_id,
        "series_id": series_id,
        "volume_number": int(vol_row["volume_number"]),
        "status": str(vol_row["status"]),
        "total_chapters": int(ch_stats["total"] or 0),
        "summarized_chapters": int(ch_stats["summarized"] or 0),
        "characters_count": char_count,
        "relationships_total": int(rel_stats["total"] or 0),
        "relationships_needs_review": int(rel_stats["needs_review"] or 0),
        "relationships_locked": int(rel_stats["locked"] or 0),
        "relationships_missing_reverse": int(rel_stats["missing_reverse"] or 0),
        "volume_summary": str(vol_row["volume_summary"] or ""),
        "rtas_baseline": float(vol_row["rtas_baseline"] or 3.0),
        "rtas_current_avg": float(vol_row["rtas_current_avg"] or 3.0),
        "rtas_drift": str(vol_row["rtas_drift"] or ""),
    }
