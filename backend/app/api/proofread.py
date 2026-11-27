"""API routes for side-by-side Proofreading, Find & Replace, Selection Retranslation, and DOCX/EPUB Export."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response

from app.core.gemini_pool import NoAvailableSlotsError
from app.models.schemas import (
    ChapterProofreadResponse,
    FindReplaceRequest,
    FindReplaceResponse,
    RetranslateSelectionRequest,
    RetranslateSelectionResponse,
    SaveTranslationRequest,
    SaveTranslationResponse,
)
from app.services.export_service import (
    export_volume_docx,
    export_volume_epub,
    find_replace_volume,
    get_chapter_proofread_data,
    retranslate_selection,
    save_chapter_translation,
)

router = APIRouter(prefix="/api", tags=["proofread & export"])


@router.get(
    "/chapters/{chapter_id}/proofread",
    response_model=ChapterProofreadResponse,
)
def get_proofread_chapter(chapter_id: int) -> ChapterProofreadResponse:
    try:
        data = get_chapter_proofread_data(chapter_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ChapterProofreadResponse(**data)


@router.patch(
    "/chapters/{chapter_id}/translation",
    response_model=SaveTranslationResponse,
)
def patch_chapter_translation(
    chapter_id: int, payload: SaveTranslationRequest
) -> SaveTranslationResponse:
    try:
        res = save_chapter_translation(chapter_id, payload.translated_text)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return SaveTranslationResponse(**res)


@router.post(
    "/volumes/{volume_id}/find-replace",
    response_model=FindReplaceResponse,
)
def volume_find_replace(
    volume_id: int, payload: FindReplaceRequest
) -> FindReplaceResponse:
    try:
        res = find_replace_volume(
            volume_id,
            payload.find_text,
            payload.replace_text,
            use_regex=payload.use_regex,
            case_sensitive=payload.case_sensitive,
            dry_run=payload.dry_run,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return FindReplaceResponse(**res)


@router.post(
    "/chapters/{chapter_id}/retranslate-selection",
    response_model=RetranslateSelectionResponse,
)
def retranslate_chapter_selection(
    chapter_id: int, payload: RetranslateSelectionRequest
) -> RetranslateSelectionResponse:
    try:
        res = retranslate_selection(
            chapter_id,
            payload.selected_text,
            source_side=payload.source_side,
            instruction=payload.instruction,
            temperature=payload.temperature,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except NoAvailableSlotsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi khi dịch lại đoạn bôi đen: {exc}")
    return RetranslateSelectionResponse(**res)


@router.get("/volumes/{volume_id}/export/docx")
def download_volume_docx(
    volume_id: int,
    font: Literal["Times New Roman", "Cambria"] = Query(default="Times New Roman"),
) -> Response:
    try:
        filename, content = export_volume_docx(volume_id, font_name=font)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/volumes/{volume_id}/export/epub")
def download_volume_epub(volume_id: int) -> Response:
    try:
        filename, content = export_volume_epub(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(
        content=content,
        media_type="application/epub+zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
