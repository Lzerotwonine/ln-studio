"""Batch D tests: Glossary NFD header mapping + import preview, EPUB relative images/ + source_html + TOC/cover, Model Discover/Test, and Web Translation endpoints."""

from __future__ import annotations

import base64
import io
import json
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

from app.api import settings as settings_api
from app.core.database import DEFAULT_MODELS, db_session, init_db
from app.main import create_app
from app.services.epub_service import get_volume_media_dir, import_book_to_volume
from app.services.export_service import export_volume_docx, export_volume_epub

SAMPLE_PNG_1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
SAMPLE_PNG_2 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    db_file = tmp_path / "test_batch_d.db"
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


def _make_rich_epub_with_cover_and_ruby() -> bytes:
    book = epub.EpubBook()
    book.set_identifier("batch-d-rich-epub")
    book.set_title("Rich Reader Novel")
    book.set_language("ja")

    # Dedicated cover image (not referenced in spine XHTML)
    book.set_cover("images/book_cover.png", SAMPLE_PNG_2, create_page=False)

    img_item = epub.EpubImage(
        uid="img_scene",
        file_name="images/scene_01.png",
        media_type="image/png",
        content=SAMPLE_PNG_1,
    )
    book.add_item(img_item)

    ch1 = epub.EpubHtml(title="Raw Filename Title", file_name="text/ch01.xhtml", lang="ja")
    ch1.content = (
        '<html><head><title>HTML Title</title><style>body{color:red}</style></head><body>'
        '<script>alert("xss")</script>'
        '<h1 onclick="evil()">Ignored Heading</h1>'
        '<p>これは<ruby>魔導書<rt>まどうしょ</rt></ruby>と<strong>強調</strong>の物語。</p>'
        '<blockquote>「引用テスト」</blockquote>'
        '<p><img src="../images/scene_01.png" alt="Scene 01" onerror="bad()" /></p>'
        '<hr/>'
        '<p>最後の段落。</p>'
        '</body></html>'
    )
    book.add_item(ch1)
    # TOC gives the authoritative chapter title
    book.toc = (epub.Link("text/ch01.xhtml", "Chương 1: Mục lục ưu tiên", "ch1"),)
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


