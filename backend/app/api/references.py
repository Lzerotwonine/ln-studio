"""API routes for LN-VN Reference Packs management."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.models.schemas import (
    ReferenceFileDetailResponse,
    ReferenceFileResponse,
    ReferenceFileUpdate,
)
from app.services.reference_service import (
    delete_reference_file,
    get_reference_file,
    list_reference_files,
    sync_reference_files_from_disk,
    update_reference_file,
    upsert_reference_file,
)

router = APIRouter(prefix="/api/references", tags=["reference packs"])


@router.get("", response_model=list[ReferenceFileResponse])
def get_all_references() -> list[ReferenceFileResponse]:
    return [ReferenceFileResponse(**r) for r in list_reference_files()]


@router.get("/{ref_id}", response_model=ReferenceFileDetailResponse)
def get_one_reference(ref_id: int) -> ReferenceFileDetailResponse:
    try:
        item = get_reference_file(ref_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ReferenceFileDetailResponse(**item)


@router.post(
    "/upload",
    response_model=ReferenceFileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_reference_file(
    file: UploadFile = File(...),
    pack_name: str = Form(default="LN-VN Core"),
    use_in_summary: bool = Form(default=False),
    use_in_translate: bool = Form(default=True),
    is_active: bool = Form(default=True),
) -> ReferenceFileResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Thiếu tên tệp tham chiếu.")
    raw = await file.read()
    try:
        item = upsert_reference_file(
            pack_name=pack_name,
            filename=file.filename,
            file_bytes=raw,
            use_in_summary=use_in_summary,
            use_in_translate=use_in_translate,
            is_active=is_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ReferenceFileResponse(**item)


@router.post("/sync-disk", response_model=dict[str, int])
def sync_references_disk() -> dict[str, int]:
    return sync_reference_files_from_disk()


@router.patch("/{ref_id}", response_model=ReferenceFileResponse)
def patch_reference(
    ref_id: int, payload: ReferenceFileUpdate
) -> ReferenceFileResponse:
    try:
        item = update_reference_file(
            ref_id,
            pack_name=payload.pack_name,
            use_in_summary=payload.use_in_summary,
            use_in_translate=payload.use_in_translate,
            is_active=payload.is_active,
            content=payload.content,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ReferenceFileResponse(**item)


@router.delete("/{ref_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_reference(ref_id: int) -> None:
    try:
        delete_reference_file(ref_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
