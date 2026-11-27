"""Publication export (.docx, .epub), volume-wide Find & Replace (literal/Regex), and proofreading helpers."""

from __future__ import annotations

import html
import io
import re
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt
from ebooklib import epub

from app.core.database import db_session
from app.core.gemini_pool import GeminiPool, gemini_pool
from app.services.continuity_service import build_relevant_context
from app.services.epub_service import get_volume_media_dir
from app.services.languages.base import normalize_term_key

ALLOWED_DOCX_FONTS = {"Times New Roman", "Cambria"}

_MD_IMAGE_LINE_RE = re.compile(
    r"^!\[(?P<alt>[^\]]*)\]\(/api/media/vol_(?P<vol>\d+)/(?P<fname>[^/\s)]+)\)$"
)
_MD_INLINE_RE = re.compile(
    r"(\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)"
)
_DOCX_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"}
_MEDIA_TYPE_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}

_EPUB_CSS = """
body {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.65;
  margin: 5%;
  color: #1a1a1a;
}
h1 {
  text-align: center;
  font-size: 1.45em;
  margin: 1.6em 0 1.1em 0;
  page-break-before: always;
}
p {
  text-indent: 1.5em;
  margin: 0.45em 0;
  text-align: justify;
}
.subtitle {
  text-align: center;
  text-indent: 0;
  color: #555555;
  font-style: italic;
}
.illustration {
  text-align: center;
  text-indent: 0;
  margin: 1.2em 0;
}
.illustration img {
  max-width: 100%;
  height: auto;
}
"""


def _resolve_media_path(vol_id: int, filename: str) -> Path | None:
    if "/" in filename or "\\" in filename or ".." in filename:
        return None
    media_dir = get_volume_media_dir(vol_id).resolve()
    candidate = (media_dir / filename).resolve()
    try:
        candidate.relative_to(media_dir)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _add_markdown_runs_to_paragraph(paragraph: Any, text: str, font_name: str) -> None:
    """Render inline ***bold italic***, **bold**, *italic* cleanly as native Word runs."""
    parts = _MD_INLINE_RE.split(text)
    for part in parts:
        if not part:
            continue
        bold = False
        italic = False
        content = part
        if part.startswith("***") and part.endswith("***") and len(part) > 6:
            bold = True
            italic = True
            content = part[3:-3]
        elif part.startswith("**") and part.endswith("**") and len(part) > 4:
            bold = True
            content = part[2:-2]
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            italic = True
            content = part[1:-1]
        run = paragraph.add_run(content)
        run.bold = bold
        run.italic = italic
        _set_run_font_all_scripts(run, font_name)


def _markdown_inline_to_html(text: str) -> str:
    """Escape HTML and render ***bold italic***, **bold**, *italic* to safe XHTML tags."""
    out: list[str] = []
    for part in _MD_INLINE_RE.split(text):
        if not part:
            continue
        if part.startswith("***") and part.endswith("***") and len(part) > 6:
            out.append(f"<strong><em>{html.escape(part[3:-3])}</em></strong>")
        elif part.startswith("**") and part.endswith("**") and len(part) > 4:
            out.append(f"<strong>{html.escape(part[2:-2])}</strong>")
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            out.append(f"<em>{html.escape(part[1:-1])}</em>")
        else:
            out.append(html.escape(part))
    return "".join(out)

_SELECTION_RETRANSLATE_SYSTEM = """Bạn là biên tập viên và dịch giả Light Novel tiếng Việt chuyên nghiệp.
Nhiệm vụ: Dịch lại hoặc biên tập trau chuốt CHÍNH XÁC đoạn văn bản được người dùng bôi đen, dựa trên văn bản gốc của chương, bảng thuật ngữ và xưng hô đã chốt.

QUY TẮC BẮT BUỘC:
1. CHỈ trả về duy nhất đoạn bản dịch tiếng Việt thay thế cho đoạn được bôi đen.
2. KHÔNG thêm lời giải thích, KHÔNG chèn tiêu đề hay dấu ngoặc kép thừa bao quanh kết quả.
3. Giữ đúng mạch văn, thuật ngữ đã duyệt và xưng hô nhất quán với chương."""


