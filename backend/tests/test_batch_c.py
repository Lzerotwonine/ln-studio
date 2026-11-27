"""Batch C tests: Task-based Model Routing, EPUB Illustration Extraction + Media API + Export Embedding, Sensitive Masks Bulk/Seed/Pre-mask/Mature BLOCK_NONE, and LN-VN Reference Packs."""

from __future__ import annotations

import base64
import io
import sys
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from ebooklib import epub
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import db_session, init_db
from app.core.gemini_pool import GeminiPool
from app.main import create_app
from app.services.epub_service import get_volume_media_dir, import_book_to_volume
from app.services.export_service import export_volume_docx, export_volume_epub
from app.services.translator_service import (
    TranslationOptions,
    build_chapter_debug_context,
    protect_image_markers,
    restore_image_markers,
    translate_single_chapter,
)

# Valid 1x1 red PNG bytes
SAMPLE_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    db_file = tmp_path / "test_batch_c.db"
    media_dir = tmp_path / "media"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    monkeypatch.setenv("LN_STUDIO_MEDIA_DIR", str(media_dir))
    init_db(db_file)
    return {"db": db_file, "media": media_dir}


@pytest.fixture()
def client(isolated_env: dict[str, Path]) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


def _make_epub_with_image() -> bytes:
    book = epub.EpubBook()
    book.set_identifier("batch-c-img-test")
    book.set_title("LN With Art")
    book.set_language("ja")

    img_item = epub.EpubImage(
        uid="img_cover",
        file_name="images/illust_01.png",
        media_type="image/png",
        content=SAMPLE_PNG_BYTES,
    )
    book.add_item(img_item)

    ch1 = epub.EpubHtml(title="Chương 1", file_name="chap_01.xhtml", lang="ja")
    ch1.content = (
        '<html><head><title>Chương 1</title></head><body>'
        '<h1>Chương 1: Minh họa</h1>'
        '<p>Đoạn văn mở đầu trước tranh minh họa.</p>'
        '<p><img src="images/illust_01.png" alt="Illust 01" /></p>'
        '<p>Đoạn văn kết thúc sau tranh minh họa.</p>'
        '</body></html>'
    )
    book.add_item(ch1)
    book.toc = (epub.Link("chap_01.xhtml", "Chương 1", "ch1"),)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = [ch1]

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        epub.write_epub(str(tmp_path), book)
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)


def test_task_based_model_routing_and_override(
    client: TestClient, isolated_env: dict[str, Path]
) -> None:
    db_file = isolated_env["db"]

    # 1. GET default task_models
    r_get = client.get("/api/settings/task-models")
    assert r_get.status_code == 200
    tasks = r_get.json()["tasks"]
    assert set(tasks.keys()) == {
        "glossary_translate",
        "continuity_map",
        "continuity_reduce",
        "translate_main",
        "sensitive_scan",
        "proofread_retranslate",
    }

    # 2. PUT custom routing
    tasks["continuity_map"] = {
        "primary": "gemini-2.5-flash-lite",
        "fallbacks": ["gemini-2.0-flash"],
    }
    tasks["translate_main"] = {
        "primary": "gemini-2.5-pro",
        "fallbacks": ["gemini-2.5-flash"],
    }
    r_put = client.put("/api/settings/task-models", json={"tasks": tasks})
    assert r_put.status_code == 200
    assert r_put.json()["tasks"]["continuity_map"]["primary"] == "gemini-2.5-flash-lite"

    # 3. Verify GeminiPool routes each task_type to its configured model & respects explicit override
    with db_session(db_file) as conn:
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )

    called_models: list[str] = []

    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            called_models.append(model)
            return SimpleNamespace(text="ok")

    pool = GeminiPool(
        db_path=db_file,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )
    res_map = pool.generate_content("hello", task_type="continuity_map")
    res_main = pool.generate_content("hello", task_type="translate_main")
    res_override = pool.generate_content(
        "hello", task_type="translate_main", models=["gemini-2.0-flash"]
    )

    assert res_map.model_id == "gemini-2.5-flash-lite"
    assert res_main.model_id == "gemini-2.5-pro"
    assert res_override.model_id == "gemini-2.0-flash"
    assert called_models == [
        "gemini-2.5-flash-lite",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
    ]


