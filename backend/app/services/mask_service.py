"""Sensitive word masking dictionary (multi-lang + bulk import) & Gemini-assisted scan/mask service."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.core.database import PROJECT_ROOT, db_session
from app.core.gemini_pool import GeminiPool, gemini_pool

VALID_MASK_LANGS = ("all", "ja", "zh", "ko")
DEFAULT_SEED_MASKS_PATH = PROJECT_ROOT / "docs" / "data" / "seed" / "sensitive_masks.txt"


class SensitiveMaskSuggestion(BaseModel):
    raw_phrase: str
    safe_replacement: str
    reason: str = ""


class SensitiveScanSchema(BaseModel):
    suggestions: list[SensitiveMaskSuggestion] = Field(default_factory=list)


_SCAN_SYSTEM_PROMPT = """Bạn là chuyên gia biên tập và xử lý bộ lọc an toàn (safety filter) cho dịch thuật tiểu thuyết / Light Novel.
Nhiệm vụ: Đọc đoạn văn bản gốc bị bộ lọc an toàn chặn và chỉ ra các từ/cụm từ nhạy cảm (bạo lực cực đoan, máu me, yếu tố tình dục nhạy cảm, từ khóa dễ bị hiểu nhầm) có thể gây kích hoạt bộ lọc, đồng thời đề xuất cụm thay thế nhẹ nhàng bằng CÙNG NGÔN NGỮ GỐC sao cho giữ nguyên hoàn toàn mạch truyện và ý nghĩa khi dịch sang tiếng Việt.

