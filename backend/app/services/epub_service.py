"""EPUB, TXT, and DOCX import service with comprehensive ruby/furigana and splitting support."""

from __future__ import annotations

import io
import re
import sqlite3
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import ebooklib
from bs4 import BeautifulSoup, NavigableString, Tag, XMLParsedAsHTMLWarning
from docx import Document
from ebooklib import epub

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

from app.core.database import db_session

SplitMode = Literal["epub_chapters", "chunk_chars"]

BLOCK_TAGS = {
    "p",
    "div",
    "blockquote",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "pre",
    "dt",
    "dd",
    "figcaption",
}

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?\.\n])")
_MULTI_BLANK_LINES_RE = re.compile(r"\n{3,}")
_TEXT_CHAPTER_HEADING_RE = re.compile(
    r"^(?:"
    r"(?:第[一二三四五六七八九十百千万0-9０-９]+[章話回部節巻幕])|"
    r"(?:プロローグ|エピローグ|序章|終章|幕間|あとがき|外伝|番外編)|"
    r"(?:Chapter\s+\d+|Prologue|Epilogue|Interlude)|"
    r"(?:Chương\s+\d+|Phần\s+\d+)|"
    r"(?:제\s*\d+\s*[화장부편])"
    r").*$",
    re.IGNORECASE,
)


@dataclass
class ParsedChapter:
    chapter_index: int
    title: str
    raw_text: str


def _extract_single_ruby(ruby_tag: Tag) -> tuple[str, str]:
    """Extract (base_text, reading_text) from a single <ruby> tag, ignoring <rp>."""
    # Remove any <rp> tags inside this ruby element
    for rp in ruby_tag.find_all("rp"):
        rp.decompose()

    base_parts: list[str] = []
    rt_parts: list[str] = []

    children = list(ruby_tag.children)
    for idx, child in enumerate(children):
        if isinstance(child, Tag):
            name = (child.name or "").lower()
            if name == "rt":
                rt_parts.append(child.get_text())
            elif name == "rp":
                continue
            elif name == "rb":
                base_parts.append(child.get_text())
            elif name == "rtc":
                rt_parts.append(child.get_text())
            else:
                # Nested inline formatting tag (e.g. <span>, <em>, <strong>, <a>)
                # Extract any nested <rt> inside it or treat as base text
                nested_rts = child.find_all("rt")
                if nested_rts:
                    sub_base, sub_rt = _extract_single_ruby(child)
                    base_parts.append(sub_base)
                    rt_parts.append(sub_rt)
                else:
                    base_parts.append(child.get_text())
        elif isinstance(child, NavigableString):
            text = str(child)
            if not text:
                continue
            # Ignore pure formatting whitespace/newlines between <rb>/<rt> tags
            if not text.strip():
                continue
            base_parts.append(text)
            # If there's un-annotated kana inside <ruby> whose next non-ws sibling isn't <rt>,
            # keep reading aligned if other rt parts exist
            next_sig = None
            for nxt in children[idx + 1 :]:
                if isinstance(nxt, NavigableString) and not str(nxt).strip():
                    continue
                next_sig = nxt
                break
            if not (isinstance(next_sig, Tag) and (next_sig.name or "").lower() in ("rt", "rtc")):
                # Inline kana without its own <rt>, e.g., <ruby>化<rt>ば</rt>け</ruby>
                if rt_parts:
                    rt_parts.append(text)

    base = "".join(base_parts).strip()
    reading = "".join(rt_parts).strip()
    return base, reading


_OKURIGANA_BRIDGE_RE = re.compile(r"^[\u3041-\u3096]{1,2}$")
_PARTICLE_BRIDGES: frozenset[str] = frozenset(
    {"の", "を", "が", "は", "に", "で", "と", "へ", "も", "や", "か", "て", "た", "だ", "な", "ね", "よ", "わ"}
)


