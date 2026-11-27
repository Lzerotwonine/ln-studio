"""Media serving and listing routes for extracted EPUB illustrations."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.models.schemas import VolumeMediaItem
from app.services.epub_service import get_volume_media_dir, list_volume_media

router = APIRouter(prefix="/api", tags=["media"])


@router.get("/media/vol_{volume_id}/{filename}")
def serve_volume_media_file(volume_id: int, filename: str) -> FileResponse:
    if "/" in filename or "\\" in filename or ".." in filename or not filename.strip():
        raise HTTPException(status_code=400, detail="Tên tệp ảnh không hợp lệ.")
    media_dir = get_volume_media_dir(volume_id).resolve()
    target = (media_dir / filename).resolve()
    try:
        target.relative_to(media_dir)
    except ValueError:
        raise HTTPException(status_code=400, detail="Đường dẫn ảnh không hợp lệ.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh minh họa.")
    return FileResponse(
        str(target),
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/volumes/{volume_id}/media", response_model=list[VolumeMediaItem])
def get_volume_media_list(volume_id: int) -> list[VolumeMediaItem]:
    return [VolumeMediaItem(**item) for item in list_volume_media(volume_id)]
