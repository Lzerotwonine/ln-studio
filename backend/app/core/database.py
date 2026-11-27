"""SQLite database initialization and connection helpers for LN-Studio."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = PROJECT_ROOT / "docs" / "schema.sql"
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "app.db"

DEFAULT_MODELS: list[str] = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
]

DEFAULT_MODEL_LIMITS: dict[str, dict[str, int]] = {
    "default": {"rpm": 10, "rpd": 250},
    "gemini-2.5-flash": {"rpm": 10, "rpd": 250},
    "gemini-2.5-pro": {"rpm": 5, "rpd": 100},
    "gemini-2.0-flash": {"rpm": 15, "rpd": 1500},
}

DEFAULT_PROMPT_PRESETS: list[dict[str, str]] = [
    {
        "name": "LN-VN Nhật chuẩn",
        "source_lang": "ja",
        "mode": "ln_vn",
        "content": (
            "Bạn là biên dịch viên Light Novel tiếng Nhật chuyên nghiệp sang tiếng Việt chuẩn xuất bản.\n"
            "- Tuân thủ tuyệt đối bảng thuật ngữ (Glossary), danh sách nhân vật (Roster) và ma trận xưng hô có hướng (Relationships).\n"
            "- Giữ nguyên nhịp văn, sắc thái nội tâm, dấu câu đặc trưng của Light Novel Nhật; tuyệt đối không dịch word-by-word hay bỏ sót câu.\n"
            "- Lời thoại phải tự nhiên đúng tính cách nhân vật (archetype) và khoảng cách quan hệ (RTAS), phân biệt rõ thoại và suy nghĩ nội tâm.\n"
            "- Giữ nguyên tên riêng theo quy ước Romaji/Việt đã chốt; không tự ý Việt hóa hoặc đổi cách gọi giữa chừng."
        ),
    },
    {
        "name": "Nhật Tự Do (Freeform)",
        "source_lang": "ja",
        "mode": "freeform",
        "content": (
            "Bạn là dịch giả Light Novel / Web Novel tiếng Nhật phong cách mượt mà, giàu cảm xúc và tự nhiên như người Việt viết.\n"
            "- Ưu tiên văn phong sống động, uyển chuyển, thoát ý khỏi cấu trúc ngữ pháp Nhật nhưng vẫn truyền tải trọn vẹn sắc thái và tình tiết gốc.\n"
            "- Chọn đại từ nhân xưng linh hoạt theo ngữ cảnh cảm xúc, độ thân mật và vai vế giữa các nhân vật.\n"
            "- Xử lý khéo léo từ tượng thanh/tượng hình, chơi chữ và sắc thái hài hước/lãng mạn để người đọc Việt cảm nhận trọn vẹn."
        ),
    },
    {
        "name": "Tiên hiệp / Huyền huyễn Trung",
        "source_lang": "zh",
        "mode": "hybrid",
        "content": (
            "Bạn là dịch giả tiểu thuyết Tiên hiệp / Huyền huyễn Trung Quốc sang tiếng Việt giàu khí chất cổ phong.\n"
            "- Sử dụng từ Hán-Việt chuẩn xác cho cảnh giới tu luyện, công pháp, pháp bảo, tông môn, danh hiệu và chiêu thức.\n"
            "- Giữ ngữ điệu trang trọng, hào hùng khi miêu tả đại chiến hoặc ngộ đạo; tránh lạm dụng Hán-Việt tối nghĩa trong hội thoại đời thường.\n"
            "- Nhất quán xưng hô cổ trang (tại hạ, đạo hữu, tiền bối, vãn bối, bản tọa, sư tôn...) theo đúng ma trận quan hệ và bảng thuật ngữ."
        ),
    },
    {
        "name": "Hunter / Hệ thống Hàn",
        "source_lang": "ko",
        "mode": "hybrid",
        "content": (
            "Bạn là dịch giả Web Novel Hàn Quốc thể loại Hunter / Hầm ngục / Hệ thống (System) sang tiếng Việt hiện đại.\n"
            "- Giữ nhịp văn dứt khoát, kịch tính; trình bày rõ ràng các khung thông báo Hệ thống, kỹ năng, chỉ số, cấp bậc (Rank S/A/B/C/D/E).\n"
            "- Chuyển ngữ tự nhiên kính ngữ Hàn Quốc (-nim, -ssi, sunbae, hyung, noona...) sang xưng hô tiếng Việt phù hợp ngữ cảnh hiện đại.\n"
            "- Nhất quán tên Guild, hầm ngục, kỹ năng và vật phẩm theo bảng thuật ngữ đã duyệt; tránh giữ nguyên từ phiên âm khó hiểu khi có từ Việt tương đương mượt hơn."
        ),
    },
]


def get_db_path(db_path: Path | str | None = None) -> Path:
    """Resolve the active SQLite database path."""
    if db_path is not None:
        return Path(db_path)
    env_path = os.environ.get("LN_STUDIO_DB_PATH")
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


def get_connection(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Open a SQLite connection configured with WAL mode and foreign keys ON."""
    path = get_db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


