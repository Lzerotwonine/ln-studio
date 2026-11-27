"""LN-VN Reference Packs service: DB CRUD, disk sync from data/prompts/ln_vn/references/, and phase prompt loader."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from app.core.database import PROJECT_ROOT, db_session
from app.services.epub_service import decode_text_bytes

REFERENCES_DISK_DIR = PROJECT_ROOT / "data" / "prompts" / "ln_vn" / "references"
DEFAULT_PACK_NAME = "LN-VN Core"
ALLOWED_REF_EXTENSIONS = {".md", ".txt", ".xml"}


def _row_to_ref(row: sqlite3.Row, *, include_content: bool = False) -> dict[str, Any]:
    content = str(row["content"] or "")
    size_bytes = len(content.encode("utf-8"))
    item: dict[str, Any] = {
        "id": int(row["id"]),
        "pack_name": str(row["pack_name"]),
        "filename": str(row["filename"]),
        "size_bytes": size_bytes,
        "estimated_tokens": max(1, size_bytes // 3) if size_bytes > 0 else 0,
        "use_in_summary": bool(row["use_in_summary"]),
        "use_in_translate": bool(row["use_in_translate"]),
        "is_active": bool(row["is_active"]),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }
    if include_content:
        item["content"] = content
    return item


def seed_reference_files_from_disk(
    conn: sqlite3.Connection, *, force_sync: bool = False
) -> int:
    """Seed LN-VN Reference Pack files from data/prompts/ln_vn/references/ into reference_files."""
    if not REFERENCES_DISK_DIR.is_dir():
        return 0

    existing_count = int(
        conn.execute("SELECT COUNT(*) AS c FROM reference_files").fetchone()["c"]
    )
    if existing_count > 0 and not force_sync:
        return 0

    inserted = 0
    for path in sorted(REFERENCES_DISK_DIR.iterdir()):
        if not path.is_file() or path.suffix.lower() not in ALLOWED_REF_EXTENSIONS:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except Exception:
            continue

        # Only activate the compact primer by default; keep large reference DBs opt-in to protect token budget
        is_primer = path.name == "Library_LOCALIZATION_PRIMER_VN.md"
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO reference_files (
                pack_name, filename, content, use_in_summary, use_in_translate, is_active
            )
            VALUES (?, ?, ?, 0, 1, ?)
            """,
            (DEFAULT_PACK_NAME, path.name, content, 1 if is_primer else 0),
        )
        inserted += cur.rowcount
    return inserted


def sync_reference_files_from_disk(db_path: Path | str | None = None) -> dict[str, int]:
    with db_session(db_path) as conn:
        inserted = seed_reference_files_from_disk(conn, force_sync=True)
        total = int(conn.execute("SELECT COUNT(*) AS c FROM reference_files").fetchone()["c"])
    return {"inserted": inserted, "total": total}


def list_reference_files(
    *, include_content: bool = False, db_path: Path | str | None = None
) -> list[dict[str, Any]]:
    with db_session(db_path) as conn:
        rows = conn.execute(
            """
            SELECT * FROM reference_files
            ORDER BY pack_name ASC, filename ASC
            """
        ).fetchall()
    return [_row_to_ref(r, include_content=include_content) for r in rows]


def get_reference_file(
    ref_id: int, *, db_path: Path | str | None = None
) -> dict[str, Any]:
    with db_session(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM reference_files WHERE id = ?", (ref_id,)
        ).fetchone()
    if row is None:
        raise LookupError("Không tìm thấy tệp tham chiếu.")
    return _row_to_ref(row, include_content=True)


