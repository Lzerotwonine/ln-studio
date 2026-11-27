"""Master Glossary service: extraction, Gemini batch translation with 3-round reconciliation, TSV/CSV I/O, and deterministic XML export."""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import sqlite3
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Iterable

from app.core.database import db_session
from app.core.gemini_pool import GeminiPool, gemini_pool
from app.services.epub_service import decode_text_bytes
from app.services.languages import (
    VALID_TERM_TYPES,
    get_language_plugin,
    normalize_term_key,
)

logger = logging.getLogger(__name__)

VALID_GLOSSARY_STATUSES = ("new", "translated", "approved", "ignored")
_TERM_TYPE_LOOKUP = {t.lower(): t for t in VALID_TERM_TYPES}

_LANG_READING_LABEL = {
    "ja": "Romaji (Hepburn, chữ thường cho danh từ chung, viết hoa chữ cái đầu cho tên riêng)",
    "zh": "Pinyin (có dấu thanh hoặc không dấu chuẩn xác)",
    "ko": "Revised Romanization tiếng Hàn",
}

_GLOSSARY_SYSTEM_PROMPT = """Bạn là chuyên gia biên dịch thuật ngữ Light Novel / Web Novel sang tiếng Việt.
Nhiệm vụ: Dịch danh sách thuật ngữ gốc sang JSON chuẩn xác, nhất quán, không bỏ sót bất kỳ từ nào.

QUY TẮC BẮT BUỘC:
1. Chỉ trả về một mảng JSON hợp lệ (JSON array), KHÔNG thêm giải thích hay văn bản ngoài JSON.
2. Giữ NGUYÊN CHÍNH XÁC giá trị `source_term` như trong danh sách đầu vào, KHÔNG tự sửa hay gộp từ.
3. Mỗi phần tử bắt buộc có đủ 6 trường chuỗi (string):
   - "source_term": từ gốc y hệt đầu vào
   - "reading": phiên âm (Romaji cho JA / Pinyin cho ZH / Romanization cho KO)
   - "english_meaning": nghĩa tiếng Anh ngắn gọn
   - "han_viet": âm Hán-Việt (nếu có Hán tự/Kanji; để "" nếu là Katakana/thuần Hàn không có Hán tự)
   - "vi_term": bản dịch tiếng Việt tự nhiên, chuẩn văn phong truyện dịch
   - "term_type": MỘT trong các giá trị đúng chính tả sau:
     Character, Place, Skill, Item, Title, Organization, Race, Creature, Rank, Event, Concept, Language, Currency
4. Tuyệt đối KHÔNG bỏ sót bất kỳ thuật ngữ nào trong danh sách."""


def _normalize_term_type(raw: str | None) -> str:
    if not raw:
        return "Concept"
    return _TERM_TYPE_LOOKUP.get(raw.strip().lower(), "Concept")