@contextmanager
def db_session(
    db_path: Path | str | None = None,
) -> Generator[sqlite3.Connection, None, None]:
    """Context manager yielding a transactional SQLite connection."""
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def seed_default_presets(conn: sqlite3.Connection) -> int:
    """Insert built-in prompt presets if they do not already exist. Returns count inserted."""
    inserted = 0
    for preset in DEFAULT_PROMPT_PRESETS:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO prompt_presets (name, source_lang, mode, content)
            VALUES (?, ?, ?, ?)
            """,
            (
                preset["name"],
                preset["source_lang"],
                preset["mode"],
                preset["content"],
            ),
        )
        inserted += cur.rowcount
    return inserted


def get_setting(
    conn: sqlite3.Connection, key: str, default: Any = None
) -> Any:
    """Read and JSON-decode a value from app_settings."""
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", (key,)
    ).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (ValueError, TypeError):
        return row["value"]


def set_setting(conn: sqlite3.Connection, key: str, value: Any) -> None:
    """JSON-encode and upsert a value into app_settings."""
    serialized = json.dumps(value, ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        """,
        (key, serialized),
    )


def init_db(db_path: Path | str | None = None) -> Path:
    """Initialize data/app.db from docs/schema.sql, enable WAL + FK, and seed defaults."""
    resolved_path = get_db_path(db_path)
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"Schema SQL not found at: {SCHEMA_PATH}")

    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    with db_session(resolved_path) as conn:
        conn.executescript(schema_sql)
        # Re-assert pragmas because executescript resets implicit transaction state
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA foreign_keys = ON;")

        # Application settings table for model priority & reference quota limits
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Seed default model priority list and limits if absent
        if get_setting(conn, "model_priority") is None:
            set_setting(conn, "model_priority", DEFAULT_MODELS)
        if get_setting(conn, "model_limits") is None:
            set_setting(conn, "model_limits", DEFAULT_MODEL_LIMITS)

        # Migrate legacy preset naming cleanly if an existing DB has the old default name
        freeform_default = DEFAULT_PROMPT_PRESETS[1]
        legacy_row = conn.execute(
            "SELECT id FROM prompt_presets WHERE name LIKE '%-style Nhật tự do' AND name != ?",
            (freeform_default["name"],),
        ).fetchone()
        if legacy_row is not None:
            exists_new = conn.execute(
                "SELECT id FROM prompt_presets WHERE name = ?",
                (freeform_default["name"],),
            ).fetchone()
            if exists_new is not None:
                conn.execute("DELETE FROM prompt_presets WHERE id = ?", (legacy_row["id"],))
            else:
                conn.execute(
                    "UPDATE prompt_presets SET name = ?, content = ? WHERE id = ?",
                    (freeform_default["name"], freeform_default["content"], legacy_row["id"]),
                )

        # Seed 4 default prompt presets
        seed_default_presets(conn)

    return resolved_path
