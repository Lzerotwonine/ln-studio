"""API routes for sensitive_masks dictionary (multi-lang + bulk import) and blocked chapter Scan & Mask."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from app.core.gemini_pool import NoAvailableSlotsError
from app.models.schemas import (
    ApplyMasksRequest,
    ApplyMasksResponse,
    MaskSourceLang,
    SensitiveMaskBulkImportRequest,
    SensitiveMaskBulkImportResponse,
    SensitiveMaskCreate,
    SensitiveMaskResponse,
    SensitiveMaskUpdate,
    SensitiveScanResponse,
)
from app.services.mask_service import (
    apply_masks_to_chapter,
    bulk_import_masks,
    delete_mask,
    list_masks,
    scan_sensitive_phrases,
    seed_default_masks,
    update_mask,
    upsert_mask,
)

router = APIRouter(prefix="/api", tags=["sensitive masks"])


@router.get("/masks", response_model=list[SensitiveMaskResponse])
def get_masks(
    series_id: int | None = Query(default=None),
    include_global: bool = Query(default=True),
    only_global: bool = Query(default=False),
    source_lang: MaskSourceLang | None = Query(default=None),
    search: str | None = Query(default=None),
) -> list[SensitiveMaskResponse]:
    rows = list_masks(
        series_id=series_id,
        include_global=include_global,
        only_global=only_global,
        source_lang=source_lang,
        search=search,
    )
    return [SensitiveMaskResponse(**r) for r in rows]


@router.post(
    "/masks",
    response_model=SensitiveMaskResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_sensitive_mask(payload: SensitiveMaskCreate) -> SensitiveMaskResponse:
    try:
        row = upsert_mask(
            series_id=payload.series_id,
            source_lang=payload.source_lang,
            raw_phrase=payload.raw_phrase,
            safe_replacement=payload.safe_replacement,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return SensitiveMaskResponse(**row)


@router.post("/masks/bulk-import", response_model=SensitiveMaskBulkImportResponse)
def import_sensitive_masks_bulk(
    payload: SensitiveMaskBulkImportRequest,
) -> SensitiveMaskBulkImportResponse:
    try:
        res = bulk_import_masks(
            payload.text,
            series_id=payload.series_id,
            source_lang=payload.source_lang,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return SensitiveMaskBulkImportResponse(**res)


@router.post("/masks/seed-default", response_model=SensitiveMaskBulkImportResponse)
def seed_sensitive_masks_default() -> SensitiveMaskBulkImportResponse:
    try:
        res = seed_default_masks()
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return SensitiveMaskBulkImportResponse(**res)


@router.patch("/masks/{mask_id}", response_model=SensitiveMaskResponse)
def patch_sensitive_mask(
    mask_id: int, payload: SensitiveMaskUpdate
) -> SensitiveMaskResponse:
    try:
        row = update_mask(
            mask_id,
            source_lang=payload.source_lang,
            raw_phrase=payload.raw_phrase,
            safe_replacement=payload.safe_replacement,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return SensitiveMaskResponse(**row)


@router.delete("/masks/{mask_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_sensitive_mask(mask_id: int) -> None:
    try:
        delete_mask(mask_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post(
    "/chapters/{chapter_id}/scan-sensitive",
    response_model=SensitiveScanResponse,
)
def scan_chapter_sensitive(
    chapter_id: int,
    model_override: str | None = Query(default=None),
) -> SensitiveScanResponse:
    try:
        res = scan_sensitive_phrases(chapter_id, model_override=model_override)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except NoAvailableSlotsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi khi quét từ nhạy cảm: {exc}")
    return SensitiveScanResponse(**res)


@router.post(
    "/chapters/{chapter_id}/apply-masks",
    response_model=ApplyMasksResponse,
)
def apply_chapter_masks(
    chapter_id: int, payload: ApplyMasksRequest
) -> ApplyMasksResponse:
    try:
        res = apply_masks_to_chapter(
            chapter_id,
            extra_masks=[m.model_dump() for m in payload.extra_masks],
            save_to_db=payload.save_to_db,
            scope=payload.scope,
            clear_mask=payload.clear_mask,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ApplyMasksResponse(**res)