def _extract_json_array(raw_text: str) -> list[dict[str, Any]]:
    """Parse a JSON array of glossary objects defensively from Gemini output."""
    text = (raw_text or "").strip()
    # Strip markdown code fences if present
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence_match:
        text = fence_match.group(1).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Fallback: locate outermost [...] block
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("Phản hồi từ Gemini không chứa mảng JSON hợp lệ.")
        parsed = json.loads(text[start : end + 1])

    if isinstance(parsed, dict):
        for key in ("terms", "items", "glossary", "data", "results"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break

    if not isinstance(parsed, list):
        raise ValueError("Phản hồi JSON từ Gemini không phải dạng danh sách (array).")

    return [item for item in parsed if isinstance(item, dict)]


def extract_volume_glossary(
    volume_id: int,
    *,
    min_freq: int = 1,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Extract terms from all chapters of a volume and reconcile against series Master Glossary."""
    with db_session(db_path) as conn:
        vol_row = conn.execute(
            """
            SELECT v.id, v.series_id, v.volume_number, v.status, s.source_lang
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
        source_lang = str(vol_row["source_lang"])

        chapter_rows = conn.execute(
            "SELECT raw_text FROM chapters WHERE volume_id = ? ORDER BY chapter_index ASC",
            (volume_id,),
        ).fetchall()
        if not chapter_rows:
            raise ValueError(
                "Tập này chưa có chương nào. Hãy nhập tệp .epub/.txt/.docx trước khi đếm từ."
            )

        raw_texts = [str(r["raw_text"]) for r in chapter_rows]

    plugin = get_language_plugin(source_lang)
    extracted = plugin.extract_terms(raw_texts, min_freq=max(1, min_freq))

    new_count = 0
    existing_count = 0

    with db_session(db_path) as conn:
        # Capture previously linked term_ids so we also recompute their total_freq if removed
        prev_term_ids = {
            int(r["term_id"])
            for r in conn.execute(
                "SELECT term_id FROM volume_glossary_freq WHERE volume_id = ?",
                (volume_id,),
            ).fetchall()
        }
        conn.execute("DELETE FROM volume_glossary_freq WHERE volume_id = ?", (volume_id,))

        affected_term_ids: set[int] = set(prev_term_ids)

        for item in extracted:
            row = conn.execute(
                """
                SELECT id, reading, first_seen_vol
                FROM glossary_terms
                WHERE series_id = ? AND normalized_key = ?
                """,
                (series_id, item.normalized_key),
            ).fetchone()

            if row is not None:
                term_id = int(row["id"])
                existing_count += 1
                # Fill reading if currently blank and update earliest seen volume
                new_first_vol = min(int(row["first_seen_vol"]), volume_number)
                if not (row["reading"] or "").strip() and item.reading:
                    conn.execute(
                        "UPDATE glossary_terms SET reading = ?, first_seen_vol = ? WHERE id = ?",
                        (item.reading, new_first_vol, term_id),
                    )
                elif new_first_vol != int(row["first_seen_vol"]):
                    conn.execute(
                        "UPDATE glossary_terms SET first_seen_vol = ? WHERE id = ?",
                        (new_first_vol, term_id),
                    )
            else:
                cur = conn.execute(
                    """
                    INSERT INTO glossary_terms (
                        series_id, source_term, normalized_key,
                        vi_term, reading, han_viet, english_meaning,
                        term_type, status, first_seen_vol, total_freq
                    )
                    VALUES (?, ?, ?, '', ?, '', '', ?, 'new', ?, ?)
                    """,
                    (
                        series_id,
                        item.source_term,
                        item.normalized_key,
                        item.reading,
                        _normalize_term_type(item.suggested_type),
                        volume_number,
                        item.freq,
                    ),
                )
                term_id = int(cur.lastrowid)
                new_count += 1

            conn.execute(
                """
                INSERT INTO volume_glossary_freq (volume_id, term_id, freq)
                VALUES (?, ?, ?)
                ON CONFLICT(volume_id, term_id) DO UPDATE SET freq = excluded.freq
                """,
                (volume_id, term_id, item.freq),
            )
            affected_term_ids.add(term_id)

        # Recompute exact total_freq from volume_glossary_freq (idempotent across re-runs)
        for tid in affected_term_ids:
            sum_row = conn.execute(
                "SELECT COALESCE(SUM(freq), 0) AS total FROM volume_glossary_freq WHERE term_id = ?",
                (tid,),
            ).fetchone()
            total = int(sum_row["total"])
            if total > 0:
                conn.execute(
                    "UPDATE glossary_terms SET total_freq = ? WHERE id = ?",
                    (total, tid),
                )

        if vol_row["status"] == "imported":
            conn.execute(
                "UPDATE volumes SET status = 'glossary_done' WHERE id = ?",
                (volume_id,),
            )

    return {
        "volume_id": volume_id,
        "series_id": series_id,
        "source_lang": source_lang,
        "total_extracted": len(extracted),
        "new_terms": new_count,
        "existing_terms": existing_count,
    }


def _build_translation_prompt(
    terms: list[dict[str, Any]],
    source_lang: str,
    series_title: str,
    round_num: int,
) -> str:
    reading_guide = _LANG_READING_LABEL.get(source_lang, "Phiên âm chuẩn")
    term_lines = [
        f'{idx}. "{t["source_term"]}" (freq={t["freq"]})'
        for idx, t in enumerate(terms, start=1)
    ]
    retry_note = (
        f"\n[Vòng bổ sung #{round_num}: Đây là các từ còn thiếu ở vòng trước, hãy dịch ĐỦ 100% từng từ.]\n"
        if round_num > 1
        else ""
    )
    return (
        f"Bộ truyện: {series_title}\n"
        f"Ngôn ngữ gốc: {source_lang.upper()} — Hướng dẫn trường `reading`: {reading_guide}\n"
        f"{retry_note}"
        f"Hãy dịch đủ {len(terms)} thuật ngữ sau sang mảng JSON gồm các object có 6 khóa "
        f"`source_term`, `reading`, `english_meaning`, `han_viet`, `vi_term`, `term_type`:\n\n"
        + "\n".join(term_lines)
    )


def _run_gemini_glossary_batches(
    terms_to_translate: list[dict[str, Any]],
    *,
    series_id: int,
    series_title: str,
    source_lang: str,
    volume_id: int | None = None,
    batch_size: int = 400,
    max_rounds: int = 3,
    only_status_new: bool = True,
    model_override: str | None = None,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Shared batched Gemini translation + multi-round reconciliation for glossary terms."""
    batch_size = max(1, min(500, int(batch_size)))
    max_rounds = max(1, min(5, int(max_rounds)))
    active_pool = pool or gemini_pool

    if not terms_to_translate:
        return {
            "series_id": series_id,
            "volume_id": volume_id,
            "total_new_found": 0,
            "translated_count": 0,
            "missing_count": 0,
            "missing_terms": [],
            "batches_processed": 0,
            "rounds_used": 0,
            "used_slots": [],
        }

    translated_count = 0
    missing_terms_all: list[str] = []
    used_slots: list[str] = []
    batches_processed = 0
    max_round_reached = 0
    status_guard = "AND status = 'new'" if only_status_new else ""

    for offset in range(0, len(terms_to_translate), batch_size):
        batch = terms_to_translate[offset : offset + batch_size]
        batches_processed += 1
        pending: dict[str, dict[str, Any]] = {t["normalized_key"]: t for t in batch}

        for round_num in range(1, max_rounds + 1):
            if not pending:
                break
            max_round_reached = max(max_round_reached, round_num)
            pending_list = list(pending.values())
            prompt = _build_translation_prompt(
                pending_list, source_lang, series_title, round_num
            )

            resp = active_pool.generate_content(
                prompt,
                system_instruction=_GLOSSARY_SYSTEM_PROMPT,
                temperature=0.2,
                task_type="glossary_translate",
                models=[model_override] if model_override and model_override.strip() else None,
            )
            if resp.slot_id not in used_slots:
                used_slots.append(resp.slot_id)

            try:
                items = _extract_json_array(resp.text)
            except Exception as exc:
                logger.warning(
                    "Glossary JSON parse failed on batch %d round %d: %s",
                    batches_processed,
                    round_num,
                    exc,
                )
                continue

            matched_updates: list[tuple[str, str, str, str, str, int]] = []
            for entry in items:
                raw_source = str(entry.get("source_term") or "").strip()
                norm = normalize_term_key(raw_source)
                if not norm or norm not in pending:
                    continue
                vi_term = str(entry.get("vi_term") or "").strip()
                if not vi_term:
                    continue
                reading = str(entry.get("reading") or "").strip()
                han_viet = str(entry.get("han_viet") or "").strip()
                english_meaning = str(entry.get("english_meaning") or "").strip()
                term_type = _normalize_term_type(str(entry.get("term_type") or ""))

                term_meta = pending.pop(norm)
                matched_updates.append(
                    (
                        vi_term,
                        reading,
                        han_viet,
                        english_meaning,
                        term_type,
                        int(term_meta["id"]),
                    )
                )

            if matched_updates:
                with db_session(db_path) as conn:
                    for vi_term, reading, han_viet, eng, t_type, term_id in matched_updates:
                        cur = conn.execute(
                            f"""
                            UPDATE glossary_terms
                            SET vi_term = ?,
                                reading = CASE WHEN ? != '' THEN ? ELSE reading END,
                                han_viet = ?,
                                english_meaning = ?,
                                term_type = ?,
                                status = 'translated'
                            WHERE id = ? {status_guard}
                            """,
                            (vi_term, reading, reading, han_viet, eng, t_type, term_id),
                        )
                        translated_count += cur.rowcount

        for leftover in pending.values():
            missing_terms_all.append(str(leftover["source_term"]))

    return {
        "series_id": series_id,
        "volume_id": volume_id,
        "total_new_found": len(terms_to_translate),
        "translated_count": translated_count,
        "missing_count": len(missing_terms_all),
        "missing_terms": missing_terms_all[:50],
        "batches_processed": batches_processed,
        "rounds_used": max_round_reached,
        "used_slots": used_slots,
    }


def translate_new_glossary_terms(
    series_id: int,
    *,
    volume_id: int | None = None,
    batch_size: int = 400,
    max_rounds: int = 3,
    model_override: str | None = None,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Translate only status='new' terms via Gemini Pool in 300-500 batches with up to 3 reconciliation rounds."""
    with db_session(db_path) as conn:
        series_row = conn.execute(
            "SELECT id, title, source_lang FROM series WHERE id = ?",
            (series_id,),
        ).fetchone()
        if series_row is None:
            raise LookupError("Không tìm thấy bộ truyện.")

        series_title = str(series_row["title"])
        source_lang = str(series_row["source_lang"])

        if volume_id is not None:
            rows = conn.execute(
                """
                SELECT g.id, g.source_term, g.normalized_key, vgf.freq AS freq
                FROM glossary_terms g
                INNER JOIN volume_glossary_freq vgf
                    ON vgf.term_id = g.id AND vgf.volume_id = ?
                WHERE g.series_id = ? AND vgf.freq > 0 AND g.status = 'new'
                ORDER BY vgf.freq DESC, g.id ASC
                """,
                (volume_id, series_id),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, source_term, normalized_key, total_freq AS freq
                FROM glossary_terms
                WHERE series_id = ? AND status = 'new'
                ORDER BY total_freq DESC, id ASC
                """,
                (series_id,),
            ).fetchall()

    return _run_gemini_glossary_batches(
        [dict(r) for r in rows],
        series_id=series_id,
        series_title=series_title,
        source_lang=source_lang,
        volume_id=volume_id,
        batch_size=batch_size,
        max_rounds=max_rounds,
        only_status_new=True,
        model_override=model_override,
        pool=pool,
        db_path=db_path,
    )


def _chunked(items: list[int], size: int = 500) -> Iterable[list[int]]:
    for idx in range(0, len(items), size):
        yield items[idx : idx + size]


def _build_glossary_query_parts(
    conn: sqlite3.Connection,
    series_id: int,
    *,
    volume_id: int | None = None,
    status_filter: str | None = None,
    term_type: str | None = None,
    min_freq: int | None = None,
    max_freq: int | None = None,
    missing_vi: bool = False,
    missing_han_viet: bool = False,
    first_seen_vol: int | None = None,
    search: str | None = None,
    exclude_ids: Iterable[int] | None = None,
) -> dict[str, Any]:
    """Build strict SQL scope (INNER JOIN volume_glossary_freq when volume_id given) + filters."""
    series = conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone()
    if series is None:
        raise LookupError("Không tìm thấy bộ truyện.")

    if volume_id is not None:
        vol = conn.execute(
            "SELECT id FROM volumes WHERE id = ? AND series_id = ?",
            (volume_id, series_id),
        ).fetchone()
        if vol is None:
            raise LookupError("Không tìm thấy tập truyện thuộc bộ truyện này.")
        base_from = (
            "FROM glossary_terms g "
            "INNER JOIN volume_glossary_freq vgf "
            "ON vgf.term_id = g.id AND vgf.volume_id = ?"
        )
        scope_where = "g.series_id = ? AND vgf.freq > 0"
        scope_params: list[Any] = [volume_id, series_id]
        freq_col = "vgf.freq"
        select_extra = ", vgf.freq AS volume_freq"
    else:
        base_from = "FROM glossary_terms g"
        scope_where = "g.series_id = ?"
        scope_params = [series_id]
        freq_col = "g.total_freq"
        select_extra = ", NULL AS volume_freq"

    where_clauses = [scope_where]
    params = list(scope_params)

    if status_filter and status_filter in VALID_GLOSSARY_STATUSES:
        where_clauses.append("g.status = ?")
        params.append(status_filter)
    if term_type:
        where_clauses.append("g.term_type = ?")
        params.append(term_type)
    if min_freq is not None and min_freq > 1:
        where_clauses.append(f"{freq_col} >= ?")
        params.append(int(min_freq))
    if max_freq is not None and max_freq >= 1:
        where_clauses.append(f"{freq_col} <= ?")
        params.append(int(max_freq))
    if missing_vi:
        where_clauses.append("TRIM(COALESCE(g.vi_term, '')) = ''")
    if missing_han_viet:
        where_clauses.append("TRIM(COALESCE(g.han_viet, '')) = ''")
    if first_seen_vol is not None:
        where_clauses.append("g.first_seen_vol = ?")
        params.append(int(first_seen_vol))
    if search and search.strip():
        like = f"%{search.strip()}%"
        where_clauses.append(
            "(g.source_term LIKE ? OR g.vi_term LIKE ? OR g.reading LIKE ? "
            "OR g.han_viet LIKE ? OR g.english_meaning LIKE ?)"
        )
        params.extend([like, like, like, like, like])

    excl = sorted({int(i) for i in (exclude_ids or [])})
    if excl and len(excl) <= 400:
        ph = ",".join("?" for _ in excl)
        where_clauses.append(f"g.id NOT IN ({ph})")
        params.extend(excl)

    return {
        "base_from": base_from,
        "scope_where": scope_where,
        "scope_params": scope_params,
        "where_sql": " AND ".join(where_clauses),
        "params": params,
        "freq_col": freq_col,
        "select_extra": select_extra,
        "extra_exclude_set": set(excl) if len(excl) > 400 else set(),
    }


def _resolve_target_term_ids(
    conn: sqlite3.Connection,
    *,
    series_id: int | None = None,
    term_ids: Iterable[int] = (),
    apply_to_filter: bool = False,
    filter_criteria: dict[str, Any] | None = None,
    exclude_ids: Iterable[int] = (),
) -> list[int]:
    """Resolve term IDs from either explicit IDs or an active filter specification."""
    excl_set = {int(i) for i in exclude_ids}
    if apply_to_filter:
        if series_id is None:
            raise ValueError("Cần chỉ định series_id khi áp dụng thao tác hàng loạt theo bộ lọc.")
        fc = filter_criteria or {}
        parts = _build_glossary_query_parts(
            conn,
            series_id,
            volume_id=fc.get("volume_id"),
            status_filter=fc.get("status"),
            term_type=fc.get("term_type"),
            min_freq=fc.get("min_freq"),
            max_freq=fc.get("max_freq"),
            missing_vi=bool(fc.get("missing_vi", False)),
            missing_han_viet=bool(fc.get("missing_han_viet", False)),
            first_seen_vol=fc.get("first_seen_vol"),
            search=fc.get("search"),
            exclude_ids=excl_set,
        )
        rows = conn.execute(
            f"SELECT g.id {parts['base_from']} WHERE {parts['where_sql']} ORDER BY {parts['freq_col']} DESC, g.id ASC",
            parts["params"],
        ).fetchall()
        extra_excl: set[int] = parts["extra_exclude_set"]
        return [int(r["id"]) for r in rows if int(r["id"]) not in extra_excl]

    unique_ids: list[int] = []
    seen: set[int] = set()
    for raw_id in term_ids:
        tid = int(raw_id)
        if tid in excl_set or tid in seen:
            continue
        seen.add(tid)
        unique_ids.append(tid)

    if series_id is not None and unique_ids:
        scoped: list[int] = []
        for chunk in _chunked(unique_ids, 500):
            ph = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT id FROM glossary_terms WHERE series_id = ? AND id IN ({ph})",
                [series_id, *chunk],
            ).fetchall()
            scoped.extend(int(r["id"]) for r in rows)
        return scoped

    return unique_ids


def bulk_update_glossary_status_service(
    status: str,
    *,
    series_id: int | None = None,
    term_ids: Iterable[int] = (),
    apply_to_filter: bool = False,
    filter_criteria: dict[str, Any] | None = None,
    exclude_ids: Iterable[int] = (),
    db_path: Path | str | None = None,
) -> int:
    if status not in VALID_GLOSSARY_STATUSES:
        raise ValueError(f"Trạng thái không hợp lệ: {status}")
    updated = 0
    with db_session(db_path) as conn:
        ids = _resolve_target_term_ids(
            conn,
            series_id=series_id,
            term_ids=term_ids,
            apply_to_filter=apply_to_filter,
            filter_criteria=filter_criteria,
            exclude_ids=exclude_ids,
        )
        for chunk in _chunked(ids, 500):
            ph = ",".join("?" for _ in chunk)
            cur = conn.execute(
                f"UPDATE glossary_terms SET status = ? WHERE id IN ({ph})",
                [status, *chunk],
            )
            updated += cur.rowcount
    return updated


def bulk_update_glossary_type_service(
    term_type: str,
    *,
    series_id: int | None = None,
    term_ids: Iterable[int] = (),
    apply_to_filter: bool = False,
    filter_criteria: dict[str, Any] | None = None,
    exclude_ids: Iterable[int] = (),
    db_path: Path | str | None = None,
) -> int:
    normalized_type = _normalize_term_type(term_type)
    updated = 0
    with db_session(db_path) as conn:
        ids = _resolve_target_term_ids(
            conn,
            series_id=series_id,
            term_ids=term_ids,
            apply_to_filter=apply_to_filter,
            filter_criteria=filter_criteria,
            exclude_ids=exclude_ids,
        )
        for chunk in _chunked(ids, 500):
            ph = ",".join("?" for _ in chunk)
            cur = conn.execute(
                f"UPDATE glossary_terms SET term_type = ? WHERE id IN ({ph})",
                [normalized_type, *chunk],
            )
            updated += cur.rowcount
    return updated


def bulk_delete_glossary_terms_service(
    *,
    series_id: int | None = None,
    term_ids: Iterable[int] = (),
    apply_to_filter: bool = False,
    filter_criteria: dict[str, Any] | None = None,
    exclude_ids: Iterable[int] = (),
    db_path: Path | str | None = None,
) -> int:
    deleted = 0
    with db_session(db_path) as conn:
        ids = _resolve_target_term_ids(
            conn,
            series_id=series_id,
            term_ids=term_ids,
            apply_to_filter=apply_to_filter,
            filter_criteria=filter_criteria,
            exclude_ids=exclude_ids,
        )
        for chunk in _chunked(ids, 500):
            ph = ",".join("?" for _ in chunk)
            cur = conn.execute(
                f"DELETE FROM glossary_terms WHERE id IN ({ph})",
                chunk,
            )
            deleted += cur.rowcount
    return deleted


def translate_selected_glossary_terms(
    series_id: int,
    *,
    term_ids: Iterable[int] = (),
    apply_to_filter: bool = False,
    filter_criteria: dict[str, Any] | None = None,
    exclude_ids: Iterable[int] = (),
    batch_size: int = 400,
    max_rounds: int = 3,
    model_override: str | None = None,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Re-translate ONLY the explicitly selected (or filter-matched) terms via Gemini Pool."""
    with db_session(db_path) as conn:
        series_row = conn.execute(
            "SELECT id, title, source_lang FROM series WHERE id = ?",
            (series_id,),
        ).fetchone()
        if series_row is None:
            raise LookupError("Không tìm thấy bộ truyện.")

        series_title = str(series_row["title"])
        source_lang = str(series_row["source_lang"])

        target_ids = _resolve_target_term_ids(
            conn,
            series_id=series_id,
            term_ids=term_ids,
            apply_to_filter=apply_to_filter,
            filter_criteria=filter_criteria,
            exclude_ids=exclude_ids,
        )

        rows: list[dict[str, Any]] = []
        for chunk in _chunked(target_ids, 500):
            ph = ",".join("?" for _ in chunk)
            fetched = conn.execute(
                f"""
                SELECT id, source_term, normalized_key, total_freq AS freq
                FROM glossary_terms
                WHERE series_id = ? AND id IN ({ph})
                ORDER BY total_freq DESC, id ASC
                """,
                [series_id, *chunk],
            ).fetchall()
            rows.extend(dict(r) for r in fetched)

    vol_id = (filter_criteria or {}).get("volume_id") if apply_to_filter else None
    return _run_gemini_glossary_batches(
        rows,
        series_id=series_id,
        series_title=series_title,
        source_lang=source_lang,
        volume_id=vol_id,
        batch_size=batch_size,
        max_rounds=max_rounds,
        only_status_new=False,
        model_override=model_override,
        pool=pool,
        db_path=db_path,
    )


def list_glossary_terms(
    series_id: int,
    *,
    volume_id: int | None = None,
    status_filter: str | None = None,
    term_type: str | None = None,
    min_freq: int | None = None,
    max_freq: int | None = None,
    missing_vi: bool = False,
    missing_han_viet: bool = False,
    first_seen_vol: int | None = None,
    search: str | None = None,
    sort_by: str = "freq",
    sort_dir: str = "desc",
    limit: int | None = 100,
    offset: int = 0,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Query glossary terms for a series or specific volume with pagination, sorting, and advanced filters."""
    with db_session(db_path) as conn:
        parts = _build_glossary_query_parts(
            conn,
            series_id,
            volume_id=volume_id,
            status_filter=status_filter,
            term_type=term_type,
            min_freq=min_freq,
            max_freq=max_freq,
            missing_vi=missing_vi,
            missing_han_viet=missing_han_viet,
            first_seen_vol=first_seen_vol,
            search=search,
        )

        # Status counts within the current scope (series or volume) before status/search filters
        count_rows = conn.execute(
            f"""
            SELECT g.status, COUNT(*) AS cnt
            {parts['base_from']}
            WHERE {parts['scope_where']}
            GROUP BY g.status
            """,
            parts["scope_params"],
        ).fetchall()
        status_counts = {s: 0 for s in VALID_GLOSSARY_STATUSES}
        for r in count_rows:
            if r["status"] in status_counts:
                status_counts[r["status"]] = int(r["cnt"])
        total_in_scope = sum(status_counts.values())

        distinct_vol_rows = conn.execute(
            f"""
            SELECT DISTINCT g.first_seen_vol
            {parts['base_from']}
            WHERE {parts['scope_where']}
            ORDER BY g.first_seen_vol ASC
            """,
            parts["scope_params"],
        ).fetchall()
        distinct_first_seen_vols = [int(r["first_seen_vol"]) for r in distinct_vol_rows]

        filtered_total = int(
            conn.execute(
                f"SELECT COUNT(*) AS cnt {parts['base_from']} WHERE {parts['where_sql']}",
                parts["params"],
            ).fetchone()["cnt"]
        )

        sort_column_map = {
            "source_term": "g.source_term COLLATE NOCASE",
            "vi_term": "g.vi_term COLLATE NOCASE",
            "freq": parts["freq_col"],
            "first_seen_vol": "g.first_seen_vol",
            "term_type": "g.term_type COLLATE NOCASE",
            "status": "g.status",
        }
        order_col = sort_column_map.get(sort_by, parts["freq_col"])
        order_dir = "ASC" if str(sort_dir).lower() == "asc" else "DESC"
        order_sql = f"ORDER BY {order_col} {order_dir}, g.id ASC"

        if limit is None or int(limit) <= 0:
            rows = conn.execute(
                f"""
                SELECT g.*{parts['select_extra']}
                {parts['base_from']}
                WHERE {parts['where_sql']}
                {order_sql}
                """,
                parts["params"],
            ).fetchall()
        else:
            rows = conn.execute(
                f"""
                SELECT g.*{parts['select_extra']}
                {parts['base_from']}
                WHERE {parts['where_sql']}
                {order_sql}
                LIMIT ? OFFSET ?
                """,
                [*parts["params"], int(limit), max(0, int(offset))],
            ).fetchall()

    items = [dict(r) for r in rows]
    return {
        "items": items,
        "total_count": filtered_total,
        "total_filtered": filtered_total,
        "total_in_scope": total_in_scope,
        "status_counts": status_counts,
        "distinct_first_seen_vols": distinct_first_seen_vols,
    }


_HEADER_SEP_RE = re.compile(r"[-_/()\[\]:.,;]+")
_MULTI_SPACE_RE = re.compile(r"\s+")

GLOSSARY_IMPORT_FIELDS: tuple[str, ...] = (
    "source_term",
    "vi_term",
    "reading",
    "han_viet",
    "english_meaning",
    "term_type",
    "status",
    "total_freq",
    "first_seen_vol",
)


def _normalize_header_name(raw_header: str) -> str:
    """Normalize header name: strip BOM, lowercase, đ->d, NFD remove diacritics, replace separators with spaces."""
    s = (raw_header or "").strip().lstrip("\ufeff").lower()
    s = s.replace("đ", "d")
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = _HEADER_SEP_RE.sub(" ", s)
    return _MULTI_SPACE_RE.sub(" ", s).strip()


def _detect_column_map(headers: list[str]) -> dict[str, int]:
    """Map normalized TSV/CSV headers to Master Glossary fields (handles Vietnamese diacritics & real Excel labels)."""
    # Exact normalized aliases (checked first; order prioritizes specific fields like han_viet before reading)
    exact_aliases: list[tuple[str, set[str]]] = [
        (
            "han_viet",
            {
                "han viet",
                "hanviet",
                "phien am han viet",
                "am han viet",
                "hv",
                "sino vietnamese",
                "sino viet",
            },
        ),
        (
            "english_meaning",
            {
                "english meaning",
                "english",
                "en",
                "meaning",
                "tieng anh",
                "nghia anh",
                "nghia tieng anh",
                "tieng anh goc tuong duong",
                "tieng anh goc",
                "nghia tieng anh goc tuong duong",
            },
        ),
        (
            "source_term",
            {
                "source term",
                "source",
                "jp",
                "ja",
                "zh",
                "ko",
                "term",
                "original",
                "raw",
                "word",
                "tu goc",
                "tu goc tieng nhat",
                "tu goc tieng trung",
                "tu goc tieng han",
                "tieng nhat",
                "tieng trung",
                "tieng han",
                "thuat ngu",
                "thuat ngu goc",
                "tu vung",
                "tu vung goc",
                "goc",
            },
        ),
        (
            "vi_term",
            {
                "vi term",
                "vn",
                "vi",
                "vietnamese",
                "translation",
                "dich nghia",
                "dich",
                "tieng viet",
                "ban dich",
                "ban dich viet",
                "ban dich tieng viet",
                "nghia viet",
                "nghia tieng viet",
                "nghia",
            },
        ),
        (
            "reading",
            {
                "reading",
                "romaji",
                "pinyin",
                "romanization",
                "kana",
                "furigana",
                "phien am",
                "cach doc",
                "phien am romaji",
                "phien am pinyin",
            },
        ),
        (
            "term_type",
            {
                "term type",
                "type",
                "category",
                "loai",
                "phan loai",
                "nhom",
            },
        ),
        (
            "status",
            {
                "status",
                "trang thai",
            },
        ),
        (
            "total_freq",
            {
                "total freq",
                "freq",
                "frequency",
                "count",
                "tan suat",
                "so lan",
                "so lan xuat hien",
            },
        ),
        (
            "first_seen_vol",
            {
                "first seen vol",
                "first vol",
                "vol",
                "volume",
                "tap",
                "tap dau",
                "tap goc",
            },
        ),
    ]

    # Ordered substring fallbacks for verbose Excel headers like "Tiếng Anh (Gốc/Tương đương)" or "Phiên âm Hán-Việt (nếu có)"
    phrase_fallbacks: list[tuple[str, tuple[str, ...]]] = [
        ("han_viet", ("han viet", "hanviet")),
        ("english_meaning", ("tieng anh", "nghia anh", "english")),
        ("source_term", ("tu goc", "tieng nhat", "tieng trung", "tieng han", "source term")),
        ("vi_term", ("dich nghia", "ban dich", "tieng viet", "nghia viet", "vietnamese")),
        ("reading", ("phien am", "romaji", "pinyin", "furigana", "romanization")),
        ("term_type", ("phan loai", "term type")),
        ("status", ("trang thai", "status")),
        ("total_freq", ("tan suat", "frequency")),
        ("first_seen_vol", ("first seen", "tap dau", "tap goc")),
    ]

    norm_headers = [_normalize_header_name(h) for h in headers]
    col_map: dict[str, int] = {}
    used_indices: set[int] = set()

    # Pass 1: exact alias matches
    for field, names in exact_aliases:
        if field in col_map:
            continue
        for idx, h in enumerate(norm_headers):
            if idx in used_indices or not h:
                continue
            if h in names:
                col_map[field] = idx
                used_indices.add(idx)
                break

    # Pass 2: phrase substring fallbacks
    for field, phrases in phrase_fallbacks:
        if field in col_map:
            continue
        for idx, h in enumerate(norm_headers):
            if idx in used_indices or not h:
                continue
            if any(p in h for p in phrases):
                col_map[field] = idx
                used_indices.add(idx)
                break

    return col_map


def _parse_tabular_rows(filename: str, file_bytes: bytes) -> tuple[str, list[list[str]]]:
    text = decode_text_bytes(file_bytes).lstrip("\ufeff")
    if not text.strip():
        raise ValueError("Tệp TSV/CSV rỗng.")

    first_line = text.splitlines()[0]
    ext = Path(filename).suffix.lower()
    if ext == ".tsv" or ("\t" in first_line and first_line.count("\t") >= first_line.count(",")):
        delimiter = "\t"
    else:
        delimiter = ","

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [r for r in reader if r and any(c.strip() for c in r)]
    if not rows:
        raise ValueError("Tệp không có dữ liệu.")
    return delimiter, rows


def preview_glossary_tabular(filename: str, file_bytes: bytes) -> dict[str, Any]:
    """Parse TSV/CSV header, auto-suggest column mapping, and return up to 3 sample rows for UI confirmation."""
    delimiter, rows = _parse_tabular_rows(filename, file_bytes)
    raw_first = rows[0]
    detected = _detect_column_map(raw_first)
    has_header = "source_term" in detected or len(detected) >= 2

    if has_header:
        headers = [c.strip().lstrip("\ufeff") or f"Cột {i + 1}" for i, c in enumerate(raw_first)]
        data_rows = rows[1:]
        col_map = detected
    else:
        col_count = max(len(r) for r in rows[:5])
        headers = [f"Cột {i + 1}" for i in range(col_count)]
        data_rows = rows
        col_map = {
            "source_term": 0 if col_count > 0 else None,
            "vi_term": 1 if col_count > 1 else None,
            "reading": 2 if col_count > 2 else None,
            "term_type": 3 if col_count > 3 else None,
        }

    suggested_mapping: dict[str, int | None] = {
        field: col_map.get(field) for field in GLOSSARY_IMPORT_FIELDS
    }
    sample_rows = [
        [c.strip() for c in r[: len(headers)]] + [""] * max(0, len(headers) - len(r))
        for r in data_rows[:3]
    ]
    return {
        "filename": filename,
        "delimiter": delimiter,
        "has_header": has_header,
        "headers": headers,
        "suggested_mapping": suggested_mapping,
        "sample_rows": sample_rows,
        "total_rows": len(data_rows),
    }


def import_glossary_tabular(
    series_id: int,
    filename: str,
    file_bytes: bytes,
    *,
    default_status: str = "approved",
    duplicate_mode: str = "upsert",
    default_first_seen_vol: int = 0,
    force_default_status: bool = True,
    column_mapping: dict[str, int | None] | None = None,
    has_header: bool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, int]:
    """Import TSV or CSV glossary file (including 2-step historical Excel sync & custom column mapping) into Master DB."""
    if default_status not in VALID_GLOSSARY_STATUSES:
        default_status = "approved"
    if duplicate_mode not in ("skip", "upsert"):
        duplicate_mode = "upsert"
    fallback_vol = max(0, int(default_first_seen_vol))

    _delimiter, rows = _parse_tabular_rows(filename, file_bytes)

    auto_map = _detect_column_map(rows[0])
    auto_has_header = "source_term" in auto_map or len(auto_map) >= 2
    effective_has_header = auto_has_header if has_header is None else bool(has_header)

    if column_mapping is not None:
        col_map: dict[str, int] = {}
        for field in GLOSSARY_IMPORT_FIELDS:
            raw_idx = column_mapping.get(field)
            if raw_idx is not None and isinstance(raw_idx, int) and raw_idx >= 0:
                col_map[field] = raw_idx
        if "source_term" not in col_map:
            raise ValueError("Cần ánh xạ ít nhất cột 'Từ gốc (source_term)' trước khi nhập.")
        data_rows = rows[1:] if effective_has_header else rows
    elif effective_has_header and "source_term" in auto_map:
        col_map = auto_map
        data_rows = rows[1:]
    else:
        # Headerless fallback: col 0 = source_term, col 1 = vi_term, col 2 = reading, col 3 = term_type
        col_map = {"source_term": 0, "vi_term": 1, "reading": 2, "term_type": 3}
        data_rows = rows[1:] if effective_has_header else rows

    def _cell(row: list[str], field: str) -> str:
        idx = col_map.get(field)
        if idx is None or idx >= len(row):
            return ""
        return row[idx].strip()

    imported = 0
    updated = 0
    skipped = 0

    with db_session(db_path) as conn:
        if conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone() is None:
            raise LookupError("Không tìm thấy bộ truyện.")

        for row in data_rows:
            if not row or not any(c.strip() for c in row):
                continue
            source_term = _cell(row, "source_term")
            norm = normalize_term_key(source_term)
            if not norm:
                skipped += 1
                continue

            vi_term = _cell(row, "vi_term")
            reading = _cell(row, "reading")
            han_viet = _cell(row, "han_viet")
            english_meaning = _cell(row, "english_meaning")
            raw_type = _cell(row, "term_type")
            term_type = _normalize_term_type(raw_type)
            raw_status = _cell(row, "status").lower()

            if force_default_status:
                row_status = default_status
            elif raw_status in VALID_GLOSSARY_STATUSES:
                row_status = raw_status
            elif default_status == "ignored":
                row_status = "ignored"
            else:
                row_status = default_status if vi_term else "new"

            try:
                freq = max(1, int(_cell(row, "total_freq") or 1))
            except ValueError:
                freq = 1

            raw_vol_cell = _cell(row, "first_seen_vol")
            if raw_vol_cell != "":
                try:
                    first_vol = max(0, int(raw_vol_cell))
                except ValueError:
                    first_vol = fallback_vol
            else:
                first_vol = fallback_vol

            existing = conn.execute(
                "SELECT id, first_seen_vol FROM glossary_terms WHERE series_id = ? AND normalized_key = ?",
                (series_id, norm),
            ).fetchone()

            if existing is not None:
                if duplicate_mode == "skip":
                    skipped += 1
                    continue
                next_first_vol = min(int(existing["first_seen_vol"]), first_vol)
                conn.execute(
                    """
                    UPDATE glossary_terms
                    SET vi_term = CASE WHEN ? != '' THEN ? ELSE vi_term END,
                        reading = CASE WHEN ? != '' THEN ? ELSE reading END,
                        han_viet = CASE WHEN ? != '' THEN ? ELSE han_viet END,
                        english_meaning = CASE WHEN ? != '' THEN ? ELSE english_meaning END,
                        term_type = CASE WHEN ? != '' THEN ? ELSE term_type END,
                        status = ?,
                        first_seen_vol = ?
                    WHERE id = ?
                    """,
                    (
                        vi_term,
                        vi_term,
                        reading,
                        reading,
                        han_viet,
                        han_viet,
                        english_meaning,
                        english_meaning,
                        raw_type,
                        term_type,
                        row_status,
                        next_first_vol,
                        int(existing["id"]),
                    ),
                )
                updated += 1
            else:
                conn.execute(
                    """
                    INSERT INTO glossary_terms (
                        series_id, source_term, normalized_key,
                        vi_term, reading, han_viet, english_meaning,
                        term_type, status, first_seen_vol, total_freq
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        series_id,
                        source_term,
                        norm,
                        vi_term,
                        reading,
                        han_viet,
                        english_meaning,
                        term_type,
                        row_status,
                        first_vol,
                        freq,
                    ),
                )
                imported += 1

    return {"imported": imported, "updated": updated, "skipped": skipped}


def export_glossary_tabular(
    series_id: int,
    *,
    fmt: str = "tsv",
    volume_id: int | None = None,
    status_filter: str | None = None,
    term_type: str | None = None,
    min_freq: int | None = None,
    max_freq: int | None = None,
    missing_vi: bool = False,
    missing_han_viet: bool = False,
    first_seen_vol: int | None = None,
    search: str | None = None,
    db_path: Path | str | None = None,
) -> tuple[str, str]:
    """Export all matching glossary terms (uncapped) to UTF-8-BOM TSV or CSV string."""
    data = list_glossary_terms(
        series_id,
        volume_id=volume_id,
        status_filter=status_filter,
        term_type=term_type,
        min_freq=min_freq,
        max_freq=max_freq,
        missing_vi=missing_vi,
        missing_han_viet=missing_han_viet,
        first_seen_vol=first_seen_vol,
        search=search,
        limit=0,
        db_path=db_path,
    )
    delimiter = "\t" if fmt.lower() == "tsv" else ","
    media_type = (
        "text/tab-separated-values; charset=utf-8"
        if fmt.lower() == "tsv"
        else "text/csv; charset=utf-8"
    )

    buf = io.StringIO()
    buf.write("\ufeff")  # UTF-8 BOM for Microsoft Excel compatibility
    writer = csv.writer(buf, delimiter=delimiter, lineterminator="\n")
    writer.writerow(
        [
            "source_term",
            "vi_term",
            "reading",
            "han_viet",
            "english_meaning",
            "term_type",
            "status",
            "freq",
            "first_seen_vol",
        ]
    )
    for item in data["items"]:
        freq_val = item["volume_freq"] if item["volume_freq"] is not None else item["total_freq"]
        writer.writerow(
            [
                item["source_term"],
                item["vi_term"],
                item["reading"],
                item["han_viet"],
                item["english_meaning"],
                item["term_type"],
                item["status"],
                freq_val,
                item["first_seen_vol"],
            ]
        )

    return buf.getvalue(), media_type


def build_glossary_term_xml_attrs(source_lang: str, row: Any) -> dict[str, str]:
    """Canonical <TERM .../> attributes shared by Glossary XML & Continuity Pack XML.

    Matches sample_continuity_pack.xml for Japanese (`jp`, `vn`, `romaji`, `type`)
    and uses (`source`, `vn`, `reading`, `type`, optional `han_viet`) for ZH/KO.
    """
    if source_lang == "ja":
        return {
            "jp": str(row["source_term"]),
            "vn": str(row["vi_term"]),
            "romaji": str(row["reading"] or ""),
            "type": str(row["term_type"] or "Concept"),
        }
    attrs: dict[str, str] = {
        "source": str(row["source_term"]),
        "vn": str(row["vi_term"]),
        "reading": str(row["reading"] or ""),
        "type": str(row["term_type"] or "Concept"),
    }
    han_viet_val = str(row["han_viet"] or "").strip()
    if han_viet_val:
        attrs["han_viet"] = han_viet_val
    return attrs


def render_glossary_xml(
    series_id: int,
    *,
    volume_id: int | None = None,
    statuses: Iterable[str] = ("approved", "translated"),
    db_path: Path | str | None = None,
) -> str:
    """Deterministically serialize <GLOSSARY> XML directly from SQLite via ElementTree."""
    valid_statuses = [s for s in statuses if s in VALID_GLOSSARY_STATUSES] or ["approved"]
    placeholders = ",".join("?" for _ in valid_statuses)

    with db_session(db_path) as conn:
        series_row = conn.execute(
            "SELECT id, source_lang FROM series WHERE id = ?",
            (series_id,),
        ).fetchone()
        if series_row is None:
            raise LookupError("Không tìm thấy bộ truyện.")
        src_lang = str(series_row["source_lang"])

        if volume_id is not None:
            rows: list[sqlite3.Row] = conn.execute(
                f"""
                SELECT g.source_term, g.vi_term, g.reading, g.han_viet, g.term_type
                FROM glossary_terms g
                INNER JOIN volume_glossary_freq vgf
                    ON vgf.term_id = g.id AND vgf.volume_id = ?
                WHERE g.series_id = ? AND vgf.freq > 0
                  AND g.status IN ({placeholders})
                  AND TRIM(g.vi_term) != ''
                ORDER BY vgf.freq DESC, g.id ASC
                """,
                [volume_id, series_id, *valid_statuses],
            ).fetchall()
        else:
            rows = conn.execute(
                f"""
                SELECT source_term, vi_term, reading, han_viet, term_type
                FROM glossary_terms
                WHERE series_id = ?
                  AND status IN ({placeholders})
                  AND TRIM(vi_term) != ''
                ORDER BY total_freq DESC, id ASC
                """,
                [series_id, *valid_statuses],
            ).fetchall()

    root = ET.Element("GLOSSARY", {"lang": src_lang})
    for r in rows:
        ET.SubElement(root, "TERM", build_glossary_term_xml_attrs(src_lang, r))

    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="unicode")
