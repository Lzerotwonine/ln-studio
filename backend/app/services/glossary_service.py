"""Master Glossary service: extraction, Gemini batch translation with 3-round reconciliation, TSV/CSV I/O, and deterministic XML export."""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import sqlite3
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


def translate_new_glossary_terms(
    series_id: int,
    *,
    volume_id: int | None = None,
    batch_size: int = 400,
    max_rounds: int = 3,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Translate only status='new' terms via Gemini Pool in 300-500 batches with up to 3 reconciliation rounds."""
    batch_size = max(1, min(500, int(batch_size)))
    max_rounds = max(1, min(5, int(max_rounds)))
    active_pool = pool or gemini_pool

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
                JOIN volume_glossary_freq vgf ON vgf.term_id = g.id
                WHERE g.series_id = ? AND vgf.volume_id = ? AND g.status = 'new'
                ORDER BY vgf.freq DESC, g.id ASC
                """,
                (series_id, volume_id),
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

    terms_to_translate = [dict(r) for r in rows]
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
                            """
                            UPDATE glossary_terms
                            SET vi_term = ?,
                                reading = CASE WHEN ? != '' THEN ? ELSE reading END,
                                han_viet = ?,
                                english_meaning = ?,
                                term_type = ?,
                                status = 'translated'
                            WHERE id = ? AND status = 'new'
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


def list_glossary_terms(
    series_id: int,
    *,
    volume_id: int | None = None,
    status_filter: str | None = None,
    term_type: str | None = None,
    min_freq: int = 1,
    search: str | None = None,
    limit: int = 1000,
    offset: int = 0,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Query glossary terms for a series or specific volume with filters and status counts."""
    with db_session(db_path) as conn:
        series = conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone()
        if series is None:
            raise LookupError("Không tìm thấy bộ truyện.")

        if volume_id is not None:
            base_from = (
                "FROM glossary_terms g "
                "JOIN volume_glossary_freq vgf ON vgf.term_id = g.id AND vgf.volume_id = ?"
            )
            base_params: list[Any] = [volume_id, series_id]
            freq_col = "vgf.freq"
            select_extra = ", vgf.freq AS volume_freq"
        else:
            base_from = "FROM glossary_terms g"
            base_params = [series_id]
            freq_col = "g.total_freq"
            select_extra = ", NULL AS volume_freq"

        # Status counts within the current scope (series or volume) before status filter
        count_rows = conn.execute(
            f"""
            SELECT g.status, COUNT(*) AS cnt
            {base_from}
            WHERE g.series_id = ?
            GROUP BY g.status
            """,
            base_params,
        ).fetchall()
        status_counts = {s: 0 for s in VALID_GLOSSARY_STATUSES}
        for r in count_rows:
            if r["status"] in status_counts:
                status_counts[r["status"]] = int(r["cnt"])
        total_in_scope = sum(status_counts.values())

        where_clauses = ["g.series_id = ?"]
        params = list(base_params)

        if status_filter and status_filter in VALID_GLOSSARY_STATUSES:
            where_clauses.append("g.status = ?")
            params.append(status_filter)
        if term_type:
            where_clauses.append("g.term_type = ?")
            params.append(term_type)
        if min_freq > 1:
            where_clauses.append(f"{freq_col} >= ?")
            params.append(min_freq)
        if search and search.strip():
            like = f"%{search.strip()}%"
            where_clauses.append(
                "(g.source_term LIKE ? OR g.vi_term LIKE ? OR g.reading LIKE ? "
                "OR g.han_viet LIKE ? OR g.english_meaning LIKE ?)"
            )
            params.extend([like, like, like, like, like])

        where_sql = " AND ".join(where_clauses)
        filtered_total = int(
            conn.execute(
                f"SELECT COUNT(*) AS cnt {base_from} WHERE {where_sql}",
                params,
            ).fetchone()["cnt"]
        )

        rows = conn.execute(
            f"""
            SELECT g.*{select_extra}
            {base_from}
            WHERE {where_sql}
            ORDER BY {freq_col} DESC, g.id ASC
            LIMIT ? OFFSET ?
            """,
            [*params, max(1, min(5000, limit)), max(0, offset)],
        ).fetchall()

    items = [dict(r) for r in rows]
    return {
        "items": items,
        "total_filtered": filtered_total,
        "total_in_scope": total_in_scope,
        "status_counts": status_counts,
    }


def _detect_column_map(headers: list[str]) -> dict[str, int]:
    aliases: dict[str, set[str]] = {
        "source_term": {
            "source_term",
            "source",
            "jp",
            "ja",
            "zh",
            "ko",
            "term",
            "original",
            "raw",
            "word",
            "từ gốc",
            "tu goc",
        },
        "vi_term": {
            "vi_term",
            "vn",
            "vi",
            "vietnamese",
            "translation",
            "bản dịch",
            "ban dich",
            "nghĩa việt",
            "nghia viet",
        },
        "reading": {
            "reading",
            "romaji",
            "pinyin",
            "romanization",
            "kana",
            "furigana",
            "phiên âm",
            "phien am",
        },
        "han_viet": {"han_viet", "hanviet", "han-viet", "hán việt", "hv"},
        "english_meaning": {
            "english_meaning",
            "english",
            "en",
            "meaning",
            "nghĩa anh",
            "nghia anh",
        },
        "term_type": {"term_type", "type", "category", "loại", "loai"},
        "status": {"status", "trạng thái", "trang thai"},
        "total_freq": {"total_freq", "freq", "frequency", "count", "tần suất", "tan suat"},
        "first_seen_vol": {"first_seen_vol", "vol", "volume", "tập", "tap"},
    }

    col_map: dict[str, int] = {}
    for idx, raw_header in enumerate(headers):
        h = raw_header.strip().lstrip("\ufeff").lower()
        for field, names in aliases.items():
            if h in names and field not in col_map:
                col_map[field] = idx
                break
    return col_map


def import_glossary_tabular(
    series_id: int,
    filename: str,
    file_bytes: bytes,
    *,
    default_status: str = "approved",
    db_path: Path | str | None = None,
) -> dict[str, int]:
    """Import TSV or CSV glossary file (e.g., from legacy Excel sheets) into Master DB."""
    if default_status not in VALID_GLOSSARY_STATUSES:
        default_status = "approved"

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
    rows = list(reader)
    if not rows:
        raise ValueError("Tệp không có dữ liệu.")

    col_map = _detect_column_map(rows[0])
    if "source_term" in col_map:
        data_rows = rows[1:]
    else:
        # Headerless fallback: col 0 = source_term, col 1 = vi_term, col 2 = reading, col 3 = term_type
        col_map = {"source_term": 0, "vi_term": 1, "reading": 2, "term_type": 3}
        data_rows = rows

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
            term_type = _normalize_term_type(_cell(row, "term_type"))
            raw_status = _cell(row, "status").lower()
            if raw_status in VALID_GLOSSARY_STATUSES:
                row_status = raw_status
            else:
                row_status = default_status if vi_term else "new"

            try:
                freq = max(1, int(_cell(row, "total_freq") or 1))
            except ValueError:
                freq = 1
            try:
                first_vol = max(1, int(_cell(row, "first_seen_vol") or 1))
            except ValueError:
                first_vol = 1

            existing = conn.execute(
                "SELECT id FROM glossary_terms WHERE series_id = ? AND normalized_key = ?",
                (series_id, norm),
            ).fetchone()

            if existing is not None:
                conn.execute(
                    """
                    UPDATE glossary_terms
                    SET vi_term = CASE WHEN ? != '' THEN ? ELSE vi_term END,
                        reading = CASE WHEN ? != '' THEN ? ELSE reading END,
                        han_viet = CASE WHEN ? != '' THEN ? ELSE han_viet END,
                        english_meaning = CASE WHEN ? != '' THEN ? ELSE english_meaning END,
                        term_type = CASE WHEN ? != '' THEN ? ELSE term_type END,
                        status = ?
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
                        _cell(row, "term_type"),
                        term_type,
                        row_status,
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
    db_path: Path | str | None = None,
) -> tuple[str, str]:
    """Export glossary terms to UTF-8-BOM TSV or CSV string. Returns (content, media_type)."""
    data = list_glossary_terms(
        series_id,
        volume_id=volume_id,
        status_filter=status_filter,
        limit=5000,
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
                JOIN volume_glossary_freq vgf ON vgf.term_id = g.id
                WHERE g.series_id = ? AND vgf.volume_id = ?
                  AND g.status IN ({placeholders})
                  AND TRIM(g.vi_term) != ''
                ORDER BY vgf.freq DESC, g.id ASC
                """,
                [series_id, volume_id, *valid_statuses],
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
        attrs = {
            "source": str(r["source_term"]),
            "vn": str(r["vi_term"]),
            "type": str(r["term_type"] or "Concept"),
        }
        if (r["reading"] or "").strip():
            attrs["reading"] = str(r["reading"])
        if (r["han_viet"] or "").strip():
            attrs["han_viet"] = str(r["han_viet"])
        ET.SubElement(root, "TERM", attrs)

    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="unicode")
