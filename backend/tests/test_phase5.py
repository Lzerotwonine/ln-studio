"""Phase 5 tests: Publication DOCX/EPUB export, Volume Find & Replace (literal/Regex), Selection Retranslation, and Proofread REST APIs."""

from __future__ import annotations

import io
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import ebooklib
import pytest
from docx import Document
from docx.shared import Pt
from ebooklib import epub
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import db_session, init_db
from app.core.gemini_pool import GeminiPool
from app.main import create_app
from app.services.export_service import (
    export_volume_docx,
    export_volume_epub,
    find_replace_volume,
    get_chapter_proofread_data,
    retranslate_selection,
    save_chapter_translation,
)


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_phase5.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


def _seed_proofread_fixture(db_file: Path) -> dict[str, int]:
    with db_session(db_file) as conn:
        s_id = conn.execute(
            "INSERT INTO series (title, source_lang, translation_mode) VALUES ('Mushoku Tensei', 'ja', 'ln_vn')"
        ).lastrowid
        v_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 13, 'Thời thanh niên')",
            (s_id,),
        ).lastrowid
        c1_id = conn.execute(
            """
            INSERT INTO chapters (volume_id, chapter_index, title, raw_text, translated_text, status)
            VALUES (
                ?, 1, 'Khởi đầu ngày mới',
                'ルーデウスは無詠唱でファイアボールを放った。',
                'Rudeus tung ra Hỏa Cầu bằng vô niệm.\nSylphy mỉm cười nhìn anh.',
                'completed'
            )
            """,
            (v_id,),
        ).lastrowid
        c2_id = conn.execute(
            """
            INSERT INTO chapters (volume_id, chapter_index, title, raw_text, translated_text, status)
            VALUES (
                ?, 2, 'Buổi chiều ở Sharia',
                'シルフィは魔法大学へ向かった。',
                'Sylphy bước tới Đại học Ma thuật.\nSylphy vẫy tay chào.',
                'completed'
            )
            """,
            (v_id,),
        ).lastrowid
        conn.execute(
            """
            INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, reading, han_viet, term_type, status)
            VALUES (?, '無詠唱', '無詠唱', 'vô niệm', 'mueishou', 'Vô Vịnh Xướng', 'Skill', 'approved')
            """,
            (s_id,),
        )
        conn.execute(
            """
            INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, reading, han_viet, term_type, status)
            VALUES (?, 'ファイアボール', 'ファイアボール', 'Hỏa Cầu', 'faiabooru', '', 'Skill', 'approved')
            """,
            (s_id,),
        )
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )
    return {"series_id": s_id, "volume_id": v_id, "ch1_id": c1_id, "ch2_id": c2_id}


def test_export_volume_docx_formatting_and_headings(isolated_db: Path) -> None:
    ids = _seed_proofread_fixture(isolated_db)
    filename, docx_bytes = export_volume_docx(
        ids["volume_id"], font_name="Cambria", db_path=isolated_db
    )
    assert filename == "Mushoku_Tensei_Vol13.docx"
    assert len(docx_bytes) > 1000

    doc = Document(io.BytesIO(docx_bytes))
    normal_style = doc.styles["Normal"]
    assert normal_style.font.name == "Cambria"
    assert normal_style.font.size == Pt(13)
    assert normal_style.paragraph_format.line_spacing == pytest.approx(1.3)
    assert normal_style.paragraph_format.first_line_indent is not None
    assert normal_style.paragraph_format.first_line_indent > 0

    headings = [p.text for p in doc.paragraphs if p.style.name == "Heading 1"]
    assert len(headings) == 2
    assert "Khởi đầu ngày mới" in headings[0]
    assert "Buổi chiều ở Sharia" in headings[1]

    # Verify page breaks exist between chapters
    xml_body = doc.element.body.xml
    assert 'w:type="page"' in xml_body


def test_export_volume_epub_has_toc_and_chapters(isolated_db: Path) -> None:
    ids = _seed_proofread_fixture(isolated_db)
    filename, epub_bytes = export_volume_epub(ids["volume_id"], db_path=isolated_db)
    assert filename == "Mushoku_Tensei_Vol13.epub"
    assert len(epub_bytes) > 500

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(epub_bytes)
        tmp_path = Path(tmp.name)
    try:
        book = epub.read_epub(str(tmp_path))
        docs = [i for i in book.get_items_of_type(ebooklib.ITEM_DOCUMENT) if i.get_name().startswith("chap_")]
        assert len(docs) == 2
        assert len(book.toc) == 2
        ch1_html = docs[0].get_content().decode("utf-8")
        assert "Rudeus tung ra Hỏa Cầu" in ch1_html
    finally:
        tmp_path.unlink(missing_ok=True)