def normalize_ruby_in_soup(soup: BeautifulSoup, keep_furigana: bool = True) -> None:
    """Process ALL <ruby> tags inside ANY parent element (blockquote, em, strong, td, a, p, etc.).

    Adjacent sibling <ruby> elements (and short non-particle okurigana bridges between them,
    such as `<ruby>化<rt>ば</rt></ruby>け<ruby>物<rt>もの</rt></ruby>`) are merged cleanly
    into a single `漢字（ふりがな）` run (or `漢字` when keep_furigana=False).
    """
    all_rubies = [r for r in soup.find_all("ruby") if r.find_parent("ruby") is None]
    visited: set[int] = set()

    for ruby in all_rubies:
        if id(ruby) in visited or ruby.parent is None:
            continue

        # Each run item is either ('ruby', Tag) or ('kana', NavigableString)
        run: list[tuple[str, Any]] = [("ruby", ruby)]
        visited.add(id(ruby))

        cursor = ruby.next_sibling
        while cursor is not None:
            if isinstance(cursor, NavigableString) and str(cursor) == "":
                cursor = cursor.next_sibling
                continue
            if isinstance(cursor, Tag) and (cursor.name or "").lower() == "ruby":
                run.append(("ruby", cursor))
                visited.add(id(cursor))
                cursor = cursor.next_sibling
                continue
            # Merge short non-particle okurigana bridge ONLY when directly followed by another <ruby>
            if isinstance(cursor, NavigableString):
                bridge_txt = str(cursor)
                nxt = cursor.next_sibling
                while isinstance(nxt, NavigableString) and str(nxt) == "":
                    nxt = nxt.next_sibling
                if (
                    _OKURIGANA_BRIDGE_RE.match(bridge_txt)
                    and bridge_txt not in _PARTICLE_BRIDGES
                    and isinstance(nxt, Tag)
                    and (nxt.name or "").lower() == "ruby"
                ):
                    run.append(("kana", cursor))
                    run.append(("ruby", nxt))
                    visited.add(id(nxt))
                    cursor = nxt.next_sibling
                    continue
            break

        merged_base_parts: list[str] = []
        merged_rt_parts: list[str] = []
        for kind, node in run:
            if kind == "ruby":
                b, rt = _extract_single_ruby(node)
                if b:
                    merged_base_parts.append(b)
                if rt:
                    merged_rt_parts.append(rt)
            else:
                kana_txt = str(node)
                merged_base_parts.append(kana_txt)
                merged_rt_parts.append(kana_txt)

        merged_base = "".join(merged_base_parts)
        merged_rt = "".join(merged_rt_parts)

        if keep_furigana and merged_base and merged_rt:
            replacement = f"{merged_base}（{merged_rt}）"
        else:
            replacement = merged_base or merged_rt

        ruby.replace_with(NavigableString(replacement))
        for _kind, extra in run[1:]:
            if getattr(extra, "parent", None) is not None:
                extra.extract()


def html_to_clean_text(html_bytes: bytes | str, keep_furigana: bool = True) -> tuple[str, str]:
    """Convert an EPUB XHTML/HTML document to (title, clean_text) preserving all block boundaries."""
    try:
        soup = BeautifulSoup(html_bytes, "lxml")
    except Exception:
        soup = BeautifulSoup(html_bytes, "html.parser")

    doc_title = ""
    if soup.title and soup.title.string:
        doc_title = soup.title.string.strip()

    body = soup.body if soup.body is not None else soup

    # Remove non-content elements
    for junk in body.find_all(["script", "style", "svg", "noscript"]):
        junk.decompose()

    # Convert ALL <ruby> elements across every parent tag before text extraction
    normalize_ruby_in_soup(body, keep_furigana=keep_furigana)

    # Prefer heading text inside body for chapter title if available
    for h_tag in body.find_all(["h1", "h2", "h3"]):
        h_text = " ".join(h_tag.get_text(" ", strip=True).split())
        if h_text:
            doc_title = h_text
            break

    # Convert <br> into explicit newlines
    for br in body.find_all("br"):
        br.replace_with(NavigableString("\n"))

    # Extract leaf-level block paragraphs so inline tags (em, strong, a, span) stay inline
    paragraphs: list[str] = []

    def _collect_blocks(node: Tag) -> None:
        inline_buf: list[str] = []

        def _flush_inline() -> None:
            if not inline_buf:
                return
            joined = "".join(inline_buf)
            for line in joined.splitlines():
                cleaned = re.sub(r"[ \t\r\f\v]+", " ", line).strip()
                if cleaned:
                    paragraphs.append(cleaned)
            inline_buf.clear()

        for child in node.children:
            if isinstance(child, NavigableString):
                inline_buf.append(str(child))
            elif isinstance(child, Tag):
                tag_name = (child.name or "").lower()
                if tag_name == "tr":
                    _flush_inline()
                    cells = [
                        re.sub(r"[ \t\r\f\v]+", " ", cell.get_text()).strip()
                        for cell in child.find_all(["td", "th"], recursive=False)
                    ]
                    row_line = " | ".join(c for c in cells if c)
                    if row_line:
                        paragraphs.append(row_line)
                elif tag_name in BLOCK_TAGS:
                    _flush_inline()
                    # Check if this block contains nested block tags
                    has_nested_block = any(
                        isinstance(desc, Tag) and (desc.name or "").lower() in BLOCK_TAGS
                        for desc in child.find_all(True)
                    )
                    if has_nested_block:
                        _collect_blocks(child)
                    else:
                        raw = child.get_text()
                        for line in raw.splitlines():
                            cleaned = re.sub(r"[ \t\r\f\v]+", " ", line).strip()
                            if cleaned:
                                paragraphs.append(cleaned)
                else:
                    # Inline element (em, strong, a, span, etc.) -> stays inline!
                    inline_buf.append(child.get_text())

        _flush_inline()

    _collect_blocks(body)
    full_text = "\n\n".join(paragraphs)
    full_text = _MULTI_BLANK_LINES_RE.sub("\n\n", full_text).strip()
    return doc_title, full_text


