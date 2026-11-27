"""Phase 2 smoke & unit tests: EPUB/TXT/DOCX import, JA/ZH/KO NLP plugins, and Master Glossary."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import pytest
from docx import Document
from ebooklib import epub
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import db_session, init_db
from app.core.gemini_pool import GeminiPool
from app.main import create_app
from app.services.epub_service import import_book_to_volume, parse_uploaded_book
from app.services.glossary_service import (
    export_glossary_tabular,
    extract_volume_glossary,
    import_glossary_tabular,
    render_glossary_xml,
    translate_new_glossary_terms,
)
from app.services.languages import get_language_plugin


def _make_sample_epub_bytes() -> bytes:
    book = epub.EpubBook()
    book.set_identifier("ln-studio-test-001")
    book.set_title("Test Light Novel")
    book.set_language("ja")

    c1 = epub.EpubHtml(title="第一章 旅立ち", file_name="chap_01.xhtml", lang="ja")
    c1.content = """
    <html><head><title>第一章 旅立ち</title></head><body>
      <h1>第一章 旅立ち</h1>
      <p>これは<ruby>魔<rt>ま</rt></ruby><ruby>法<rt>ほう</rt></ruby>の物語だ。</p>
      <blockquote>「<ruby>化<rt>ば</rt></ruby>け<ruby>物<rt>もの</rt></ruby>が来たぞ！」と叫んだ。</blockquote>
      <p><em><ruby>大英雄<rt>だいえいゆう</rt></ruby></em>と<strong><ruby>御神体<rt>ごしんたい</rt></ruby></strong>。</p>
      <table><tr><td><ruby>聖剣<rt>せいけん</rt></ruby></td><td><a href="#x"><ruby>魔導具<rt>まどうぐ</rt></ruby></a></td></tr></table>
    </body></html>
    """

    c2 = epub.EpubHtml(title="第二章 激闘", file_name="chap_02.xhtml", lang="ja")
    c2.content = """
    <html><head><title>第二章 激闘</title></head><body>
      <h1>第二章 激闘</h1>
      <p>「《ファイアボール》を放て！」と魔法使いが叫んだ。</p>
      <p>ゴブリン・ロードが現れた。</p>
    </body></html>
    """

    # Add c2 before c1, then set explicit spine order [c1, c2] to verify spine ordering is respected
    book.add_item(c2)
    book.add_item(c1)
    book.toc = (epub.Link("chap_01.xhtml", "第一章 旅立ち", "c1"), epub.Link("chap_02.xhtml", "第二章 激闘", "c2"))
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = [c1, c2]

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        epub.write_epub(str(tmp_path), book)
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)


def _make_sample_docx_bytes() -> bytes:
    doc = Document()
    doc.add_heading("Chapter 1 Beginning", level=1)
    doc.add_paragraph("「大英雄のファイアボール！」と魔法使いが叫んだ。")
    doc.add_paragraph("化け物と新入りが森で戦う。")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_phase2.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


# ---------- 1. EPUB / TXT / DOCX Import Tests ----------

def test_epub_spine_order_and_all_ruby_parents() -> None:
    epub_bytes = _make_sample_epub_bytes()

    # Keep furigana ON
    chapters = parse_uploaded_book(
        "novel.epub", epub_bytes, split_mode="epub_chapters", keep_furigana=True
    )
    assert len(chapters) == 2
    assert chapters[0].title == "第一章 旅立ち"
    assert chapters[1].title == "第二章 激闘"

    ch1 = chapters[0].raw_text
    # Adjacent <ruby> merged
    assert "魔法（まほう）" in ch1
    # Ruby + kana bridge inside <blockquote>
    assert "化け物（ばけもの）" in ch1
    # Ruby inside <em>, <strong>, <td>, <a>
    assert "大英雄（だいえいゆう）" in ch1
    assert "御神体（ごしんたい）" in ch1
    assert "聖剣（せいけん）" in ch1
    assert "魔導具（まどうぐ）" in ch1

    # Keep furigana OFF
    chapters_plain = parse_uploaded_book(
        "novel.epub", epub_bytes, split_mode="epub_chapters", keep_furigana=False
    )
    ch1_plain = chapters_plain[0].raw_text
    assert "魔法" in ch1_plain and "（まほう）" not in ch1_plain
    assert "化け物" in ch1_plain and "（ばけもの）" not in ch1_plain
    assert "大英雄" in ch1_plain and "御神体" in ch1_plain


def test_chunk_splitting_paragraph_boundaries_and_txt_docx() -> None:
    # Build ~9,500 chars across clear paragraphs
    para = "これはテスト段落です。" * 25  # 275 chars each
    long_txt = "\n\n".join(f"段落{i}: {para}" for i in range(1, 36))
    chunks = parse_uploaded_book(
        "long.txt",
        long_txt.encode("utf-8"),
        split_mode="chunk_chars",
        chunk_min=4000,
        chunk_max=5000,
    )
    assert len(chunks) >= 2
    for ch in chunks[:-1]:
        assert 4000 <= len(ch.raw_text) <= 5000
    # Verify no paragraph was torn mid-sentence
    assert all(ch.raw_text.endswith("。") for ch in chunks)

    # DOCX import
    docx_chapters = parse_uploaded_book("sample.docx", _make_sample_docx_bytes())
    assert len(docx_chapters) == 1
    assert "大英雄" in docx_chapters[0].raw_text
    assert "魔法使い" in docx_chapters[0].raw_text


# ---------- 2. JA / ZH / KO Language Plugin Tests ----------

def test_ja_plugin_comprehensive_extraction() -> None:
    sample_ja = """
    「大英雄のファイアボールをくらえ！」と新入りが叫んだ。
    《魔法（まほう）》と〈聖剣〉、そして『御神体』が光る。
    【ゴブリン・ロード】と≪魔神語≫、［第二次］大戦の記憶。（紅蓮騎士団）が集結した。
    熟練の魔法使いが化け物を倒し、ストーンキャノンを放つ。
    《龍》は伝説の生き物だ。魔が満ち、魔が溢れ、魔が響き、魔が渦巻き、魔が弾ける。
    """
    plugin = get_language_plugin("ja")
    terms = plugin.extract_terms([sample_ja], min_freq=1)
    by_key = {t.normalized_key: t for t in terms}

    # Dialogue 「...」 content NOT deleted
    assert "大英雄" in by_key
    assert "ファイアボール" in by_key

    # All bracket types including furigana inside brackets
    assert "魔法" in by_key and by_key["魔法"].in_brackets
    assert "聖剣" in by_key
    assert "御神体" in by_key
    assert "ゴブリン・ロード" in by_key
    assert "魔神語" in by_key
    assert "第二次" in by_key
    assert "紅蓮騎士団" in by_key

    # Single-char Kanji kept when in brackets OR high frequency (>= 5)
    assert "龍" in by_key and by_key["龍"].in_brackets
    assert "魔" in by_key and by_key["魔"].freq >= 5

    # POS-independent Katakana intact (and no fragmented sub-tokens from Sudachi)
    assert "ストーンキャノン" in by_key
    assert "ファイア" not in by_key
    assert "ボール" not in by_key
    assert "ゴブリン" not in by_key

    # Kanji + Hiragana compounds
    assert "魔法使い" in by_key
    assert "化け物" in by_key
    assert "新入り" in by_key


def test_zh_plugin_extraction() -> None:
    sample_zh = (
        "林动运转《九转玄功》，踏入【青云宗】的“太虚圣地”。"
        "青云宗长老看着林动突破元婴期，惊叹不已。"
    )
    plugin = get_language_plugin("zh")
    terms = plugin.extract_terms([sample_zh], min_freq=1)
    keys = {t.normalized_key for t in terms}
    assert "九转玄功" in keys
    assert "青云宗" in keys
    assert "太虚圣地" in keys


def test_ko_plugin_extraction() -> None:
    sample_ko = (
        "성진우는 [그림자 추출] 스킬을 발동하여 던전에서 마정석을 획득했다. "
        "헌터협회는 성진우의 각성을 주목했다."
    )
    plugin = get_language_plugin("ko")
    terms = plugin.extract_terms([sample_ko], min_freq=1)
    keys = {t.normalized_key for t in terms}
    assert "그림자 추출" in keys
    # Particles stripped cleanly by kiwipiepy
    assert "성진우" in keys or "마정석" in keys or "던전" in keys
    assert "던전에서" not in keys
    assert "마정석을" not in keys


# ---------- 3. Master Glossary Service Tests ----------

def test_glossary_extract_idempotent_and_gemini_3_round_reconciliation(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        s_id = conn.execute(
            "INSERT INTO series (title, source_lang, translation_mode) VALUES ('Test JA', 'ja', 'ln_vn')"
        ).lastrowid
        v1_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 1, 'Vol 1')",
            (s_id,),
        ).lastrowid
        v2_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 2, 'Vol 2')",
            (s_id,),
        ).lastrowid
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )

    import_book_to_volume(
        v1_id,
        "vol1.txt",
        "《ファイアボール》と《魔法使い》と《化け物》が登場した。ファイアボールは強力だ。".encode("utf-8"),
        db_path=isolated_db,
    )
    res1 = extract_volume_glossary(v1_id, db_path=isolated_db)
    assert res1["new_terms"] >= 3

    # Re-running extract on Vol 1 must be idempotent (not double total_freq)
    with db_session(isolated_db) as conn:
        freq_before = conn.execute(
            "SELECT total_freq FROM glossary_terms WHERE series_id = ? AND normalized_key = 'ファイアボール'",
            (s_id,),
        ).fetchone()["total_freq"]
    extract_volume_glossary(v1_id, db_path=isolated_db)
    with db_session(isolated_db) as conn:
        freq_after = conn.execute(
            "SELECT total_freq FROM glossary_terms WHERE series_id = ? AND normalized_key = 'ファイアボール'",
            (s_id,),
        ).fetchone()["total_freq"]
    assert freq_before == freq_after == 2

    # Mark one term as approved so Gemini translation MUST skip it
    with db_session(isolated_db) as conn:
        conn.execute(
            "UPDATE glossary_terms SET vi_term = 'Quái vật', status = 'approved' WHERE series_id = ? AND normalized_key = '化け物'",
            (s_id,),
        )

    # Mock GeminiPool: Round 1 deliberately omits '魔法使い'; Round 2 translates the missing term!
    prompts_seen: list[str] = []

    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            prompts_seen.append(contents)
            if len(prompts_seen) == 1:
                # Translate everything except 魔法使い on round 1
                payload = [
                    {
                        "source_term": "ファイアボール",
                        "reading": "Faiabooru",
                        "english_meaning": "Fireball",
                        "han_viet": "",
                        "vi_term": "Hỏa Cầu",
                        "term_type": "Skill",
                    }
                ]
            else:
                payload = [
                    {
                        "source_term": "魔法使い",
                        "reading": "mahoutsukai",
                        "english_meaning": "mage",
                        "han_viet": "Ma Pháp Sử",
                        "vi_term": "Pháp sư",
                        "term_type": "Title",
                    }
                ]
            return SimpleNamespace(text=json.dumps(payload, ensure_ascii=False))

    fake_pool = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )

    tr_res = translate_new_glossary_terms(
        s_id, volume_id=v1_id, batch_size=300, max_rounds=3, pool=fake_pool, db_path=isolated_db
    )
    assert tr_res["rounds_used"] >= 2
    assert tr_res["translated_count"] >= 2
    # Approved term '化け物' must NOT have been sent to Gemini
    assert all("化け物" not in p for p in prompts_seen)
    # Round 2 must NOT re-send already-translated 'ファイアボール'
    assert "ファイアボール" not in prompts_seen[1]

    with db_session(isolated_db) as conn:
        mage_row = conn.execute(
            "SELECT vi_term, han_viet, term_type, status FROM glossary_terms WHERE series_id = ? AND normalized_key = '魔法使い'",
            (s_id,),
        ).fetchone()
    assert mage_row["vi_term"] == "Pháp sư"
    assert mage_row["han_viet"] == "Ma Pháp Sử"
    assert mage_row["term_type"] == "Title"
    assert mage_row["status"] == "translated"

    # Extract Vol 2 containing 'ファイアボール' once -> total_freq becomes 3
    import_book_to_volume(
        v2_id,
        "vol2.txt",
        "《ファイアボール》と《聖剣》が輝く。".encode("utf-8"),
        db_path=isolated_db,
    )
    extract_volume_glossary(v2_id, db_path=isolated_db)
    with db_session(isolated_db) as conn:
        fb_total = conn.execute(
            "SELECT total_freq, status FROM glossary_terms WHERE series_id = ? AND normalized_key = 'ファイアボール'",
            (s_id,),
        ).fetchone()
        sword_row = conn.execute(
            "SELECT first_seen_vol, status FROM glossary_terms WHERE series_id = ? AND normalized_key = '聖剣'",
            (s_id,),
        ).fetchone()
    assert fb_total["total_freq"] == 3
    assert fb_total["status"] == "translated"  # preserved!
    assert sword_row["first_seen_vol"] == 2
    assert sword_row["status"] == "new"


def test_glossary_tsv_csv_import_export_and_deterministic_xml(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        s_id = conn.execute(
            "INSERT INTO series (title, source_lang) VALUES ('Import Test', 'ja')"
        ).lastrowid

    tsv_data = (
        "jp\tvn\tromaji\than_viet\tenglish\ttype\n"
        "無詠唱\tVô niệm\tmueishou\tVô Vịnh Xướng\tSilent casting\tSkill\n"
        "剣&盾\tKiếm & Khiên\tken to tate\tKiếm Thuẫn\tSword & Shield\tItem\n"
    ).encode("utf-8")

    imp = import_glossary_tabular(s_id, "old_excel.tsv", tsv_data, db_path=isolated_db)
    assert imp["imported"] == 2
    assert imp["skipped"] == 0

    exported_tsv, media = export_glossary_tabular(s_id, fmt="tsv", db_path=isolated_db)
    assert "tab-separated-values" in media
    assert exported_tsv.startswith("\ufeff")
    assert "無詠唱\tVô niệm" in exported_tsv

    xml_str = render_glossary_xml(s_id, db_path=isolated_db)
    parsed = ET.fromstring(xml_str)
    assert parsed.tag == "GLOSSARY"
    terms = parsed.findall("TERM")
    assert len(terms) == 2
    assert any(
        el.attrib.get("jp") == "剣&盾"
        and el.attrib.get("vn") == "Kiếm & Khiên"
        and el.attrib.get("romaji") == "ken to tate"
        for el in terms
    )


# ---------- 4. Phase 2 REST API Smoke Tests ----------

def test_phase2_rest_api_flow(client: TestClient) -> None:
    series = client.post(
        "/api/series",
        json={"title": "API Phase 2 Test", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()
    vol = client.post(
        f"/api/series/{series['id']}/volumes",
        json={"volume_number": 1, "title": "Tập 1"},
    ).json()

    # Upload EPUB via multipart form
    epub_bytes = _make_sample_epub_bytes()
    imp_res = client.post(
        f"/api/volumes/{vol['id']}/import",
        files={"file": ("vol1.epub", epub_bytes, "application/epub+zip")},
        data={"split_mode": "epub_chapters", "keep_furigana": "true"},
    )
    assert imp_res.status_code == 201
    assert imp_res.json()["chapters_imported"] == 2

    # List chapters
    ch_res = client.get(f"/api/volumes/{vol['id']}/chapters")
    assert ch_res.status_code == 200
    assert len(ch_res.json()) == 2

    # Extract glossary
    ext_res = client.post(f"/api/volumes/{vol['id']}/glossary/extract", json={"min_freq": 1})
    assert ext_res.status_code == 200
    assert ext_res.json()["new_terms"] >= 4

    # Query glossary with filters
    list_res = client.get(
        f"/api/series/{series['id']}/glossary",
        params={"volume_id": vol["id"], "status": "new"},
    )
    assert list_res.status_code == 200
    items = list_res.json()["items"]
    assert len(items) >= 4

    # Inline patch a term
    first_id = items[0]["id"]
    patch_res = client.patch(
        f"/api/glossary/{first_id}",
        json={"vi_term": "Thuật ngữ mẫu", "term_type": "Skill", "status": "approved"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["vi_term"] == "Thuật ngữ mẫu"
    assert patch_res.json()["status"] == "approved"

    # Bulk status update
    bulk_ids = [item["id"] for item in items[1:3]]
    bulk_res = client.post(
        "/api/glossary/bulk-status",
        json={"term_ids": bulk_ids, "status": "ignored"},
    )
    assert bulk_res.status_code == 200
    assert bulk_res.json()["updated"] == len(bulk_ids)

    # Export TSV & XML
    exp_res = client.get(f"/api/series/{series['id']}/glossary/export", params={"format": "tsv"})
    assert exp_res.status_code == 200
    assert "Thuật ngữ mẫu" in exp_res.text

    xml_res = client.get(f"/api/series/{series['id']}/glossary/xml")
    assert xml_res.status_code == 200
    assert "<GLOSSARY" in xml_res.text
