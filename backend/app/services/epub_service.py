"""EPUB, TXT, and DOCX import service with comprehensive ruby/furigana and splitting support."""

from __future__ import annotations

import hashlib
import io
import os
import posixpath
import re
import shutil
import sqlite3
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

import ebooklib
from bs4 import BeautifulSoup, NavigableString, Tag, XMLParsedAsHTMLWarning
from docx import Document
from ebooklib import epub

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

from app.core.database import PROJECT_ROOT, db_session

SplitMode = Literal["epub_chapters", "chunk_chars"]

_SAFE_MEDIA_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def get_media_root() -> Path:
    env_dir = os.environ.get("LN_STUDIO_MEDIA_DIR")
    if env_dir:
        return Path(env_dir)
    return PROJECT_ROOT / "data" / "media"


def get_volume_media_dir(volume_id: int) -> Path:
    return get_media_root() / f"vol_{volume_id}"


def cleanup_volume_media(volume_id: int) -> None:
    media_dir = get_volume_media_dir(volume_id)
    if media_dir.is_dir():
        shutil.rmtree(media_dir, ignore_errors=True)


def list_volume_media(volume_id: int) -> list[dict[str, Any]]:
    media_dir = get_volume_media_dir(volume_id)
    if not media_dir.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for f in sorted(media_dir.iterdir()):
        if f.is_file():
            items.append(
                {
                    "filename": f.name,
                    "url": f"/api/media/vol_{volume_id}/{f.name}",
                    "size_bytes": f.stat().st_size,
                }
            )
    return items


def detect_image_ext(data: bytes) -> str | None:
    """Validate image bytes via magic headers without requiring Pillow."""
    if not data or len(data) < 8:
        return None
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data[:4] == b"RIFF" and len(data) >= 12 and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith(b"BM"):
        return ".bmp"
    return None


def _sanitize_media_filename(raw_name: str, fallback_ext: str, content_bytes: bytes) -> str:
    base = Path(raw_name).name
    stem = _SAFE_MEDIA_NAME_RE.sub("_", Path(base).stem).strip("._") or "img"
    ext = Path(base).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}:
        ext = fallback_ext
    short_hash = hashlib.sha256(content_bytes).hexdigest()[:8]
    return f"{stem[:40]}_{short_hash}{ext}"

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