def test_find_replace_volume_literal_and_regex(isolated_db: Path) -> None:
    ids = _seed_proofread_fixture(isolated_db)
    v_id = ids["volume_id"]

    # Dry run first -> counts matches without modifying DB
    preview = find_replace_volume(
        v_id, "Sylphy", "Sylphiette", use_regex=False, dry_run=True, db_path=isolated_db
    )
    assert preview["dry_run"] is True
    assert preview["total_matches"] == 3
    assert preview["chapters_affected"] == 2

    # Confirm DB untouched after dry run
    ch1_before = get_chapter_proofread_data(ids["ch1_id"], db_path=isolated_db)
    assert "Sylphy" in ch1_before["translated_text"]

    # Regex apply -> replace word boundary \bSylphy\b with Sylphiette
    applied = find_replace_volume(
        v_id, r"\bSylphy\b", "Sylphiette", use_regex=True, dry_run=False, db_path=isolated_db
    )
    assert applied["total_matches"] == 3
    ch1_after = get_chapter_proofread_data(ids["ch1_id"], db_path=isolated_db)
    ch2_after = get_chapter_proofread_data(ids["ch2_id"], db_path=isolated_db)
    assert "Sylphiette mỉm cười" in ch1_after["translated_text"]
    assert ch2_after["translated_text"].count("Sylphiette") == 2


def test_proofread_highlights_autosave_and_retranslate_selection(isolated_db: Path) -> None:
    ids = _seed_proofread_fixture(isolated_db)
    ch1_id = ids["ch1_id"]

    data = get_chapter_proofread_data(ch1_id, db_path=isolated_db)
    hl_terms = {h["source_term"]: h for h in data["glossary_highlights"]}
    assert "無詠唱" in hl_terms
    assert hl_terms["無詠唱"]["han_viet"] == "Vô Vịnh Xướng"
    assert "ファイアボール" in hl_terms

    # Auto-save translation
    saved = save_chapter_translation(
        ch1_id, "Rudeus thi triển Hỏa Cầu không niệm chú.", db_path=isolated_db
    )
    assert saved["status"] == "completed"
    assert saved["char_ratio"] > 0

    # Retranslate highlighted selection with mock Gemini
    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            assert "Vô Vịnh Xướng" not in contents or "無詠唱" in contents
            return SimpleNamespace(text="Rudeus phóng ra quả Hỏa Cầu bằng ma thuật vô niệm.")

    fake_pool = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )
    rt = retranslate_selection(
        ch1_id,
        "Rudeus thi triển Hỏa Cầu không niệm chú.",
        source_side="translated",
        instruction="Làm câu văn uyển chuyển hơn",
        pool=fake_pool,
        db_path=isolated_db,
    )
    assert "ma thuật vô niệm" in rt["retranslated_text"]


def test_phase5_rest_api_endpoints(isolated_db: Path, client: TestClient) -> None:
    ids = _seed_proofread_fixture(isolated_db)
    v_id = ids["volume_id"]
    ch1_id = ids["ch1_id"]

    # GET proofread data
    pr_res = client.get(f"/api/chapters/{ch1_id}/proofread")
    assert pr_res.status_code == 200
    assert len(pr_res.json()["glossary_highlights"]) == 2

    # PATCH translation (auto-save)
    sv_res = client.patch(
        f"/api/chapters/{ch1_id}/translation",
        json={"translated_text": "Bản dịch đã hiệu đính của Chương 1.\nSylphy cười."},
    )
    assert sv_res.status_code == 200
    assert sv_res.json()["translated_chars"] > 10

    # POST find-replace
    fr_res = client.post(
        f"/api/volumes/{v_id}/find-replace",
        json={
            "find_text": "Sylphy",
            "replace_text": "Sylphiette",
            "use_regex": False,
            "case_sensitive": True,
            "dry_run": False,
        },
    )
    assert fr_res.status_code == 200
    assert fr_res.json()["total_matches"] == 3

    # GET export docx & epub
    docx_res = client.get(f"/api/volumes/{v_id}/export/docx", params={"font": "Times New Roman"})
    assert docx_res.status_code == 200
    assert "wordprocessingml.document" in docx_res.headers["content-type"]
    assert "Mushoku_Tensei_Vol13.docx" in docx_res.headers["content-disposition"]

    epub_res = client.get(f"/api/volumes/{v_id}/export/epub")
    assert epub_res.status_code == 200
    assert "epub+zip" in epub_res.headers["content-type"]
    assert "Mushoku_Tensei_Vol13.epub" in epub_res.headers["content-disposition"]