def test_epub_image_extraction_media_api_marker_preservation_and_export_embedding(
    client: TestClient, isolated_env: dict[str, Path]
) -> None:
    db_file = isolated_env["db"]
    s_id = client.post(
        "/api/series",
        json={"title": "Art Novel", "source_lang": "ja", "translation_mode": "freeform"},
    ).json()["id"]
    v_id = client.post(
        f"/api/series/{s_id}/volumes",
        json={"volume_number": 1, "title": "Quyển 1"},
    ).json()["id"]

    # Import EPUB with embedded PNG illustration
    epub_bytes = _make_epub_with_image()
    imp = import_book_to_volume(v_id, "art_vol1.epub", epub_bytes, db_path=db_file)
    assert imp["chapters_imported"] == 1
    ch_id = imp["chapters"][0]["id"]

    # Verify image was extracted to data/media/vol_{v_id}/ and Markdown tag inserted into raw_text
    media_files = list(get_volume_media_dir(v_id).iterdir())
    assert len(media_files) == 1
    fname = media_files[0].name
    expected_md = f"![image:{fname}](/api/media/vol_{v_id}/{fname})"

    ch_detail = client.get(f"/api/chapters/{ch_id}").json()
    assert expected_md in ch_detail["raw_text"]

    # Verify /api/media/vol_{v_id}/{fname} serves exact PNG bytes
    media_resp = client.get(f"/api/media/vol_{v_id}/{fname}")
    assert media_resp.status_code == 200
    assert media_resp.content == SAMPLE_PNG_BYTES

    # Verify image marker protection & restoration across translation
    protected, imgs = protect_image_markers(ch_detail["raw_text"])
    assert "[[IMAGE_001]]" in protected
    assert imgs == [expected_md]
    restored, missing = restore_image_markers(
        "Đoạn mở đầu đã dịch.\n\n**[[IMAGE_001]]**\n\nĐoạn kết thúc **in đậm**.",
        imgs,
    )
    assert missing == 0
    assert expected_md in restored

    # Save translated markdown containing the image tag and verify DOCX + EPUB embed real image bytes
    client.patch(
        f"/api/chapters/{ch_id}/translation",
        json={"translated_text": restored},
    )

    _, docx_bytes = export_volume_docx(v_id, db_path=db_file)
    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
        word_media = [n for n in zf.namelist() if n.startswith("word/media/")]
        assert len(word_media) == 1

    _, out_epub_bytes = export_volume_epub(v_id, db_path=db_file)
    with zipfile.ZipFile(io.BytesIO(out_epub_bytes)) as zf:
        epub_media = [n for n in zf.namelist() if f"images/{fname}" in n]
        assert len(epub_media) == 1


