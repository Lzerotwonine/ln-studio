PRAGMA foreign_keys = ON;

-- 1. Bộ truyện (Series)
CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_lang TEXT NOT NULL DEFAULT 'ja' CHECK (source_lang IN ('ja', 'zh', 'ko')),
    translation_mode TEXT NOT NULL DEFAULT 'ln_vn' CHECK (translation_mode IN ('ln_vn', 'freeform', 'hybrid')),
    system_prompt TEXT DEFAULT '',          -- Dùng cho chế độ Freeform/Aiko hoặc Hybrid
    master_prompt_file TEXT DEFAULT 'master_prompt_vn.xml',
    hybrid_config_json TEXT DEFAULT '{"use_glossary":true,"use_characters":true,"use_relationships":true,"use_subarc":false,"rolling_context_lines":5}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tập truyện (Volumes)
CREATE TABLE IF NOT EXISTS volumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    volume_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    volume_summary TEXT DEFAULT '',
    rtas_baseline REAL DEFAULT 3.0,
    rtas_current_avg REAL DEFAULT 3.0,
    rtas_drift TEXT DEFAULT '',
    status TEXT DEFAULT 'imported',         -- imported | glossary_done | continuity_done | translating | completed
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(series_id, volume_number)
);

-- 3. Chương / Phần chia (Chapters/Chunks)
CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    title TEXT DEFAULT '',
    raw_text TEXT NOT NULL,
    masked_raw_text TEXT,                   -- Bản đã che từ nhạy cảm (nếu từng bị chặn)
    translated_text TEXT DEFAULT '',
    summary_json TEXT,                      -- Kết quả MAP PHASE dạng JSON (có dialogue_interactions)
    status TEXT DEFAULT 'pending',          -- pending | summarized | translating | completed | failed | blocked
    used_slot TEXT,                         -- VD: API_KEY_1|gemini-2.5-flash
    char_ratio REAL DEFAULT 0.0,
    error_message TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(volume_id, chapter_index)
);

-- 4. Master Glossary xuyên suốt toàn bộ Series (thay thế Excel)
CREATE TABLE IF NOT EXISTS glossary_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    source_term TEXT NOT NULL,
    normalized_key TEXT NOT NULL,           -- NFKC + strip
    vi_term TEXT DEFAULT '',
    reading TEXT DEFAULT '',                -- Romaji (JA) / Pinyin (ZH) / Romanization (KO)
    han_viet TEXT DEFAULT '',
    english_meaning TEXT DEFAULT '',
    term_type TEXT DEFAULT 'Concept',       -- Character|Place|Skill|Item|Title|Organization|Race|Creature|Rank|Event|Concept|Language|Currency
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'translated', 'approved', 'ignored')),
    first_seen_vol INTEGER DEFAULT 1,
    total_freq INTEGER DEFAULT 1,
    UNIQUE(series_id, normalized_key)
);

-- Tần suất thuật ngữ riêng từng tập (để lọc đúng từ của tập đó)
CREATE TABLE IF NOT EXISTS volume_glossary_freq (
    volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
    term_id INTEGER NOT NULL REFERENCES glossary_terms(id) ON DELETE CASCADE,
    freq INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (volume_id, term_id)
);

-- 5. Danh sách nhân vật (ROSTER) xuyên suốt Series
CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    canonical_name TEXT NOT NULL,           -- Tên gốc (JP/ZH/KO)
    display_name TEXT NOT NULL,             -- Romaji / Tên tiếng Việt
    aliases_json TEXT DEFAULT '[]',         -- JSON array các biệt danh ["ルディ", "泥沼のルーデウス"]
    archetype TEXT DEFAULT 'NORMAL',
    default_pair TEXT DEFAULT 'Tôi-Cậu',
    rtas_baseline REAL DEFAULT 3.5,
    UNIQUE(series_id, canonical_name)
);

-- Trạng thái nhân vật theo từng tập (ACTUAL/MENTIONED + SUB_ARC_STATE)
CREATE TABLE IF NOT EXISTS volume_character_states (
    volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    appearance TEXT NOT NULL DEFAULT 'ACTUAL' CHECK (appearance IN ('ACTUAL', 'MENTIONED')),
    subarc TEXT DEFAULT '',
    current_state TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    PRIMARY KEY (volume_id, character_id)
);

-- 6. Quan hệ & Xưng hô có hướng (A -> B) — Giải quyết dứt điểm lỗi thiếu xưng hô
CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    source_char_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    target_char_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    pair_pronoun TEXT NOT NULL DEFAULT '',  -- VD: "Anh-Em", "Ta-Nhóc"
    rtas_score REAL DEFAULT 3.5,
    notes TEXT DEFAULT '',
    evidence_quote TEXT DEFAULT '',         -- Trích thoại gốc AI bắt được từ MAP PHASE
    needs_review INTEGER DEFAULT 1,         -- 1 = hiện trong Review Queue, 0 = đã duyệt
    is_locked INTEGER DEFAULT 0,            -- 1 = AI không được tự ý sửa lại ở các tập sau
    last_updated_vol INTEGER DEFAULT 1,
    UNIQUE(series_id, source_char_id, target_char_id)
);

-- 7. Từ điển che từ nhạy cảm (thay thế text_cleaner.py hardcode)
CREATE TABLE IF NOT EXISTS sensitive_masks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER REFERENCES series(id) ON DELETE CASCADE, -- NULL = áp dụng toàn cục
    raw_phrase TEXT NOT NULL,
    safe_replacement TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 8. Quản lý API Keys & Quota Slot
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    api_key TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quota_slots (
    slot_id TEXT PRIMARY KEY,               -- Format: "KEY_NAME|model-id"
    key_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    requests_today INTEGER DEFAULT 0,
    quota_date TEXT NOT NULL,
    last_request_ts REAL DEFAULT 0,
    cooldown_until REAL DEFAULT 0,
    is_daily_exhausted INTEGER DEFAULT 0,
    last_error TEXT
);

-- 9. Prompt Presets (cho chế độ Aiko/Freeform & đa ngôn ngữ)
CREATE TABLE IF NOT EXISTS prompt_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    source_lang TEXT NOT NULL,              -- ja | zh | ko | any
    mode TEXT NOT NULL,                     -- ln_vn | freeform | hybrid
    content TEXT NOT NULL
);