"""API routes for importing EPUB/TXT/DOCX books and full Chapter Manager CRUD (paste, rename, delete, merge, split)."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.core.database import db_session
from app.models.schemas import (
    ChapterCreateRequest,
    ChapterDetailResponse,
    ChapterMergeResponse,
    ChapterSplitRequest,
    ChapterSplitResponse,
    ChapterSummaryResponse,
    ChapterUpdateRequest,
    VolumeImportResponse,
)
from app.services.epub_service import (
    SplitMode,
    create_manual_chapter,
    delete_single_chapter,
    import_book_to_volume,
    list_volume_chapters,
    merge_chapter_with_next,
    split_chapter_at_offset,
    update_chapter_metadata,
)

router = APIRouter(prefix="/api", tags=["chapters & import"])


@router.post(
    "/volumes/{volume_id}/import",
    response_model=VolumeImportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def import_volume_book(
    volume_id: int,
    file: UploadFile = File(...),
    split_mode: SplitMode = Form(default="epub_chapters"),
    keep_furigana: bool = Form(default=True),
    chunk_min: int = Form(default=4000),
    chunk_max: int = Form(default=5000),
    replace_existing: bool = Form(default=True),
) -> VolumeImportResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Thiếu tên tệp tải lên.")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Tệp tải lên bị rỗng.")

    try:
        result = import_book_to_volume(
            volume_id=volume_id,
            filename=file.filename,
            file_bytes=file_bytes,
            split_mode=split_mode,
            keep_furigana=keep_furigana,
            chunk_min=chunk_min,
            chunk_max=chunk_max,
            replace_existing=replace_existing,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return VolumeImportResponse(**result)


@router.get("/volumes/{volume_id}/chapters", response_model=list[ChapterSummaryResponse])
def get_volume_chapters(volume_id: int) -> list[ChapterSummaryResponse]:
    try:
        rows = list_volume_chapters(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return [ChapterSummaryResponse(**row) for row in rows]


@router.post(
    "/volumes/{volume_id}/chapters",
    response_model=ChapterSummaryResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_manual_chapter(
    volume_id: int, payload: ChapterCreateRequest
) -> ChapterSummaryResponse:
    try:
        item = create_manual_chapter(
            volume_id,
            title=payload.title,
            raw_text=payload.raw_text,
            insert_after_index=payload.insert_after_index,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ChapterSummaryResponse(**item)


@router.get("/chapters/{chapter_id}", response_model=ChapterDetailResponse)
def get_chapter_detail(chapter_id: int) -> ChapterDetailResponse:
    with db_session() as conn:
        row = conn.execute(
            """
            SELECT id, volume_id, chapter_index, title, raw_text, COALESCE(source_html, '') AS source_html, translated_text, status, updated_at
            FROM chapters
            WHERE id = ?
            """,
            (chapter_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy chương.")
    return ChapterDetailResponse(**dict(row))


@router.patch("/chapters/{chapter_id}", response_model=ChapterSummaryResponse)
def patch_chapter(
    chapter_id: int, payload: ChapterUpdateRequest
) -> ChapterSummaryResponse:
    try:
        item = update_chapter_metadata(
            chapter_id,
            title=payload.title,
            raw_text=payload.raw_text,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ChapterSummaryResponse(**item)


@router.delete("/chapters/{chapter_id}", response_model=dict[str, int])
def remove_single_chapter(chapter_id: int) -> dict[str, int]:
    try:
        return delete_single_chapter(chapter_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/chapters/{chapter_id}/merge-next", response_model=ChapterMergeResponse)
def merge_chapter_next(chapter_id: int) -> ChapterMergeResponse:
    try:
        res = merge_chapter_with_next(chapter_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ChapterMergeResponse(**res)


@router.post("/chapters/{chapter_id}/split", response_model=ChapterSplitResponse)
def split_chapter(
    chapter_id: int, payload: ChapterSplitRequest
) -> ChapterSplitResponse:
    try:
        res = split_chapter_at_offset(
            chapter_id,
            payload.split_offset,
            second_title=payload.second_title,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ChapterSplitResponse(**res)


@router.delete("/volumes/{volume_id}/chapters", status_code=status.HTTP_204_NO_CONTENT)
def clear_volume_chapters(volume_id: int) -> None:
    with db_session() as conn:
        vol = conn.execute("SELECT id FROM volumes WHERE id = ?", (volume_id,)).fetchone()
        if vol is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy tập truyện.")
        conn.execute("DELETE FROM chapters WHERE volume_id = ?", (volume_id,))