def _extract_img_href(tag: Tag) -> str:
    for attr in ("src", "href", "xlink:href", "{http://www.w3.org/1999/xlink}href"):
        val = tag.get(attr)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def html_to_clean_text(
    html_bytes: bytes | str,
    keep_furigana: bool = True,
    *,
    image_resolver: Callable[[str], str | None] | None = None,
) -> tuple[str, str]:
    """Convert an EPUB XHTML/HTML document to (title, clean_text) preserving block boundaries and illustrations."""
    try:
        soup = BeautifulSoup(html_bytes, "lxml")
    except Exception:
        soup = BeautifulSoup(html_bytes, "html.parser")

    doc_title = ""
    if soup.title and soup.title.string:
        doc_title = soup.title.string.strip()

    body = soup.body if soup.body is not None else soup

    # Replace illustration tags (<img>, <image>, <svg:image>) with Markdown image markers BEFORE stripping <svg>
    if image_resolver is not None:
        for img_tag in list(body.find_all(["img", "image", "svg:image"])):
            href = _extract_img_href(img_tag)
            if not href:
                continue
            md_line = image_resolver(href)
            if not md_line:
                continue
            parent_svg = img_tag.find_parent("svg")
            marker = NavigableString(f"\n{md_line}\n")
            if parent_svg is not None and not parent_svg.get_text(strip=True):
                parent_svg.replace_with(marker)
            else:
                img_tag.replace_with(marker)

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
    volume_id: int | None = None,
) -> list[tuple[str, str]]:
    """Read an EPUB strictly in spine order, extracting illustrations when volume_id is provided."""
    # ebooklib.epub.read_epub requires a filesystem path
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = Path(tmp.name)

    try:
        book = epub.read_epub(str(tmp_path), options={"ignore_ncx": False})
    finally:
        tmp_path.unlink(missing_ok=True)

    # Index all image resources inside the EPUB for fast lookup
    epub_images_by_path: dict[str, tuple[str, bytes]] = {}
    epub_images_by_name: dict[str, tuple[str, bytes]] = {}
    for res in book.get_items():
        if res.get_type() == ebooklib.ITEM_IMAGE or (res.media_type or "").startswith("image/"):
            res_name = (res.get_name() or "").replace("\\", "/").lstrip("./")
            data = res.get_content() or b""
            ext = detect_image_ext(data)
            if not ext:
                continue
            norm_p = posixpath.normpath(res_name)
            epub_images_by_path[norm_p.lower()] = (res_name, data)
            epub_images_by_name[Path(norm_p).name.lower()] = (res_name, data)

    media_dir: Path | None = None
    saved_cache: dict[str, str] = {}
    if volume_id is not None and epub_images_by_path:
        media_dir = get_volume_media_dir(volume_id)
        media_dir.mkdir(parents=True, exist_ok=True)

    toc_titles = _build_toc_title_map(book)
    sections: list[tuple[str, str]] = []

    for spine_entry in book.spine:
        idref = spine_entry[0] if isinstance(spine_entry, tuple) else str(spine_entry)
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue

        item_name = (item.get_name() or "").replace("\\", "/").lstrip("./")
        doc_dir = posixpath.dirname(item_name)

        def _resolve_image(href: str) -> str | None:
            if volume_id is None or media_dir is None:
                return None
            clean_href = href.split("#")[0].split("?")[0].replace("\\", "/")
            joined = posixpath.normpath(posixpath.join(doc_dir, clean_href)).lstrip("./")
            found = epub_images_by_path.get(joined.lower()) or epub_images_by_name.get(
                Path(clean_href).name.lower()
            )
            if found is None:
                return None
            orig_name, img_bytes = found
            ext = detect_image_ext(img_bytes)
            if not ext:
                return None
            digest = hashlib.sha256(img_bytes).hexdigest()
            if digest not in saved_cache:
                safe_fname = _sanitize_media_filename(orig_name, ext, img_bytes)
                (media_dir / safe_fname).write_bytes(img_bytes)
                saved_cache[digest] = safe_fname
            fname = saved_cache[digest]
            return f"![image:{fname}](/api/media/vol_{volume_id}/{fname})"

        raw_content = item.get_content()
        html_title, clean_text = html_to_clean_text(
            raw_content,
            keep_furigana=keep_furigana,
            image_resolver=_resolve_image if volume_id is not None else None,
        )
        if not clean_text or len(clean_text.strip()) < 2:
            continue

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
    volume_id: int | None = None,
) -> list[ParsedChapter]:
    """Parse an uploaded .epub, .txt, or .docx file into ParsedChapter records."""
    ext = Path(filename).suffix.lower()
    if ext == ".epub":
        sections = parse_epub_bytes(
            file_bytes, keep_furigana=keep_furigana, volume_id=volume_id
        )
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
    with db_session(db_path) as conn:
        vol_row = conn.execute(
            "SELECT id, series_id, volume_number, title FROM volumes WHERE id = ?",
            (volume_id,),
        ).fetchone()
        if vol_row is None:
            raise LookupError("Không tìm thấy tập truyện.")

    if replace_existing and Path(filename).suffix.lower() == ".epub":
        cleanup_volume_media(volume_id)

    chapters = parse_uploaded_book(
        filename,
        file_bytes,
        split_mode=split_mode,
        keep_furigana=keep_furigana,
        chunk_min=chunk_min,
        chunk_max=chunk_max,
        volume_id=volume_id,
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
    """List chapters belonging to a volume with raw/translated character counts and preview."""
    with db_session(db_path) as conn:
        vol = conn.execute("SELECT id FROM volumes WHERE id = ?", (volume_id,)).fetchone()
        if vol is None:
            raise LookupError("Không tìm thấy tập truyện.")
        rows: list[sqlite3.Row] = conn.execute(
            """
            SELECT id, volume_id, chapter_index, title,
                   LENGTH(raw_text) AS char_count,
                   LENGTH(raw_text) AS raw_chars,
                   LENGTH(translated_text) AS translated_chars,
                   CASE WHEN masked_raw_text IS NOT NULL AND TRIM(masked_raw_text) != '' THEN 1 ELSE 0 END AS has_mask,
                   COALESCE(char_ratio, 0.0) AS char_ratio,
                   SUBSTR(raw_text, 1, 180) AS preview,
                   status, updated_at
            FROM chapters
            WHERE volume_id = ?
            ORDER BY chapter_index ASC
            """,
            (volume_id,),
        ).fetchall()
    result = []
    for r in rows:
        item = dict(r)
        item["has_mask"] = bool(item["has_mask"])
        item["char_ratio"] = float(item["char_ratio"] or 0.0)
        result.append(item)
    return result


def _reindex_volume_chapters(conn: sqlite3.Connection, volume_id: int) -> int:
    """Safely renumber chapters 1..N without hitting UNIQUE(volume_id, chapter_index)."""
    rows = conn.execute(
        "SELECT id FROM chapters WHERE volume_id = ? ORDER BY chapter_index ASC, id ASC",
        (volume_id,),
    ).fetchall()
    # Two-pass temporary negative indices prevent UNIQUE constraint collisions
    for offset, row in enumerate(rows, start=1):
        conn.execute(
            "UPDATE chapters SET chapter_index = ? WHERE id = ?",
            (-offset, int(row["id"])),
        )
    for idx, row in enumerate(rows, start=1):
        conn.execute(
            "UPDATE chapters SET chapter_index = ? WHERE id = ?",
            (idx, int(row["id"])),
        )
    return len(rows)


def create_manual_chapter(
    volume_id: int,
    *,
    title: str = "",
    raw_text: str,
    insert_after_index: int | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Create a chapter by pasting raw text directly into a volume."""
    cleaned_raw = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not cleaned_raw:
        raise ValueError("Nội dung văn bản gốc không được để trống.")

    with db_session(db_path) as conn:
        vol = conn.execute("SELECT id FROM volumes WHERE id = ?", (volume_id,)).fetchone()
        if vol is None:
            raise LookupError("Không tìm thấy tập truyện.")

        existing = conn.execute(
            "SELECT id, chapter_index FROM chapters WHERE volume_id = ? ORDER BY chapter_index ASC",
            (volume_id,),
        ).fetchall()
        total = len(existing)

        if insert_after_index is None or insert_after_index >= total:
            target_idx = total + 1
        else:
            target_idx = max(1, insert_after_index + 1)
            # Shift chapters >= target_idx up by 1 using temporary negative offsets
            to_shift = [r for r in existing if int(r["chapter_index"]) >= target_idx]
            for r in to_shift:
                conn.execute(
                    "UPDATE chapters SET chapter_index = ? WHERE id = ?",
                    (-(int(r["chapter_index"]) + 1), int(r["id"])),
                )
            for r in to_shift:
                conn.execute(
                    "UPDATE chapters SET chapter_index = ? WHERE id = ?",
                    (int(r["chapter_index"]) + 1, int(r["id"])),
                )

        effective_title = title.strip() or f"Chương {target_idx}"
        cur = conn.execute(
            """
            INSERT INTO chapters (volume_id, chapter_index, title, raw_text, status)
            VALUES (?, ?, ?, ?, 'pending')
            """,
            (volume_id, target_idx, effective_title, cleaned_raw),
        )
        new_id = int(cur.lastrowid)
        row = conn.execute(
            """
            SELECT id, volume_id, chapter_index, title,
                   LENGTH(raw_text) AS char_count,
                   LENGTH(raw_text) AS raw_chars,
                   LENGTH(translated_text) AS translated_chars,
                   0 AS has_mask,
                   COALESCE(char_ratio, 0.0) AS char_ratio,
                   SUBSTR(raw_text, 1, 180) AS preview,
                   status, updated_at
            FROM chapters WHERE id = ?
            """,
            (new_id,),
        ).fetchone()
    item = dict(row)
    item["has_mask"] = False
    item["char_ratio"] = float(item["char_ratio"] or 0.0)
    return item


def update_chapter_metadata(
    chapter_id: int,
    *,
    title: str | None = None,
    raw_text: str | None = None,
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Rename a chapter or edit its raw text."""
    updates: list[str] = []
    params: list[Any] = []
    if title is not None:
        updates.append("title = ?")
        params.append(title.strip())
    if raw_text is not None:
        cleaned = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not cleaned:
            raise ValueError("Nội dung văn bản gốc không được để trống.")
        updates.append("raw_text = ?")
        params.append(cleaned)

    with db_session(db_path) as conn:
        existing = conn.execute(
            "SELECT id, chapter_index FROM chapters WHERE id = ?", (chapter_id,)
        ).fetchone()
        if existing is None:
            raise LookupError("Không tìm thấy chương.")
        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(chapter_id)
            conn.execute(f"UPDATE chapters SET {', '.join(updates)} WHERE id = ?", params)

        row = conn.execute(
            """
            SELECT id, volume_id, chapter_index, title,
                   LENGTH(raw_text) AS char_count,
                   LENGTH(raw_text) AS raw_chars,
                   LENGTH(translated_text) AS translated_chars,
                   CASE WHEN masked_raw_text IS NOT NULL AND TRIM(masked_raw_text) != '' THEN 1 ELSE 0 END AS has_mask,
                   COALESCE(char_ratio, 0.0) AS char_ratio,
                   SUBSTR(raw_text, 1, 180) AS preview,
                   status, updated_at
            FROM chapters WHERE id = ?
            """,
            (chapter_id,),
        ).fetchone()
    item = dict(row)
    item["has_mask"] = bool(item["has_mask"])
    item["char_ratio"] = float(item["char_ratio"] or 0.0)
    return item


def delete_single_chapter(
    chapter_id: int, db_path: Path | str | None = None
) -> dict[str, int]:
    """Delete a single chapter and re-index remaining chapters 1..N."""
    with db_session(db_path) as conn:
        row = conn.execute(
            "SELECT id, volume_id FROM chapters WHERE id = ?", (chapter_id,)
        ).fetchone()
        if row is None:
            raise LookupError("Không tìm thấy chương.")
        volume_id = int(row["volume_id"])
        conn.execute("DELETE FROM chapters WHERE id = ?", (chapter_id,))
        remaining = _reindex_volume_chapters(conn, volume_id)
    return {"deleted_chapter_id": chapter_id, "remaining_chapters": remaining}


def merge_chapter_with_next(
    chapter_id: int, db_path: Path | str | None = None
) -> dict[str, Any]:
    """Merge the given chapter with the immediately following chapter in the same volume."""
    with db_session(db_path) as conn:
        curr = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if curr is None:
            raise LookupError("Không tìm thấy chương.")
        volume_id = int(curr["volume_id"])
        curr_idx = int(curr["chapter_index"])

        nxt = conn.execute(
            """
            SELECT * FROM chapters
            WHERE volume_id = ? AND chapter_index > ?
            ORDER BY chapter_index ASC
            LIMIT 1
            """,
            (volume_id, curr_idx),
        ).fetchone()
        if nxt is None:
            raise ValueError("Đây là chương cuối cùng, không có chương kế tiếp để gộp.")

        merged_raw = f"{str(curr['raw_text']).rstrip()}\n\n{str(nxt['raw_text']).lstrip()}"
        curr_tr = str(curr["translated_text"] or "").strip()
        nxt_tr = str(nxt["translated_text"] or "").strip()
        merged_tr = "\n\n".join(p for p in (curr_tr, nxt_tr) if p)

        curr_mask = str(curr["masked_raw_text"] or "").strip()
        nxt_mask = str(nxt["masked_raw_text"] or "").strip()
        merged_mask: str | None = None
        if curr_mask or nxt_mask:
            merged_mask = f"{curr_mask or str(curr['raw_text']).rstrip()}\n\n{nxt_mask or str(nxt['raw_text']).lstrip()}"

        new_ratio = round(len(merged_tr) / max(1, len(merged_raw)), 4) if merged_tr else 0.0
        new_status = "completed" if (curr["status"] == "completed" and nxt["status"] == "completed") else "pending"

        conn.execute(
            """
            UPDATE chapters
            SET raw_text = ?,
                translated_text = ?,
                masked_raw_text = ?,
                summary_json = NULL,
                char_ratio = ?,
                status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (merged_raw, merged_tr, merged_mask, new_ratio, new_status, chapter_id),
        )
        nxt_id = int(nxt["id"])
        conn.execute("DELETE FROM chapters WHERE id = ?", (nxt_id,))
        total = _reindex_volume_chapters(conn, volume_id)
        refreshed = conn.execute(
            "SELECT chapter_index, title FROM chapters WHERE id = ?", (chapter_id,)
        ).fetchone()

    return {
        "merged_chapter_id": chapter_id,
        "deleted_chapter_id": nxt_id,
        "chapter_index": int(refreshed["chapter_index"]),
        "title": str(refreshed["title"] or ""),
        "raw_chars": len(merged_raw),
        "total_chapters": total,
    }


def split_chapter_at_offset(
    chapter_id: int,
    split_offset: int,
    *,
    second_title: str = "",
    db_path: Path | str | None = None,
) -> dict[str, Any]:
    """Split a chapter's raw_text at `split_offset` into two consecutive chapters."""
    with db_session(db_path) as conn:
        curr = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if curr is None:
            raise LookupError("Không tìm thấy chương.")

        raw_text = str(curr["raw_text"] or "")
        if split_offset <= 0 or split_offset >= len(raw_text):
            raise ValueError("Vị trí tách con trỏ phải nằm giữa phần đầu và phần cuối văn bản.")

        part1 = raw_text[:split_offset].strip()
        part2 = raw_text[split_offset:].strip()
        if not part1 or not part2:
            raise ValueError("Cả 2 phần sau khi tách đều phải có nội dung văn bản.")

        volume_id = int(curr["volume_id"])
        curr_idx = int(curr["chapter_index"])
        orig_title = str(curr["title"] or f"Chương {curr_idx}")
        part2_title = second_title.strip() or f"{orig_title} (Phần 2)"

        # Shift all chapters after curr_idx up by 1 safely via negative temporary indices
        later_rows = conn.execute(
            "SELECT id, chapter_index FROM chapters WHERE volume_id = ? AND chapter_index > ? ORDER BY chapter_index DESC",
            (volume_id, curr_idx),
        ).fetchall()
        for r in later_rows:
            conn.execute(
                "UPDATE chapters SET chapter_index = ? WHERE id = ?",
                (-(int(r["chapter_index"]) + 1), int(r["id"])),
            )
        for r in later_rows:
            conn.execute(
                "UPDATE chapters SET chapter_index = ? WHERE id = ?",
                (int(r["chapter_index"]) + 1, int(r["id"])),
            )

        # Update original chapter with part 1
        conn.execute(
            """
            UPDATE chapters
            SET raw_text = ?,
                masked_raw_text = NULL,
                summary_json = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (part1, chapter_id),
        )

        # Insert part 2 immediately after at curr_idx + 1
        cur = conn.execute(
            """
            INSERT INTO chapters (volume_id, chapter_index, title, raw_text, status)
            VALUES (?, ?, ?, ?, 'pending')
            """,
            (volume_id, curr_idx + 1, part2_title, part2),
        )
        second_id = int(cur.lastrowid)
        total = _reindex_volume_chapters(conn, volume_id)

    return {
        "first_chapter_id": chapter_id,
        "second_chapter_id": second_id,
        "first_chapter_index": curr_idx,
        "second_chapter_index": curr_idx + 1,
        "total_chapters": total,
    }