def upsert_reference_file(
    *,
    pack_name: str,
    filename: str,
    file_bytes: bytes,
    use_in_summary: bool = False,
    use_in_translate: bool = True,
    is_active: bool = True,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    clean_pack = (pack_name or DEFAULT_PACK_NAME).strip() or DEFAULT_PACK_NAME
    clean_name = Path(filename or "").name.strip()
    if not clean_name:
        raise ValueError("Tên tệp tham chiếu không được để trống.")
    if Path(clean_name).suffix.lower() not in ALLOWED_REF_EXTENSIONS:
        raise ValueError("Chỉ hỗ trợ tải lên tệp .md, .txt hoặc .xml.")

    content = decode_text_bytes(file_bytes).lstrip("\ufeff")
    if not content.strip():
        raise ValueError("Nội dung tệp tham chiếu đang rỗng.")

    with db_session(db_path) as conn:
        existing = conn.execute(
            "SELECT id FROM reference_files WHERE pack_name = ? AND filename = ?",
            (clean_pack, clean_name),
        ).fetchone()
        if existing is not None:
            ref_id = int(existing["id"])
            conn.execute(
                """
                UPDATE reference_files
                SET content = ?,
                    use_in_summary = ?,
                    use_in_translate = ?,
                    is_active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    content,
                    1 if use_in_summary else 0,
                    1 if use_in_translate else 0,
                    1 if is_active else 0,
                    ref_id,
                ),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO reference_files (
                    pack_name, filename, content, use_in_summary, use_in_translate, is_active
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    clean_pack,
                    clean_name,
                    content,
                    1 if use_in_summary else 0,
                    1 if use_in_translate else 0,
                    1 if is_active else 0,
                ),
            )
            ref_id = int(cur.lastrowid)

        row = conn.execute(
            "SELECT * FROM reference_files WHERE id = ?", (ref_id,)
        ).fetchone()
    return _row_to_ref(row, include_content=False)


def update_reference_file(
    ref_id: int,
    *,
    pack_name: str | None = None,
    use_in_summary: bool | None = None,
    use_in_translate: bool | None = None,
    is_active: bool | None = None,
    content: str | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    updates: list[str] = []
    params: list[Any] = []
    if pack_name is not None:
        cleaned = pack_name.strip()
        if not cleaned:
            raise ValueError("Tên gói không được để trống.")
        updates.append("pack_name = ?")
        params.append(cleaned)
    if use_in_summary is not None:
        updates.append("use_in_summary = ?")
        params.append(1 if use_in_summary else 0)
    if use_in_translate is not None:
        updates.append("use_in_translate = ?")
        params.append(1 if use_in_translate else 0)
    if is_active is not None:
        updates.append("is_active = ?")
        params.append(1 if is_active else 0)
    if content is not None:
        updates.append("content = ?")
        params.append(content)

    with db_session(db_path) as conn:
        if conn.execute("SELECT id FROM reference_files WHERE id = ?", (ref_id,)).fetchone() is None:
            raise LookupError("Không tìm thấy tệp tham chiếu.")
        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(ref_id)
            conn.execute(
                f"UPDATE reference_files SET {', '.join(updates)} WHERE id = ?",
                params,
            )
        row = conn.execute(
            "SELECT * FROM reference_files WHERE id = ?", (ref_id,)
        ).fetchone()
    return _row_to_ref(row, include_content=False)


def delete_reference_file(ref_id: int, *, db_path: Path | str | None = None) -> None:
    with db_session(db_path) as conn:
        cur = conn.execute("DELETE FROM reference_files WHERE id = ?", (ref_id,))
        if cur.rowcount == 0:
            raise LookupError("Không tìm thấy tệp tham chiếu.")


def load_active_reference_block(
    *,
    phase: str,  # "translate" | "summary"
    db_path: Path | str | None = None,
) -> tuple[str, list[str]]:
    """Build deterministic <REFERENCE_PACKS> block from active reference_files for the given phase."""
    col = "use_in_summary" if phase == "summary" else "use_in_translate"
    with db_session(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT pack_name, filename, content
            FROM reference_files
            WHERE is_active = 1 AND {col} = 1
            ORDER BY pack_name ASC, filename ASC
            """
        ).fetchall()

    if not rows:
        return "", []

    parts: list[str] = ["<REFERENCE_PACKS>"]
    filenames: list[str] = []
    for r in rows:
        fname = str(r["filename"])
        pack = str(r["pack_name"])
        filenames.append(fname)
        parts.append(f'<REFERENCE_FILE pack="{pack}" name="{fname}">\n{str(r["content"]).strip()}\n</REFERENCE_FILE>')
    parts.append("</REFERENCE_PACKS>")
    return "\n\n".join(parts), filenames