def test_glossary_vietnamese_header_mapping_and_import_preview(
    client: TestClient,
) -> None:
    s_id = client.post(
        "/api/series",
        json={"title": "Header Map Test", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()["id"]

    tsv_content = (
        "\ufeffTừ gốc tiếng Nhật\tDịch nghĩa\tPhiên âm\tPhiên âm Hán-Việt\tTiếng Anh (Gốc/Tương đương)\tLoại\n"
        "魔導書\tMa đạo thư\tmadousho\tMa Đạo Thư\tGrimoire\tItem\n"
        "聖剣\tThánh kiếm\tseiken\tThánh Kiếm\tHoly Sword\tItem\n"
        "冒険者\tMạo hiểm giả\tboukensha\tMạo Hiểm Giả\tAdventurer\tTitle\n"
        "王都\tVương đô\touto\tVương Đô\tRoyal Capital\tPlace\n"
    ).encode("utf-8")

    # 1. Preview endpoint auto-detects every single Vietnamese Excel header accurately
    prev = client.post(
        f"/api/series/{s_id}/glossary/import-preview",
        files={"file": ("excel_terms.tsv", tsv_content, "text/tab-separated-values")},
    )
    assert prev.status_code == 200
    pdata = prev.json()
    assert pdata["has_header"] is True
    assert pdata["total_rows"] == 4
    assert len(pdata["sample_rows"]) == 3
    m = pdata["suggested_mapping"]
    assert m["source_term"] == 0
    assert m["vi_term"] == 1
    assert m["reading"] == 2
    assert m["han_viet"] == 3
    assert m["english_meaning"] == 4
    assert m["term_type"] == 5

    # 2. Import using auto-detected mapping preserves han_viet and english_meaning
    imp = client.post(
        f"/api/series/{s_id}/glossary/import",
        files={"file": ("excel_terms.tsv", tsv_content, "text/tab-separated-values")},
        data={"default_status": "approved", "duplicate_mode": "upsert"},
    )
    assert imp.status_code == 200
    assert imp.json()["imported"] == 4

    items = client.get(f"/api/series/{s_id}/glossary").json()["items"]
    by_src = {it["source_term"]: it for it in items}
    assert by_src["魔導書"]["vi_term"] == "Ma đạo thư"
    assert by_src["魔導書"]["reading"] == "madousho"
    assert by_src["魔導書"]["han_viet"] == "Ma Đạo Thư"
    assert by_src["魔導書"]["english_meaning"] == "Grimoire"

    # 3. Custom column_mapping_json override works cleanly
    custom_csv = "ColA,ColB,ColC,ColD\n賢者,Hiền giả,Hiền Giả,Sage\n".encode("utf-8")
    override_map = json.dumps(
        {"source_term": 0, "vi_term": 1, "han_viet": 2, "english_meaning": 3}
    )
    imp2 = client.post(
        f"/api/series/{s_id}/glossary/import",
        files={"file": ("custom.csv", custom_csv, "text/csv")},
        data={
            "default_status": "approved",
            "duplicate_mode": "upsert",
            "column_mapping_json": override_map,
            "has_header": "true",
        },
    )
    assert imp2.status_code == 200
    assert imp2.json()["imported"] == 1
    items2 = client.get(f"/api/series/{s_id}/glossary?search=賢者").json()["items"]
    assert len(items2) == 1
    assert items2[0]["han_viet"] == "Hiền Giả"
    assert items2[0]["english_meaning"] == "Sage"


def test_epub_relative_images_source_html_toc_cover_and_backward_compat_export(
    client: TestClient, isolated_env: dict[str, Path]
) -> None:
    db_file = isolated_env["db"]
    s_id = client.post(
        "/api/series",
        json={"title": "EPUB Clean Test", "source_lang": "ja", "translation_mode": "freeform"},
    ).json()["id"]
    v_id = client.post(
        f"/api/series/{s_id}/volumes",
        json={"volume_number": 1, "title": "Quyển 1"},
    ).json()["id"]

    imp = import_book_to_volume(
        v_id, "rich_book.epub", _make_rich_epub_with_cover_and_ruby(), db_path=db_file
    )
    # Cover chapter + Chapter 1
    assert imp["chapters_imported"] == 2
    assert imp["chapters"][0]["title"] == "Bìa sách"
    assert imp["chapters"][1]["title"] == "Chương 1: Mục lục ưu tiên"

    ch1_id = imp["chapters"][1]["id"]
    proof = client.get(f"/api/chapters/{ch1_id}/proofread").json()

    # raw_text must use clean relative path images/... and NEVER /api/media/
    assert "](images/" in proof["raw_text"]
    assert "/api/media/" not in proof["raw_text"]

    # source_html must preserve <ruby>, <blockquote>, <strong>, <hr/>, relative images/, and strip <script>/<style>/onclick
    sh = proof["source_html"]
    assert "<ruby>" in sh and "<rt>まどうしょ</rt>" in sh
    assert "<blockquote>" in sh
    assert "<strong>強調</strong>" in sh
    assert 'src="images/' in sh
    assert "<script" not in sh.lower()
    assert "<style" not in sh.lower()
    assert "onclick" not in sh.lower()
    assert "onerror" not in sh.lower()

    # Export DOCX & EPUB works with BOTH clean images/ AND legacy /api/media/vol_X/ paths
    media_files = sorted(f.name for f in get_volume_media_dir(v_id).iterdir())
    assert len(media_files) == 2
    f_cover, f_scene = media_files[0], media_files[1]
    mixed_translation = (
        f"Đoạn một.\n\n"
        f"![image:{f_cover}](images/{f_cover})\n\n"
        f"Đoạn hai tương thích ngược.\n\n"
        f"![image:{f_scene}](/api/media/vol_{v_id}/{f_scene})\n"
    )
    client.patch(
        f"/api/chapters/{ch1_id}/translation",
        json={"translated_text": mixed_translation},
    )

    _, docx_bytes = export_volume_docx(v_id, db_path=db_file)
    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
        word_media = [n for n in zf.namelist() if n.startswith("word/media/")]
        assert len(word_media) == 2

    _, epub_bytes = export_volume_epub(v_id, db_path=db_file)
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as zf:
        epub_media = [n for n in zf.namelist() if "images/" in n]
        assert len(epub_media) == 2


def test_modern_default_models_discover_and_live_probe(
    client: TestClient, isolated_env: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    db_file = isolated_env["db"]
    assert "gemini-flash-latest" in DEFAULT_MODELS
    assert "gemini-flash-lite-latest" in DEFAULT_MODELS
    assert "gemini-2.0-flash" not in DEFAULT_MODELS

    with db_session(db_file) as conn:
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_LIVE', 'secret-live', 1)"
        )

    fake_models = [
        SimpleNamespace(
            name="models/gemini-flash-latest",
            display_name="Gemini Flash Latest",
            description="Latest Flash alias",
            supported_actions=["generateContent"],
            input_token_limit=1048576,
            output_token_limit=65536,
        ),
        SimpleNamespace(
            name="models/gemini-3-flash-preview",
            display_name="Gemini 3 Flash Preview",
            description="Next-gen Flash",
            supported_actions=["generateContent"],
            input_token_limit=1048576,
            output_token_limit=65536,
        ),
        SimpleNamespace(
            name="models/text-embedding-004",
            display_name="Embedding",
            description="Should be filtered out",
            supported_actions=["embedContent"],
            input_token_limit=2048,
            output_token_limit=0,
        ),
    ]

    class FakeModelsApi:
        def list(self):
            return fake_models

        def generate_content(self, *, model: str, contents: str, config=None):
            if model == "gemini-broken":
                raise RuntimeError("404 NOT_FOUND: model not supported")
            return SimpleNamespace(text="OK")

    monkeypatch.setattr(
        settings_api,
        "_build_genai_client",
        lambda _k: SimpleNamespace(models=FakeModelsApi()),
    )

    disc = client.post("/api/settings/models/discover")
    assert disc.status_code == 200
    ddata = disc.json()
    assert ddata["key_used"] == "KEY_LIVE"
    ids = [m["id"] for m in ddata["models"]]
    assert ids == ["gemini-flash-latest", "gemini-3-flash-preview"]

    ok_probe = client.post("/api/settings/models/test", json={"model": "gemini-flash-latest"})
    assert ok_probe.status_code == 200
    assert ok_probe.json()["ok"] is True
    assert ok_probe.json()["reply_preview"] == "OK"

    bad_probe = client.post("/api/settings/models/test", json={"model": "gemini-broken"})
    assert bad_probe.status_code == 200
    assert bad_probe.json()["ok"] is False
    assert "404" in (bad_probe.json()["error"] or "")


def test_web_translation_prompt_and_import_flow(
    client: TestClient,
) -> None:
    s_id = client.post(
        "/api/series",
        json={"title": "Web Trans Novel", "source_lang": "ja", "translation_mode": "freeform"},
    ).json()["id"]
    v_id = client.post(
        f"/api/series/{s_id}/volumes",
        json={"volume_number": 1, "title": "Vol 1"},
    ).json()["id"]
    client.post(
        "/api/masks",
        json={
            "series_id": s_id,
            "source_lang": "ja",
            "raw_phrase": "危険語",
            "safe_replacement": "cụm an toàn",
        },
    )
    ch_id = client.post(
        f"/api/volumes/{v_id}/chapters",
        json={
            "title": "Chương 1",
            "raw_text": "危険語を含む冒頭文。\n\n![image:art_01.png](images/art_01.png)\n\n結びの文。",
        },
    ).json()["id"]

    # 1. Build web prompt package with pre_mask + mature_mode
    wp = client.post(
        f"/api/chapters/{ch_id}/web-prompt",
        json={"mode": "freeform", "pre_mask": True, "mature_mode": True},
    )
    assert wp.status_code == 200
    wdata = wp.json()
    assert wdata["pre_masked_count"] == 1
    assert "[[IMAGE_001]]" in wdata["user_prompt"]
    assert "[[IMAGE_001]]" in wdata["combined_prompt"]
    assert "<FICTION_CONTEXT>" in wdata["user_prompt"]
    assert "cụm an toàn" in wdata["user_prompt"]
    assert "危険語" not in wdata["user_prompt"]
    assert wdata["protected_images"] == ["![image:art_01.png](images/art_01.png)"]

    # 2. Import pasted translation (wrapped in ```markdown fence) -> restores image & computes ratio
    pasted = "```markdown\nCâu mở đầu có cụm an toàn.\n\n[[IMAGE_001]]\n\nCâu kết thúc hoàn chỉnh.\n```"
    wi = client.post(
        f"/api/chapters/{ch_id}/web-import",
        json={"translated_text": pasted},
    )
    assert wi.status_code == 200
    widata = wi.json()
    assert widata["status"] == "completed"
    assert widata["restored_images_count"] == 1
    assert widata["missing_images_count"] == 0
    assert widata["char_ratio"] > 0.5

    ch_after = client.get(f"/api/chapters/{ch_id}").json()
    assert "![image:art_01.png](images/art_01.png)" in ch_after["translated_text"]
    assert "```" not in ch_after["translated_text"]
    assert "危険語" in ch_after["raw_text"]  # raw_text stays untouched!