QUY TẮC BẮT BUỘC:
1. `raw_phrase` PHẢI xuất hiện NGUYÊN VĂN trong văn bản gốc (để có thể find-and-replace chính xác).
2. `safe_replacement` là cụm thay thế ngắn gọn, trung tính, nhẹ nhàng hơn (cùng ngôn ngữ gốc hoặc cách diễn đạt gián tiếp), giữ đúng ngữ cảnh.
3. `reason` giải thích ngắn gọn bằng tiếng Việt lý do cụm từ có thể gây chặn.
4. Trả về đúng JSON hợp lệ theo schema."""


def _normalize_lang(lang: str | None) -> str:
    val = (lang or "all").strip().lower()
    return val if val in VALID_MASK_LANGS else "all"


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


def _row_to_mask(row: sqlite3.Row) -> dict[str, Any]:
    row_dict = dict(row)
    return {
        "id": int(row_dict["id"]),
        "series_id": int(row_dict["series_id"]) if row_dict["series_id"] is not None else None,
        "source_lang": str(row_dict.get("source_lang") or "all"),
        "raw_phrase": str(row_dict["raw_phrase"]),
        "safe_replacement": str(row_dict["safe_replacement"]),
        "created_at": str(row_dict["created_at"]),
    }


def list_masks(
    series_id: int | None = None,
    *,
    include_global: bool = True,
    only_global: bool = False,
    source_lang: str | None = None,
    search: str | None = None,
    db_path: Path | str | None = None,
) -> list[dict[str, Any]]:
    """List sensitive_masks filtered by scope (global/series), language, and search query."""
    where: list[str] = []
    params: list[Any] = []

    if only_global:
        where.append("series_id IS NULL")
    elif series_id is not None:
        if include_global:
            where.append("(series_id = ? OR series_id IS NULL)")
            params.append(series_id)
        else:
            where.append("series_id = ?")
            params.append(series_id)

    if source_lang and source_lang.strip().lower() in VALID_MASK_LANGS:
        lang = source_lang.strip().lower()
        if lang != "all":
            where.append("(source_lang = ? OR source_lang = 'all')")
            params.append(lang)

    if search and search.strip():
        like = f"%{search.strip()}%"
        where.append("(raw_phrase LIKE ? OR safe_replacement LIKE ?)")
        params.extend([like, like])

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    order_sql = (
        "ORDER BY CASE WHEN series_id IS NOT NULL THEN 0 ELSE 1 END, id DESC"
        if series_id is not None
        else "ORDER BY series_id IS NOT NULL, id DESC"
    )

    with db_session(db_path) as conn:
        rows = conn.execute(
            f"SELECT * FROM sensitive_masks {where_sql} {order_sql}",
            params,
        ).fetchall()
    return [_row_to_mask(r) for r in rows]


def upsert_mask(
    *,
    series_id: int | None,
    raw_phrase: str,
    safe_replacement: str,
    source_lang: str = "all",
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Create or update a sensitive mask entry for (series_id, raw_phrase)."""
    phrase = raw_phrase.strip()
    replacement = safe_replacement.strip()
    lang = _normalize_lang(source_lang)
    if not phrase or not replacement:
        raise ValueError("Cụm từ gốc và cụm thay thế không được để trống.")

    with db_session(db_path) as conn:
        if series_id is None:
            existing = conn.execute(
                "SELECT id FROM sensitive_masks WHERE series_id IS NULL AND raw_phrase = ?",
                (phrase,),
            ).fetchone()
        else:
            if conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone() is None:
                raise LookupError("Không tìm thấy bộ truyện.")
            existing = conn.execute(
                "SELECT id FROM sensitive_masks WHERE series_id = ? AND raw_phrase = ?",
                (series_id, phrase),
            ).fetchone()

        if existing is not None:
            mask_id = int(existing["id"])
            conn.execute(
                "UPDATE sensitive_masks SET safe_replacement = ?, source_lang = ? WHERE id = ?",
                (replacement, lang, mask_id),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO sensitive_masks (series_id, source_lang, raw_phrase, safe_replacement)
                VALUES (?, ?, ?, ?)
                """,
                (series_id, lang, phrase, replacement),
            )
            mask_id = int(cur.lastrowid)

        row = conn.execute(
            "SELECT * FROM sensitive_masks WHERE id = ?", (mask_id,)
        ).fetchone()
    return _row_to_mask(row)


def update_mask(
    mask_id: int,
    *,
    source_lang: str | None = None,
    raw_phrase: str | None = None,
    safe_replacement: str | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    updates: list[str] = []
    params: list[Any] = []
    if source_lang is not None:
        updates.append("source_lang = ?")
        params.append(_normalize_lang(source_lang))
    if raw_phrase is not None:
        cleaned = raw_phrase.strip()
        if not cleaned:
            raise ValueError("Cụm từ gốc không được để trống.")
        updates.append("raw_phrase = ?")
        params.append(cleaned)
    if safe_replacement is not None:
        cleaned_rep = safe_replacement.strip()
        if not cleaned_rep:
            raise ValueError("Cụm thay thế không được để trống.")
        updates.append("safe_replacement = ?")
        params.append(cleaned_rep)

    with db_session(db_path) as conn:
        if conn.execute("SELECT id FROM sensitive_masks WHERE id = ?", (mask_id,)).fetchone() is None:
            raise LookupError("Không tìm thấy quy tắc che từ.")
        if updates:
            params.append(mask_id)
            conn.execute(
                f"UPDATE sensitive_masks SET {', '.join(updates)} WHERE id = ?",
                params,
            )
        row = conn.execute("SELECT * FROM sensitive_masks WHERE id = ?", (mask_id,)).fetchone()
    return _row_to_mask(row)


def delete_mask(mask_id: int, db_path: Path | str | None = None) -> None:
    with db_session(db_path) as conn:
        cur = conn.execute("DELETE FROM sensitive_masks WHERE id = ?", (mask_id,))
        if cur.rowcount == 0:
            raise LookupError("Không tìm thấy quy tắc che từ.")


def bulk_import_masks(
    raw_text: str,
    *,
    series_id: int | None = None,
    source_lang: str = "all",
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Parse and upsert lines in `raw_phrase = safe_replacement` format (supports \\r, \\r\\n, \\n)."""
    normalized = (raw_text or "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lang = _normalize_lang(source_lang)

    imported = 0
    updated = 0
    skipped = 0
    invalid_lines: list[str] = []

    with db_session(db_path) as conn:
        if series_id is not None:
            if conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone() is None:
                raise LookupError("Không tìm thấy bộ truyện.")

        for line in normalized.split("\n"):
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.startswith("//"):
                continue

            if "=" in stripped:
                left, right = stripped.split("=", 1)
            elif "\t" in stripped:
                left, right = stripped.split("\t", 1)
            else:
                skipped += 1
                if len(invalid_lines) < 30:
                    invalid_lines.append(stripped[:120])
                continue

            phrase = left.strip()
            replacement = right.strip()
            if not phrase or not replacement:
                skipped += 1
                if len(invalid_lines) < 30:
                    invalid_lines.append(stripped[:120])
                continue

            if series_id is None:
                existing = conn.execute(
                    "SELECT id FROM sensitive_masks WHERE series_id IS NULL AND raw_phrase = ?",
                    (phrase,),
                ).fetchone()
            else:
                existing = conn.execute(
                    "SELECT id FROM sensitive_masks WHERE series_id = ? AND raw_phrase = ?",
                    (series_id, phrase),
                ).fetchone()

            if existing is not None:
                conn.execute(
                    "UPDATE sensitive_masks SET safe_replacement = ?, source_lang = ? WHERE id = ?",
                    (replacement, lang, int(existing["id"])),
                )
                updated += 1
            else:
                conn.execute(
                    """
                    INSERT INTO sensitive_masks (series_id, source_lang, raw_phrase, safe_replacement)
                    VALUES (?, ?, ?, ?)
                    """,
                    (series_id, lang, phrase, replacement),
                )
                imported += 1

    return {
        "imported": imported,
        "updated": updated,
        "skipped": skipped,
        "invalid_lines": invalid_lines,
    }


def seed_default_masks(db_path: Path | str | None = None) -> dict[str, Any]:
    """Import built-in Japanese sensitive masks from docs/data/seed/sensitive_masks.txt into Global JA scope."""
    if not DEFAULT_SEED_MASKS_PATH.is_file():
        raise LookupError("Không tìm thấy tệp mẫu docs/data/seed/sensitive_masks.txt.")
    raw = DEFAULT_SEED_MASKS_PATH.read_text(encoding="utf-8")
    return bulk_import_masks(raw, series_id=None, source_lang="ja", db_path=db_path)


def scan_sensitive_phrases(
    chapter_id: int,
    *,
    model_override: str | None = None,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Use Gemini to identify safety-triggering phrases in a chapter and propose mild replacements."""
    active_pool = pool or gemini_pool
    with db_session(db_path) as conn:
        row = conn.execute(
            """
            SELECT c.id, c.chapter_index, c.title, c.raw_text, v.series_id, s.source_lang
            FROM chapters c
            JOIN volumes v ON v.id = c.volume_id
            JOIN series s ON s.id = v.series_id
            WHERE c.id = ?
            """,
            (chapter_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Không tìm thấy chương.")

        raw_text = str(row["raw_text"])
        source_lang = str(row["source_lang"])
        series_id = int(row["series_id"])

    existing_masks = list_masks(
        series_id, include_global=True, source_lang=source_lang, db_path=db_path
    )
    prompt = (
        f"Ngôn ngữ gốc: {source_lang.upper()}\n"
        f"Chương {row['chapter_index']}: {row['title']}\n\n"
        f"Hãy quét đoạn văn bản sau và đề xuất danh sách cụm từ nhạy cảm cần che nhẹ "
        f"(chỉ trả về các cụm xuất hiện NGUYÊN VĂN trong văn bản):\n\n{raw_text}"
    )

    resp = active_pool.generate_content(
        prompt,
        system_instruction=_SCAN_SYSTEM_PROMPT,
        temperature=0.2,
        response_mime_type="application/json",
        response_schema=SensitiveScanSchema,
        task_type="sensitive_scan",
        models=[model_override] if model_override and model_override.strip() else None,
    )
    parsed = _parse_json_object(resp.text)
    schema_obj = SensitiveScanSchema.model_validate(parsed)

    # Keep only valid suggestions whose raw_phrase actually appears in raw_text
    seen: set[str] = set()
    valid_suggestions: list[dict[str, str]] = []
    for item in schema_obj.suggestions:
        phrase = item.raw_phrase.strip()
        replacement = item.safe_replacement.strip()
        if not phrase or not replacement or phrase == replacement:
            continue
        if phrase not in raw_text or phrase in seen:
            continue
        seen.add(phrase)
        valid_suggestions.append(
            {
                "raw_phrase": phrase,
                "safe_replacement": replacement,
                "reason": item.reason.strip(),
            }
        )

    return {
        "chapter_id": chapter_id,
        "series_id": series_id,
        "suggestions": valid_suggestions,
        "existing_masks": existing_masks,
        "used_slot": resp.slot_id,
    }


def apply_masks_to_chapter(
    chapter_id: int,
    *,
    extra_masks: list[dict[str, str]] | None = None,
    save_to_db: bool = True,
    scope: str = "series",
    clear_mask: bool = False,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Apply sensitive_masks onto raw_text and write chapters.masked_raw_text (NEVER mutating raw_text)."""
    with db_session(db_path) as conn:
        row = conn.execute(
            """
            SELECT c.id, c.raw_text, v.series_id, s.source_lang
            FROM chapters c
            JOIN volumes v ON v.id = c.volume_id
            JOIN series s ON s.id = v.series_id
            WHERE c.id = ?
            """,
            (chapter_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Không tìm thấy chương.")

        raw_text = str(row["raw_text"])
        series_id = int(row["series_id"])
        source_lang = str(row["source_lang"] or "all")

        if clear_mask:
            conn.execute(
                "UPDATE chapters SET masked_raw_text = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (chapter_id,),
            )
            return {
                "chapter_id": chapter_id,
                "masked_raw_text": None,
                "applied_count": 0,
                "applied_masks": [],
                "saved_masks_count": 0,
            }

    saved_count = 0
    target_series_id = None if scope == "global" else series_id
    if extra_masks and save_to_db:
        for pair in extra_masks:
            phrase = str(pair.get("raw_phrase") or "").strip()
            replacement = str(pair.get("safe_replacement") or "").strip()
            if phrase and replacement:
                upsert_mask(
                    series_id=target_series_id,
                    raw_phrase=phrase,
                    safe_replacement=replacement,
                    source_lang=source_lang,
                    db_path=db_path,
                )
                saved_count += 1

    # Combine global + series masks matching series source_lang (series overrides global, extra_masks overrides both)
    db_masks = list_masks(
        series_id, include_global=True, source_lang=source_lang, db_path=db_path
    )
    combined_map: dict[str, str] = {}
    for m in reversed(db_masks):
        combined_map[m["raw_phrase"]] = m["safe_replacement"]
    if extra_masks:
        for pair in extra_masks:
            phrase = str(pair.get("raw_phrase") or "").strip()
            replacement = str(pair.get("safe_replacement") or "").strip()
            if phrase and replacement:
                combined_map[phrase] = replacement

    sorted_pairs = sorted(combined_map.items(), key=lambda kv: -len(kv[0]))
    masked_text = raw_text
    applied_count = 0
    applied_masks: list[dict[str, Any]] = []

    for phrase, replacement in sorted_pairs:
        occurrences = masked_text.count(phrase)
        if occurrences > 0:
            masked_text = masked_text.replace(phrase, replacement)
            applied_count += occurrences
            applied_masks.append(
                {
                    "raw_phrase": phrase,
                    "safe_replacement": replacement,
                    "occurrences": occurrences,
                }
            )

    with db_session(db_path) as conn:
        conn.execute(
            """
            UPDATE chapters
            SET masked_raw_text = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (masked_text if applied_count > 0 or extra_masks else None, chapter_id),
        )

    return {
        "chapter_id": chapter_id,
        "masked_raw_text": masked_text if applied_count > 0 or extra_masks else None,
        "applied_count": applied_count,
        "applied_masks": applied_masks,
        "saved_masks_count": saved_count,
    }
