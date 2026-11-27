"""Phase 4 tests: Multi-mode Strategy Pattern, Quality Guard + <FICTION_CONTEXT>, Sensitive Masks, Background Job & REST APIs."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import db_session, init_db
from app.core.gemini_pool import GeminiPool
from app.main import create_app
from app.services.mask_service import (
    apply_masks_to_chapter,
    delete_mask,
    list_masks,
    scan_sensitive_phrases,
    upsert_mask,
)
from app.services.translator_service import (
    HybridOptions,
    TranslationJobManager,
    TranslationOptions,
    build_chapter_debug_context,
    translate_single_chapter,
)


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_phase4.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


def _seed_translation_fixture(db_file: Path) -> dict[str, int]:
    with db_session(db_file) as conn:
        s_id = conn.execute(
            """
            INSERT INTO series (title, source_lang, translation_mode, system_prompt, master_prompt_file)
            VALUES ('Mushoku Test', 'ja', 'ln_vn', 'Freeform custom system prompt.', 'master_prompt_vn.xml')
            """
        ).lastrowid
        v_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 1, 'Vol 1')",
            (s_id,),
        ).lastrowid
        c1_id = conn.execute(
            """
            INSERT INTO chapters (volume_id, chapter_index, title, raw_text, translated_text, status)
            VALUES (?, 1, 'Ch 1', '序章の本文', 'Dòng một.\nDòng hai.\nDòng ba.\nDòng bốn.', 'completed')
            """,
            (v_id,),
        ).lastrowid
        c2_id = conn.execute(
            """
            INSERT INTO chapters (volume_id, chapter_index, title, raw_text, status)
            VALUES (?, 2, 'Ch 2', 'ルーデウス・グレイラットはノルンと無詠唱の練習をした。危険な暴力表現がある。', 'pending')
            """,
            (v_id,),
        ).lastrowid

        char_rudy = conn.execute(
            "INSERT INTO characters (series_id, canonical_name, display_name, aliases_json) VALUES (?, 'ルーデウス・グレイラット', 'Rudeus Greyrat', '[\"ルディ\"]')",
            (s_id,),
        ).lastrowid
        char_norn = conn.execute(
            "INSERT INTO characters (series_id, canonical_name, display_name, aliases_json) VALUES (?, 'ノルン・グレイラット', 'Norn Greyrat', '[\"ノルン\"]')",
            (s_id,),
        ).lastrowid
        conn.execute(
            "INSERT INTO relationships (series_id, source_char_id, target_char_id, pair_pronoun, is_locked) VALUES (?, ?, ?, 'Anh-Em', 1)",
            (s_id, char_rudy, char_norn),
        )
        conn.execute(
            "INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, term_type, status) VALUES (?, '無詠唱', '無詠唱', 'vô niệm', 'Skill', 'approved')",
            (s_id,),
        )
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )
    return {"series_id": s_id, "volume_id": v_id, "ch1_id": c1_id, "ch2_id": c2_id}


# ---------- 1. Strategy Pattern Tests ----------

def test_translation_strategies_ln_vn_freeform_and_hybrid(isolated_db: Path) -> None:
    ids = _seed_translation_fixture(isolated_db)
    ch2_id = ids["ch2_id"]

    # Mode 1: ln_vn -> master_prompt_vn.xml + <PULSE .../> + <BOOK_CONTEXT> + <INPUT><RAW_TEXT>
    dbg_ln = build_chapter_debug_context(
        ch2_id, TranslationOptions(mode="ln_vn"), db_path=isolated_db
    )
    assert dbg_ln["mode"] == "ln_vn"
    assert dbg_ln["system_instruction_length"] > 1000  # loaded master_prompt_vn.xml
    assert "<PULSE" in dbg_ln["user_prompt"]
    assert "<BOOK_CONTEXT" in dbg_ln["user_prompt"]
    assert "<INPUT>\n<RAW_TEXT>" in dbg_ln["user_prompt"]
    assert "Anh-Em" in dbg_ln["user_prompt"]
    assert "無詠唱" in dbg_ln["user_prompt"]

    # Mode 2: freeform -> custom system_prompt + compact "Gốc = Việt" + Rolling Context
    dbg_free = build_chapter_debug_context(
        ch2_id,
        TranslationOptions(
            mode="freeform",
            hybrid_config=HybridOptions(use_glossary=True, rolling_context_lines=2),
        ),
        db_path=isolated_db,
    )
    assert "Freeform custom system prompt." in dbg_free["system_instruction_preview"]
    assert "無詠唱 = vô niệm" in dbg_free["user_prompt"]
    assert "Dòng ba.\nDòng bốn." in dbg_free["user_prompt"]
    assert "Dòng một." not in dbg_free["rolling_context"]

    # Mode 3: hybrid -> fine-grained toggles (characters ON, glossary & relationships OFF)
    dbg_hyb = build_chapter_debug_context(
        ch2_id,
        TranslationOptions(
            mode="hybrid",
            hybrid_config=HybridOptions(
                use_glossary=False,
                use_characters=True,
                use_relationships=False,
                use_subarc=False,
                rolling_context_lines=0,
            ),
        ),
        db_path=isolated_db,
    )
    assert "<ROSTER>" in dbg_hyb["user_prompt"]
    assert "<GLOSSARY>" not in dbg_hyb["user_prompt"]
    assert "<RELATIONSHIPS>" not in dbg_hyb["user_prompt"]


# ---------- 2. Quality Guard & <FICTION_CONTEXT> Retry Tests ----------

def test_quality_guard_retries_with_fiction_context_and_marks_blocked(isolated_db: Path) -> None:
    ids = _seed_translation_fixture(isolated_db)
    ch2_id = ids["ch2_id"]

    # Case A: Attempt 1 returns short/truncated (<0.3 ratio); Attempt 2 with <FICTION_CONTEXT> succeeds
    seen_prompts: list[str] = []

    class RecoveringModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            seen_prompts.append(contents)
            if len(seen_prompts) == 1:
                return SimpleNamespace(text="Ngắn.")  # ratio < 0.3
            return SimpleNamespace(
                text="Rudeus Greyrat cùng Norn luyện tập ma thuật vô niệm trong sân tập rất chăm chỉ suốt buổi sáng."
            )

    pool_recover = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=RecoveringModels()),
    )
    res_ok = translate_single_chapter(
        ch2_id, TranslationOptions(mode="freeform"), pool=pool_recover, db_path=isolated_db
    )
    assert res_ok["status"] == "completed"
    assert res_ok["retried_with_fiction_context"] is True
    assert len(seen_prompts) == 2
    assert "<FICTION_CONTEXT>" not in seen_prompts[0]
    assert "<FICTION_CONTEXT>" in seen_prompts[1]

    # Case B: Both attempts return empty / tiny output -> status becomes 'blocked'
    class BlockingModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            return SimpleNamespace(text="")

    pool_block = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=BlockingModels()),
    )
    res_blk = translate_single_chapter(
        ch2_id, TranslationOptions(mode="freeform"), pool=pool_block, db_path=isolated_db
    )
    assert res_blk["status"] == "blocked"
    assert res_blk["retried_with_fiction_context"] is True
    with db_session(isolated_db) as conn:
        row = conn.execute("SELECT status, error_message FROM chapters WHERE id = ?", (ch2_id,)).fetchone()
    assert row["status"] == "blocked"
    assert "<FICTION_CONTEXT>" in row["error_message"]


# ---------- 3. Sensitive Masks Scan & Apply Tests ----------

def test_mask_service_scan_apply_preserves_raw_text_and_retranslates(isolated_db: Path) -> None:
    ids = _seed_translation_fixture(isolated_db)
    s_id = ids["series_id"]
    ch2_id = ids["ch2_id"]

    # Global mask CRUD
    m_global = upsert_mask(
        series_id=None, raw_phrase="危険な", safe_replacement="緊迫した", db_path=isolated_db
    )
    assert m_global["series_id"] is None
    assert len(list_masks(s_id, include_global=True, db_path=isolated_db)) == 1

    # Mock Gemini Scan
    class ScanModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "suggestions": [
                            {
                                "raw_phrase": "暴力表現",
                                "safe_replacement": "激しい衝突",
                                "reason": "Từ khóa bạo lực có thể kích hoạt bộ lọc",
                            },
                            {
                                "raw_phrase": "KHÔNG_TỒN_TẠI",
                                "safe_replacement": "Bỏ qua",
                                "reason": "Phải bị lọc vì không có trong raw_text",
                            },
                        ]
                    },
                    ensure_ascii=False,
                )
            )

    scan_pool = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=ScanModels()),
    )
    scan_res = scan_sensitive_phrases(ch2_id, pool=scan_pool, db_path=isolated_db)
    assert len(scan_res["suggestions"]) == 1
    assert scan_res["suggestions"][0]["raw_phrase"] == "暴力表現"

    # Apply masks -> saves to sensitive_masks & writes chapters.masked_raw_text WITHOUT changing raw_text
    app_res = apply_masks_to_chapter(
        ch2_id,
        extra_masks=[{"raw_phrase": "暴力表現", "safe_replacement": "激しい衝突"}],
        save_to_db=True,
        scope="series",
        db_path=isolated_db,
    )
    assert app_res["applied_count"] == 2  # both global '危険な' and series '暴力表現'
    assert "激しい衝突" in app_res["masked_raw_text"]
    assert "緊迫した" in app_res["masked_raw_text"]

    with db_session(isolated_db) as conn:
        ch_row = conn.execute(
            "SELECT raw_text, masked_raw_text FROM chapters WHERE id = ?", (ch2_id,)
        ).fetchone()
    # Original raw_text MUST remain completely untouched
    assert "危険な暴力表現" in ch_row["raw_text"]
    assert "緊迫した激しい衝突" in ch_row["masked_raw_text"]

    # Debug context now confirms using_masked_text=True
    dbg = build_chapter_debug_context(ch2_id, TranslationOptions(mode="freeform"), db_path=isolated_db)
    assert dbg["using_masked_text"] is True
    assert "緊迫した激しい衝突" in dbg["user_prompt"]

    delete_mask(m_global["id"], db_path=isolated_db)
    assert len(list_masks(s_id, include_global=True, db_path=isolated_db)) == 1


# ---------- 4. Background Job Manager & Phase 4 REST API Tests ----------

def test_background_job_checkpoint_and_rest_api(isolated_db: Path, client: TestClient) -> None:
    ids = _seed_translation_fixture(isolated_db)
    v_id = ids["volume_id"]
    ch2_id = ids["ch2_id"]

    class OkModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            return SimpleNamespace(
                text="Rudeus Greyrat cùng em gái Norn luyện tập ma thuật vô niệm đầy tập trung trong sân nhà."
            )

    pool_ok = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=OkModels()),
    )
    mgr = TranslationJobManager()
    mgr.start_job(
        v_id,
        start_chapter=2,
        end_chapter=2,
        options=TranslationOptions(mode="freeform", temperature=0.5),
        pool=pool_ok,
        db_path=isolated_db,
    )

    # Wait briefly for daemon worker thread to complete
    for _ in range(40):
        st = mgr.get_status(v_id, db_path=isolated_db)
        if st["job_state"] in ("completed", "stopped", "error"):
            break
        time.sleep(0.05)

    final_st = mgr.get_status(v_id, db_path=isolated_db)
    assert final_st["job_state"] == "completed"
    assert final_st["counts"]["completed"] == 2
    assert len(final_st["recent_logs"]) >= 2

    # REST API smoke checks
    st_res = client.get(f"/api/volumes/{v_id}/translate/status")
    assert st_res.status_code == 200
    assert st_res.json()["counts"]["completed"] == 2

    dbg_res = client.get(f"/api/chapters/{ch2_id}/debug-context", params={"mode": "hybrid"})
    assert dbg_res.status_code == 200
    assert dbg_res.json()["mode"] == "hybrid"

    mask_res = client.post(
        "/api/masks",
        json={"series_id": ids["series_id"], "raw_phrase": "暴力表現", "safe_replacement": "衝突"},
    )
    assert mask_res.status_code == 201
    mask_id = mask_res.json()["id"]

    apply_res = client.post(
        f"/api/chapters/{ch2_id}/apply-masks",
        json={"extra_masks": [], "save_to_db": False, "scope": "series"},
    )
    assert apply_res.status_code == 200
    assert apply_res.json()["applied_count"] == 1

    assert client.delete(f"/api/masks/{mask_id}").status_code == 204