def _safe_filename_slug(text: str, fallback: str = "ln_studio") -> str:
    nfkd = unicodedata.normalize("NFKD", text or "")
    ascii_only = "".join(ch for ch in nfkd if ord(ch) < 128)
    slug = re.sub(r"[^A-Za-z0-9]+", "_", ascii_only).strip("_")
    return slug[:60] or fallback


def _set_run_font_all_scripts(style_or_run: Any, font_name: str) -> None:
    """Ensure Word applies font_name cleanly across ASCII, High-ANSI, Complex Script, and East Asia."""
    style_or_run.font.name = font_name
    rPr = style_or_run.element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.insert(0, rFonts)
    rFonts.set(qn("w:ascii"), font_name)
    rFonts.set(qn("w:hAnsi"), font_name)
    rFonts.set(qn("w:cs"), font_name)
    rFonts.set(qn("w:eastAsia"), font_name)


def _load_volume_and_chapters(
    volume_id: int, db_path: Path | str | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    with db_session(db_path) as conn:
        vol_row = conn.execute(
            """
            SELECT v.*, s.title AS series_title, s.source_lang
            FROM volumes v
            JOIN series s ON s.id = v.series_id
            WHERE v.id = ?
            """,
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

        ch_rows = conn.execute(
            """
            SELECT id, chapter_index, title, raw_text, translated_text, status
            FROM chapters
            WHERE volume_id = ?
            ORDER BY chapter_index ASC
            """,
            (volume_id,),
        ).fetchall()

    if not ch_rows:
        raise ValueError("Tập này chưa có chương nào để xuất bản.")

    return dict(vol_row), [dict(r) for r in ch_rows]


# ---------- 1. Export DOCX ----------

def export_volume_docx(
    volume_id: int,
    *,
    font_name: str = "Times New Roman",
    font_size_pt: float = 13.0,
    line_spacing: float = 1.3,
    db_path: Path | str | None = None,
) -> tuple[str, bytes]:
    """Export an entire Volume to a publication-ready .docx file with Heading 1 TOC support."""
    chosen_font = font_name if font_name in ALLOWED_DOCX_FONTS else "Times New Roman"
    vol, chapters = _load_volume_and_chapters(volume_id, db_path=db_path)

    doc = Document()

    # Configure page margins comfortably for reading/printing
    for section in doc.sections:
        section.top_margin = Cm(2.2)
        section.bottom_margin = Cm(2.2)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    # Configure Normal body style: 13pt, line spacing 1.3, first-line indent, justified
    normal_style = doc.styles["Normal"]
    normal_style.font.size = Pt(font_size_pt)
    _set_run_font_all_scripts(normal_style, chosen_font)
    normal_pf = normal_style.paragraph_format
    normal_pf.line_spacing = line_spacing
    normal_pf.first_line_indent = Cm(0.8)
    normal_pf.space_before = Pt(0)
    normal_pf.space_after = Pt(4)
    normal_pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

    # Configure Heading 1 style so Word auto-generates Table of Contents
    h1_style = doc.styles["Heading 1"]
    h1_style.font.size = Pt(18)
    h1_style.font.bold = True
    _set_run_font_all_scripts(h1_style, chosen_font)
    h1_pf = h1_style.paragraph_format
    h1_pf.first_line_indent = Cm(0)
    h1_pf.space_before = Pt(12)
    h1_pf.space_after = Pt(10)
    h1_pf.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # Cover / Title Block
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_p.paragraph_format.first_line_indent = Cm(0)
    title_p.paragraph_format.space_before = Pt(72)
    title_p.paragraph_format.space_after = Pt(12)
    title_run = title_p.add_run(str(vol["series_title"]))
    title_run.bold = True
    title_run.font.size = Pt(22)
    _set_run_font_all_scripts(title_run, chosen_font)

    vol_p = doc.add_paragraph()
    vol_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    vol_p.paragraph_format.first_line_indent = Cm(0)
    vol_p.paragraph_format.space_after = Pt(18)
    vol_run = vol_p.add_run(f"Tập {vol['volume_number']}: {vol['title']}")
    vol_run.italic = True
    vol_run.font.size = Pt(16)
    _set_run_font_all_scripts(vol_run, chosen_font)

    # Chapters: each starts on a new page with Heading 1
    for ch in chapters:
        doc.add_page_break()
        ch_title = (ch["title"] or "").strip() or f"Chương {ch['chapter_index']}"
        if not ch_title.lower().startswith(("chương", "phần", "tập", "mở đầu", "lời kết", "ngoại truyện")):
            heading_text = f"Chương {ch['chapter_index']}: {ch_title}"
        else:
            heading_text = ch_title
        doc.add_heading(heading_text, level=1)

        body_text = (ch["translated_text"] or "").strip()
        if not body_text:
            placeholder = doc.add_paragraph("[Chương này chưa có bản dịch.]")
            placeholder.paragraph_format.first_line_indent = Cm(0)
            continue

        paragraphs = [p.strip() for p in re.split(r"\r?\n+", body_text) if p.strip()]
        for para_text in paragraphs:
            img_match = _MD_IMAGE_LINE_RE.match(para_text)
            if img_match:
                img_path = _resolve_media_path(
                    int(img_match.group("vol")), img_match.group("fname")
                )
                if img_path is not None and img_path.suffix.lower() in _DOCX_IMAGE_EXTS:
                    img_p = doc.add_paragraph()
                    img_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    img_p.paragraph_format.first_line_indent = Cm(0)
                    img_p.paragraph_format.space_before = Pt(6)
                    img_p.paragraph_format.space_after = Pt(6)
                    try:
                        img_p.add_run().add_picture(str(img_path), width=Cm(14))
                        continue
                    except Exception:
                        pass
            p = doc.add_paragraph(style="Normal")
            p.paragraph_format.line_spacing = line_spacing
            p.paragraph_format.first_line_indent = Cm(0.8)
            _add_markdown_runs_to_paragraph(p, para_text, chosen_font)

    buf = io.BytesIO()
    doc.save(buf)
    slug = _safe_filename_slug(str(vol["series_title"]))
    filename = f"{slug}_Vol{vol['volume_number']}.docx"
    return filename, buf.getvalue()


# ---------- 2. Export EPUB ----------

def export_volume_epub(
    volume_id: int, db_path: Path | str | None = None
) -> tuple[str, bytes]:
    """Export an entire Volume to a clean .epub ebook with interactive chapter Table of Contents."""
    vol, chapters = _load_volume_and_chapters(volume_id, db_path=db_path)

    book = epub.EpubBook()
    book_id = f"ln-studio-s{vol['series_id']}-v{vol['volume_number']}"
    book_title = f"{vol['series_title']} — Tập {vol['volume_number']}: {vol['title']}"
    book.set_identifier(book_id)
    book.set_title(book_title)
    book.set_language("vi")
    book.add_author("LN-Studio")

    css_item = epub.EpubItem(
        uid="style_main",
        file_name="style/main.css",
        media_type="text/css",
        content=_EPUB_CSS.encode("utf-8"),
    )
    book.add_item(css_item)

    epub_chapters: list[epub.EpubHtml] = []
    toc_links: list[epub.Link] = []
    embedded_images: dict[str, str] = {}

    for ch in chapters:
        idx = int(ch["chapter_index"])
        ch_title = (ch["title"] or "").strip() or f"Chương {idx}"
        if not ch_title.lower().startswith(("chương", "phần", "tập", "mở đầu", "lời kết", "ngoại truyện")):
            heading_text = f"Chương {idx}: {ch_title}"
        else:
            heading_text = ch_title

        body_text = (ch["translated_text"] or "").strip()
        if body_text:
            html_blocks: list[str] = []
            for raw_line in re.split(r"\r?\n+", body_text):
                line = raw_line.strip()
                if not line:
                    continue
                img_match = _MD_IMAGE_LINE_RE.match(line)
                if img_match:
                    vol_ref = int(img_match.group("vol"))
                    fname = img_match.group("fname")
                    alt = img_match.group("alt") or fname
                    img_path = _resolve_media_path(vol_ref, fname)
                    if img_path is not None:
                        cache_key = f"{vol_ref}/{fname}"
                        if cache_key not in embedded_images:
                            epub_img_name = f"images/{fname}"
                            media_type = _MEDIA_TYPE_BY_EXT.get(
                                img_path.suffix.lower(), "image/jpeg"
                            )
                            img_item = epub.EpubImage(
                                uid=f"img_{len(embedded_images) + 1}",
                                file_name=epub_img_name,
                                media_type=media_type,
                                content=img_path.read_bytes(),
                            )
                            book.add_item(img_item)
                            embedded_images[cache_key] = epub_img_name
                        href = embedded_images[cache_key]
                        html_blocks.append(
                            f'<div class="illustration"><img src="{html.escape(href)}" alt="{html.escape(alt)}" /></div>'
                        )
                        continue
                html_blocks.append(f"<p>{_markdown_inline_to_html(line)}</p>")
            para_html = "\n".join(html_blocks)
        else:
            para_html = '<p class="subtitle">[Chương này chưa có bản dịch.]</p>'

        file_name = f"chap_{idx:03d}.xhtml"
        item = epub.EpubHtml(title=heading_text, file_name=file_name, lang="vi")
        item.add_item(css_item)
        item.content = (
            f"<html><head><title>{html.escape(heading_text)}</title>"
            f'<link rel="stylesheet" type="text/css" href="style/main.css" /></head>'
            f"<body><h1>{html.escape(heading_text)}</h1>\n{para_html}\n</body></html>"
        )
        book.add_item(item)
        epub_chapters.append(item)
        toc_links.append(epub.Link(file_name, heading_text, f"chap_{idx:03d}"))

    book.toc = tuple(toc_links)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", *epub_chapters]

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        epub.write_epub(str(tmp_path), book)
        epub_bytes = tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)

    slug = _safe_filename_slug(str(vol["series_title"]))
    filename = f"{slug}_Vol{vol['volume_number']}.epub"
    return filename, epub_bytes


# ---------- 3. Volume-Wide Find & Replace (Literal + Regex) ----------

def find_replace_volume(
    volume_id: int,
    find_text: str,
    replace_text: str,
    *,
    use_regex: bool = False,
    case_sensitive: bool = True,
    dry_run: bool = False,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Batch Find & Replace across all chapters' translated_text in a Volume (supports Regex & dry_run preview)."""
    if not find_text:
        raise ValueError("Chuỗi cần tìm không được để trống.")

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(find_text if use_regex else re.escape(find_text), flags)
    except re.error as exc:
        raise ValueError(f"Biểu thức Regex không hợp lệ: {exc}")

    affected_chapters: list[dict[str, Any]] = []
    total_matches = 0

    with db_session(db_path) as conn:
        if conn.execute("SELECT id FROM volumes WHERE id = ?", (volume_id,)).fetchone() is None:
            raise LookupError("Không tìm thấy tập truyện.")

        rows = conn.execute(
            """
            SELECT id, chapter_index, title, raw_text, masked_raw_text, translated_text
            FROM chapters
            WHERE volume_id = ?
            ORDER BY chapter_index ASC
            """,
            (volume_id,),
        ).fetchall()

        for r in rows:
            translated = str(r["translated_text"] or "")
            if not translated:
                continue

            if use_regex:
                try:
                    new_text, count = pattern.subn(replace_text, translated)
                except re.error as exc:
                    raise ValueError(f"Chuỗi thay thế Regex không hợp lệ: {exc}")
            else:
                new_text, count = pattern.subn(lambda _m: replace_text, translated)

            if count > 0:
                total_matches += count
                first_match = pattern.search(translated)
                snippet = ""
                if first_match:
                    s_idx = max(0, first_match.start() - 35)
                    e_idx = min(len(translated), first_match.end() + 35)
                    snippet = translated[s_idx:e_idx].replace("\n", " ")

                affected_chapters.append(
                    {
                        "chapter_id": int(r["id"]),
                        "chapter_index": int(r["chapter_index"]),
                        "title": str(r["title"] or ""),
                        "matches": count,
                        "sample_snippet": snippet,
                    }
                )

                if not dry_run:
                    src_ref = str(r["masked_raw_text"] or r["raw_text"] or "")
                    ratio = round(len(new_text.strip()) / max(1, len(src_ref.strip())), 4)
                    conn.execute(
                        """
                        UPDATE chapters
                        SET translated_text = ?,
                            char_ratio = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (new_text, ratio, int(r["id"])),
                    )

    return {
        "volume_id": volume_id,
        "dry_run": dry_run,
        "use_regex": use_regex,
        "case_sensitive": case_sensitive,
        "total_matches": total_matches,
        "chapters_affected": len(affected_chapters),
        "affected_chapters": affected_chapters,
    }


# ---------- 4. Proofread Data, Auto-Save & Selection Retranslation ----------

def get_chapter_proofread_data(
    chapter_id: int, db_path: Path | str | None = None
) -> dict[str, Any]:
    """Return chapter raw + translated text along with Master Glossary terms occurring in this chapter."""
    with db_session(db_path) as conn:
        row = conn.execute(
            """
            SELECT c.*, v.series_id, v.volume_number
            FROM chapters c
            JOIN volumes v ON v.id = c.volume_id
            WHERE c.id = ?
            """,
            (chapter_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Không tìm thấy chương.")

        raw_text = str(row["raw_text"] or "")
        raw_nfkc = unicodedata.normalize("NFKC", raw_text)
        series_id = int(row["series_id"])

        glossary_rows = conn.execute(
            """
            SELECT id, source_term, vi_term, reading, han_viet, english_meaning, term_type, status
            FROM glossary_terms
            WHERE series_id = ? AND status != 'ignored'
            ORDER BY LENGTH(source_term) DESC, total_freq DESC
            """,
            (series_id,),
        ).fetchall()

    matched_glossary: list[dict[str, Any]] = []
    for g in glossary_rows:
        src = str(g["source_term"] or "")
        if not src:
            continue
        if src in raw_text or normalize_term_key(src) in raw_nfkc:
            matched_glossary.append(
                {
                    "id": int(g["id"]),
                    "source_term": src,
                    "vi_term": str(g["vi_term"] or ""),
                    "reading": str(g["reading"] or ""),
                    "han_viet": str(g["han_viet"] or ""),
                    "english_meaning": str(g["english_meaning"] or ""),
                    "term_type": str(g["term_type"] or "Concept"),
                    "status": str(g["status"]),
                }
            )

    return {
        "id": int(row["id"]),
        "volume_id": int(row["volume_id"]),
        "series_id": series_id,
        "chapter_index": int(row["chapter_index"]),
        "title": str(row["title"] or ""),
        "raw_text": raw_text,
        "masked_raw_text": row["masked_raw_text"],
        "translated_text": str(row["translated_text"] or ""),
        "status": str(row["status"]),
        "used_slot": row["used_slot"],
        "char_ratio": float(row["char_ratio"] or 0.0),
        "error_message": row["error_message"],
        "updated_at": str(row["updated_at"]),
        "glossary_highlights": matched_glossary,
    }


def save_chapter_translation(
    chapter_id: int,
    translated_text: str,
    *,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Persist edited translated_text (auto-save) and recalculate char_ratio."""
    with db_session(db_path) as conn:
        row = conn.execute(
            "SELECT id, raw_text, masked_raw_text, status FROM chapters WHERE id = ?",
            (chapter_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Không tìm thấy chương.")

        src_ref = str(row["masked_raw_text"] or row["raw_text"] or "")
        ratio = round(len(translated_text.strip()) / max(1, len(src_ref.strip())), 4)
        new_status = str(row["status"])
        if translated_text.strip() and new_status in ("pending", "summarized", "failed", "blocked"):
            new_status = "completed"

        conn.execute(
            """
            UPDATE chapters
            SET translated_text = ?,
                char_ratio = ?,
                status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (translated_text, ratio, new_status, chapter_id),
        )
        updated = conn.execute(
            "SELECT id, status, char_ratio, updated_at FROM chapters WHERE id = ?",
            (chapter_id,),
        ).fetchone()

    return {
        "chapter_id": int(updated["id"]),
        "status": str(updated["status"]),
        "char_ratio": float(updated["char_ratio"] or 0.0),
        "translated_chars": len(translated_text),
        "updated_at": str(updated["updated_at"]),
    }


def retranslate_selection(
    chapter_id: int,
    selected_text: str,
    *,
    source_side: str = "translated",
    instruction: str = "",
    temperature: float = 0.5,
    model_override: str | None = None,
    pool: GeminiPool | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Retranslate or refine a highlighted text snippet using Gemini Pool + chapter context."""
    snippet = (selected_text or "").strip()
    if not snippet:
        raise ValueError("Đoạn văn bản bôi đen không được để trống.")

    active_pool = pool or gemini_pool

    with db_session(db_path) as conn:
        row = conn.execute(
            """
            SELECT c.id, c.volume_id, c.chapter_index, c.title, c.raw_text, c.translated_text,
                   s.title AS series_title, s.source_lang, s.system_prompt
            FROM chapters c
            JOIN volumes v ON v.id = c.volume_id
            JOIN series s ON s.id = v.series_id
            WHERE c.id = ?
            """,
            (chapter_id,),
        ).fetchone()
        if row is None:
            raise LookupError("Không tìm thấy chương.")

        volume_id = int(row["volume_id"])
        raw_text = str(row["raw_text"] or "")

    rel_ctx = build_relevant_context(volume_id, raw_text, db_path=db_path)
    glossary_lines = [
        f"- {g['source_term']} = {g['vi_term']}"
        for g in rel_ctx.get("matched_glossary", [])[:60]
    ]
    rel_lines = [
        f"- {r['source_name']} → {r['target_name']}: {r['pair_pronoun']}"
        for r in rel_ctx.get("matched_relationships", [])[:30]
    ]

    context_sections: list[str] = []
    if glossary_lines:
        context_sections.append("Thuật ngữ đã duyệt:\n" + "\n".join(glossary_lines))
    if rel_lines:
        context_sections.append("Xưng hô đã chốt:\n" + "\n".join(rel_lines))

    side_desc = (
        "Đoạn gốc (Raw) cần dịch sang tiếng Việt"
        if source_side == "raw"
        else "Đoạn bản dịch tiếng Việt đang bôi đen cần dịch lại / hiệu đính sát nghĩa và mượt hơn dựa theo văn bản gốc"
    )
    extra_note = (
        f"\nYêu cầu bổ sung của biên tập viên: {instruction.strip()}\n"
        if instruction.strip()
        else ""
    )

    prompt = (
        f"Bộ truyện: {row['series_title']} ({str(row['source_lang']).upper()}) — Chương {row['chapter_index']}\n\n"
        + ("\n\n".join(context_sections) + "\n\n" if context_sections else "")
        + f"Văn bản gốc toàn chương (để đối chiếu ngữ cảnh):\n{raw_text[:8000]}\n\n"
        + f"{side_desc}:\n<<<\n{snippet}\n>>>\n"
        + extra_note
        + "\nHãy trả về DUY NHẤT đoạn bản dịch tiếng Việt thay thế cho đoạn nằm trong <<< >>>:"
    )

    system_inst = _SELECTION_RETRANSLATE_SYSTEM
    if (row["system_prompt"] or "").strip():
        system_inst += f"\n\nPhong cách riêng của bộ truyện:\n{row['system_prompt']}"

    resp = active_pool.generate_content(
        prompt,
        system_instruction=system_inst,
        temperature=temperature,
        task_type="proofread_retranslate",
        models=[model_override] if model_override and model_override.strip() else None,
    )
    cleaned_out = (resp.text or "").strip()
    if cleaned_out.startswith("<<<") and cleaned_out.endswith(">>>"):
        cleaned_out = cleaned_out[3:-3].strip()

    return {
        "chapter_id": chapter_id,
        "original_selection": snippet,
        "retranslated_text": cleaned_out,
        "used_slot": resp.slot_id,
    }