def _build_toc_title_map(book: epub.EpubBook) -> dict[str, str]:
    """Map EPUB document hrefs (without fragment) to TOC labels."""
    mapping: dict[str, str] = {}

    def _walk(items: Any) -> None:
        if not items:
            return
        for item in items:
            if isinstance(item, epub.Link):
                href = (item.href or "").split("#")[0].lstrip("./")
                if href and item.title and href not in mapping:
                    mapping[href] = item.title.strip()
            elif isinstance(item, tuple) and len(item) == 2:
                section, children = item
                if isinstance(section, epub.Section) and section.href and section.title:
                    href = section.href.split("#")[0].lstrip("./")
                    if href and href not in mapping:
                        mapping[href] = section.title.strip()
                _walk(children)

    _walk(book.toc)
    return mapping


def parse_epub_bytes(
    file_bytes: bytes,
    *,
    keep_furigana: bool = True,
) -> list[tuple[str, str]]:
    """Read an EPUB strictly in spine order and return list of (title, clean_text) sections."""
    # ebooklib.epub.read_epub requires a filesystem path
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = Path(tmp.name)

    try:
        book = epub.read_epub(str(tmp_path), options={"ignore_ncx": False})
    finally:
        tmp_path.unlink(missing_ok=True)

    toc_titles = _build_toc_title_map(book)
    sections: list[tuple[str, str]] = []

    for spine_entry in book.spine:
        idref = spine_entry[0] if isinstance(spine_entry, tuple) else str(spine_entry)
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue

        raw_content = item.get_content()
        html_title, clean_text = html_to_clean_text(raw_content, keep_furigana=keep_furigana)
        if not clean_text or len(clean_text.strip()) < 2:
            continue

        item_name = (item.get_name() or "").lstrip("./")
        toc_title = toc_titles.get(item_name) or toc_titles.get(Path(item_name).name)
        title = toc_title or html_title or f"Chương {len(sections) + 1}"
        sections.append((title, clean_text))

    return sections


def decode_text_bytes(file_bytes: bytes) -> str:
    """Decode plain text bytes with sensible fallback encodings for JA/ZH/KO."""
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis", "gb18030", "cp949"):
        try:
            return file_bytes.decode(enc)
        except UnicodeDecodeError:
            continue
    return file_bytes.decode("utf-8", errors="replace")


def parse_txt_bytes(file_bytes: bytes) -> list[tuple[str, str]]:
    """Parse a TXT file into sections using chapter heading heuristics when present."""
    raw = decode_text_bytes(file_bytes).replace("\r\n", "\n").replace("\r", "\n")
    lines = raw.split("\n")

    sections: list[tuple[str, str]] = []
    current_title = "Chương 1"
    current_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if stripped and len(stripped) <= 80 and _TEXT_CHAPTER_HEADING_RE.match(stripped):
            if any(l.strip() for l in current_lines):
                body = _MULTI_BLANK_LINES_RE.sub("\n\n", "\n".join(current_lines).strip())
                sections.append((current_title, body))
                current_lines = []
            current_title = stripped
            current_lines.append(stripped)
        else:
            current_lines.append(line)

    if any(l.strip() for l in current_lines):
        body = _MULTI_BLANK_LINES_RE.sub("\n\n", "\n".join(current_lines).strip())
        sections.append((current_title, body))

    return sections