def test_sensitive_masks_bulk_import_seed_premask_and_mature_block_none(
    client: TestClient, isolated_env: dict[str, Path]
) -> None:
    db_file = isolated_env["db"]
    s_id = client.post(
        "/api/series",
        json={"title": "R19 Test", "source_lang": "ja", "translation_mode": "freeform"},
    ).json()["id"]
    v_id = client.post(
        f"/api/series/{s_id}/volumes",
        json={"volume_number": 1, "title": "Vol 1"},
    ).json()["id"]
    ch_id = client.post(
        f"/api/volumes/{v_id}/chapters",
        json={"title": "Ch 1", "raw_text": "幼女と少女が冒険した。全裸の描写がある。"},
    ).json()["id"]

    with db_session(db_file) as conn:
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )

    # 1. Seed default JA masks from docs/data/seed/sensitive_masks.txt (handles \r and invalid line gracefully)
    seed_res = client.post("/api/masks/seed-default")
    assert seed_res.status_code == 200
    seed_data = seed_res.json()
    assert seed_data["imported"] >= 50
    assert seed_data["skipped"] >= 1  # "痴力 dâm dục" missing '='

    # 2. Bulk import custom rules with source_lang='ja'
    bulk_res = client.post(
        "/api/masks/bulk-import",
        json={
            "text": "冒険した = lên đường phiêu lưu\r\n# comment line\r\nmalformed_no_equals",
            "series_id": s_id,
            "source_lang": "ja",
        },
    )
    assert bulk_res.status_code == 200
    assert bulk_res.json()["imported"] == 1
    assert bulk_res.json()["skipped"] == 1

    # 3. Translate with pre_mask=True and mature_mode=True -> verify safety_settings BLOCK_NONE + <FICTION_CONTEXT> on attempt 1 + raw_text untouched!
    captured: dict[str, object] = {}

    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            captured["contents"] = contents
            captured["config"] = config
            return SimpleNamespace(
                text="Cô bé và thiếu nữ đã lên đường phiêu lưu cùng nhau trong khu rừng rộng lớn đầy kỳ bí."
            )

    pool = GeminiPool(
        db_path=db_file,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )
    res = translate_single_chapter(
        ch_id,
        TranslationOptions(mode="freeform", pre_mask=True, mature_mode=True),
        pool=pool,
        db_path=db_file,
    )
    assert res["status"] == "completed"
    # Pre-mask replaced 幼女 / 全裸 in prompt while raw_text in DB stays original
    prompt_sent = str(captured["contents"])
    assert "<FICTION_CONTEXT>" in prompt_sent
    assert "幼女" not in prompt_sent
    assert "bé gái" in prompt_sent

    cfg = captured["config"]
    safety = getattr(cfg, "safety_settings", None)
    assert safety is not None and len(safety) == 5
    assert all(str(s.threshold).endswith("BLOCK_NONE") for s in safety)

    ch_after = client.get(f"/api/chapters/{ch_id}").json()
    assert "幼女" in ch_after["raw_text"]


def test_ln_vn_reference_packs_seed_crud_and_phase_injection(
    client: TestClient, isolated_env: dict[str, Path]
) -> None:
    db_file = isolated_env["db"]

    # Auto-seeded from data/prompts/ln_vn/references/ during init_db()
    r_list = client.get("/api/references")
    assert r_list.status_code == 200
    refs = r_list.json()
    assert len(refs) >= 5
    primer = next(r for r in refs if r["filename"] == "Library_LOCALIZATION_PRIMER_VN.md")
    kanji_db = next(r for r in refs if r["filename"] == "Library_UNIFIED_KANJI_DATABASE.md")
    assert primer["is_active"] is True
    assert kanji_db["is_active"] is False

    # Upload custom reference file for translate phase
    up = client.post(
        "/api/references/upload",
        files={"file": ("Custom_Style.md", b"# Custom LN-VN Rule\nCUSTOM_MARKER_XYZ", "text/markdown")},
        data={
            "pack_name": "Custom Pack",
            "use_in_summary": "false",
            "use_in_translate": "true",
            "is_active": "true",
        },
    )
    assert up.status_code == 201
    custom_id = up.json()["id"]

    # Create ln_vn series + chapter and inspect debug context -> must contain <REFERENCE_PACKS> and CUSTOM_MARKER_XYZ
    s_id = client.post(
        "/api/series",
        json={"title": "LN-VN Ref Test", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()["id"]
    v_id = client.post(
        f"/api/series/{s_id}/volumes",
        json={"volume_number": 1, "title": "Vol 1"},
    ).json()["id"]
    ch_id = client.post(
        f"/api/volumes/{v_id}/chapters",
        json={"title": "Ch 1", "raw_text": "本文テスト"},
    ).json()["id"]

    dbg = build_chapter_debug_context(ch_id, TranslationOptions(mode="ln_vn"), db_path=db_file)
    assert dbg["system_instruction_length"] > 10000

    # Deactivate custom file and delete it cleanly
    pat = client.patch(f"/api/references/{custom_id}", json={"is_active": False})
    assert pat.status_code == 200
    assert pat.json()["is_active"] is False
    del_r = client.delete(f"/api/references/{custom_id}")
    assert del_r.status_code == 204