def parse_docx_bytes(file_bytes: bytes) -> list[tuple[str, str]]:
    """Parse a DOCX file into sections (splitting by Heading styles if present)."""
    doc = Document(io.BytesIO(file_bytes))
    sections: list[tuple[str, str]] = []
    current_title = "Chương 1"
    current_paras: list[str] = []

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style_name = (para.style.name or "").lower() if para.style else ""
        is_heading = style_name.startswith("heading") or (
            len(text) <= 80 and bool(_TEXT_CHAPTER_HEADING_RE.match(text))
        )
        if is_heading and current_paras:
            sections.append((current_title, "\n\n".join(current_paras)))
            current_paras = []
            current_title = text
        elif is_heading and not current_paras:
            current_title = text
        current_paras.append(text)

    # Also include table text if present
    for table in doc.tables:
        for row in table.rows:
            row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
            if row_text:
                current_paras.append(row_text)

    if current_paras:
        sections.append((current_title, "\n\n".join(current_paras)))

    return sections


def _split_oversized_paragraph(paragraph: str, max_chars: int) -> list[str]:
    """Split a single paragraph exceeding max_chars cleanly on sentence boundaries."""
    sentences = [s for s in _SENTENCE_SPLIT_RE.split(paragraph) if s]
    if len(sentences) <= 1:
        return [paragraph[i : i + max_chars] for i in range(0, len(paragraph), max_chars)]

    parts: list[str] = []
    buf = ""
    for sent in sentences:
        if buf and len(buf) + len(sent) > max_chars:
            parts.append(buf.strip())
            buf = sent
        else:
            buf += sent
    if buf.strip():
        parts.append(buf.strip())
    return parts


def split_sections_to_chunks(
    sections: list[tuple[str, str]],
    *,
    chunk_min: int = 4000,
    chunk_max: int = 5000,
) -> list[ParsedChapter]:
    """Merge extracted text and split into 4,000-5,000 char chunks strictly on paragraph boundaries."""
    chunk_min = max(500, chunk_min)
    chunk_max = max(chunk_min + 200, chunk_max)

    all_paragraphs: list[str] = []
    for _title, text in sections:
        for para in re.split(r"\n{2,}", text):
            cleaned = para.strip()
            if not cleaned:
                continue
            if len(cleaned) > chunk_max:
                all_paragraphs.extend(_split_oversized_paragraph(cleaned, chunk_max))
            else:
                all_paragraphs.append(cleaned)

    if not all_paragraphs:
        return []

    chunks: list[ParsedChapter] = []
    current_paras: list[str] = []
    current_len = 0

    for para in all_paragraphs:
        sep_len = 2 if current_paras else 0
        projected = current_len + sep_len + len(para)

        if current_paras and projected > chunk_max:
            chunk_text = "\n\n".join(current_paras)
            idx = len(chunks) + 1
            first_line = current_paras[0].splitlines()[0][:50]
            chunks.append(
                ParsedChapter(
                    chapter_index=idx,
                    title=f"Phần {idx} — {first_line}",
                    raw_text=chunk_text,
                )
            )
            current_paras = [para]
            current_len = len(para)
        else:
            current_paras.append(para)
            current_len = projected
            if current_len >= chunk_min:
                # Reached target window [chunk_min, chunk_max] cleanly on a paragraph boundary
                chunk_text = "\n\n".join(current_paras)
                idx = len(chunks) + 1
                first_line = current_paras[0].splitlines()[0][:50]
                chunks.append(
                    ParsedChapter(
                        chapter_index=idx,
                        title=f"Phần {idx} — {first_line}",
                        raw_text=chunk_text,
                    )
                )
                current_paras = []
                current_len = 0

    if current_paras:
        chunk_text = "\n\n".join(current_paras)
        # If the final trailing chunk is very small (< 30% of chunk_min) and fits safely, merge with previous
        if chunks and len(chunk_text) < int(chunk_min * 0.3) and len(chunks[-1].raw_text) + 2 + len(chunk_text) <= int(chunk_max * 1.15):
            prev = chunks[-1]
            chunks[-1] = ParsedChapter(
                chapter_index=prev.chapter_index,
                title=prev.title,
                raw_text=f"{prev.raw_text}\n\n{chunk_text}",
            )
        else:
            idx = len(chunks) + 1
            first_line = current_paras[0].splitlines()[0][:50]
            chunks.append(
                ParsedChapter(
                    chapter_index=idx,
                    title=f"Phần {idx} — {first_line}",
                    raw_text=chunk_text,
                )
            )

    return chunks


def parse_uploaded_book(
    filename: str,
    file_bytes: bytes,
    *,
    split_mode: SplitMode = "epub_chapters",
    keep_furigana: bool = True,
    chunk_min: int = 4000,
    chunk_max: int = 5000,
) -> list[ParsedChapter]:
    """Parse an uploaded .epub, .txt, or .docx file into ParsedChapter records."""
    ext = Path(filename).suffix.lower()
    if ext == ".epub":
        sections = parse_epub_bytes(file_bytes, keep_furigana=keep_furigana)
    elif ext == ".txt":
        sections = parse_txt_bytes(file_bytes)
    elif ext == ".docx":
        sections = parse_docx_bytes(file_bytes)
    else:
        raise ValueError(f"Định dạng '{ext}' không được hỗ trợ. Chỉ chấp nhận .epub, .txt hoặc .docx.")

    if not sections:
        raise ValueError("Không trích xuất được nội dung văn bản nào từ tệp tải lên.")

    if split_mode == "chunk_chars":
        return split_sections_to_chunks(sections, chunk_min=chunk_min, chunk_max=chunk_max)

    # Default: preserve original chapter structure
    return [
        ParsedChapter(
            chapter_index=idx,
            title=title[:200],
            raw_text=raw_text,
        )
        for idx, (title, raw_text) in enumerate(sections, start=1)
    ]


def import_book_to_volume(
    volume_id: int,
    filename: str,
    file_bytes: bytes,
    *,
    split_mode: SplitMode = "epub_chapters",
    keep_furigana: bool = True,
    chunk_min: int = 4000,
    chunk_max: int = 5000,
    replace_existing: bool = True,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Parse uploaded book and save chapters to SQLite `chapters` table for the given volume."""
    chapters = parse_uploaded_book(
        filename,
        file_bytes,
        split_mode=split_mode,
        keep_furigana=keep_furigana,
        chunk_min=chunk_min,
        chunk_max=chunk_max,
    )

    with db_session(db_path) as conn:
        vol_row = conn.execute(
            "SELECT id, series_id, volume_number, title FROM volumes WHERE id = ?",
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

        start_index = 1
        if replace_existing:
            conn.execute("DELETE FROM chapters WHERE volume_id = ?", (volume_id,))
        else:
            max_row = conn.execute(
                "SELECT COALESCE(MAX(chapter_index), 0) AS m FROM chapters WHERE volume_id = ?",
                (volume_id,),
            ).fetchone()
            start_index = int(max_row["m"]) + 1

        saved_chapters: list[dict[str, Any]] = []
        total_chars = 0
        for offset, ch in enumerate(chapters):
            ch_idx = start_index + offset
            total_chars += len(ch.raw_text)
            cur = conn.execute(
                """
                INSERT INTO chapters (volume_id, chapter_index, title, raw_text, status)
                VALUES (?, ?, ?, ?, 'pending')
                """,
                (volume_id, ch_idx, ch.title, ch.raw_text),
            )
            saved_chapters.append(
                {
                    "id": cur.lastrowid,
                    "volume_id": volume_id,
                    "chapter_index": ch_idx,
                    "title": ch.title,
                    "char_count": len(ch.raw_text),
                    "status": "pending",
                }
            )

        conn.execute(
            "UPDATE volumes SET status = 'imported' WHERE id = ?",
            (volume_id,),
        )

    return {
        "volume_id": volume_id,
        "filename": filename,
        "split_mode": split_mode,
        "keep_furigana": keep_furigana,
        "chapters_imported": len(saved_chapters),
        "total_chars": total_chars,
        "chapters": saved_chapters,
    }


def list_volume_chapters(
    volume_id: int, db_path: Path | str | None = None
) -> list[dict[str, Any]]:
    """List chapters belonging to a volume with character counts and preview."""
    with db_session(db_path) as conn:
        vol = conn.execute("SELECT id FROM volumes WHERE id = ?", (volume_id,)).fetchone()
        if vol is None:
            raise LookupError("Không tìm thấy tập truyện.")
        rows: list[sqlite3.Row] = conn.execute(
            """
            SELECT id, volume_id, chapter_index, title,
                   LENGTH(raw_text) AS char_count,
                   SUBSTR(raw_text, 1, 180) AS preview,
                   status, updated_at
            FROM chapters
            WHERE volume_id = ?
            ORDER BY chapter_index ASC
            """,
            (volume_id,),
        ).fetchall()
    return [dict(r) for r in rows]
