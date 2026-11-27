"""CRUD, extraction, Gemini batch translation, bulk operations, and TSV/CSV/XML I/O routes for Master Glossary."""

from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile, status

from app.core.database import db_session
from app.core.gemini_pool import NoAvailableSlotsError
from app.models.schemas import (
    GlossaryBulkDeleteRequest,
    GlossaryBulkStatusRequest,
    GlossaryBulkTypeRequest,
    GlossaryDuplicateMode,
    GlossaryExtractRequest,
    GlossaryExtractResponse,
    GlossaryImportResponse,
    GlossaryListResponse,
    GlossarySortBy,
    GlossaryStatus,
    GlossaryTermCreate,
    GlossaryTermResponse,
    GlossaryTermUpdate,
    GlossaryTranslateRequest,
    GlossaryTranslateResponse,
    GlossaryTranslateSelectedRequest,
    SortDir,
)
from app.services.glossary_service import (
    bulk_delete_glossary_terms_service,
    bulk_update_glossary_status_service,
    bulk_update_glossary_type_service,
    export_glossary_tabular,
    extract_volume_glossary,
    import_glossary_tabular,
    list_glossary_terms,
    render_glossary_xml,
    translate_new_glossary_terms,
    translate_selected_glossary_terms,
)
from app.services.languages import normalize_term_key

router = APIRouter(prefix="/api", tags=["glossary"])


@router.post(
    "/volumes/{volume_id}/glossary/extract",
    response_model=GlossaryExtractResponse,
)
def extract_glossary_for_volume(
    volume_id: int,
    payload: GlossaryExtractRequest | None = None,
) -> GlossaryExtractResponse:
    min_freq = payload.min_freq if payload else 1
    try:
        res = extract_volume_glossary(volume_id, min_freq=min_freq)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return GlossaryExtractResponse(**res)


@router.post(
    "/series/{series_id}/glossary/translate-new",
    response_model=GlossaryTranslateResponse,
)
def translate_new_terms(
    series_id: int,
    payload: GlossaryTranslateRequest | None = None,
) -> GlossaryTranslateResponse:
    req = payload or GlossaryTranslateRequest()
    try:
        res = translate_new_glossary_terms(
            series_id=series_id,
            volume_id=req.volume_id,
            batch_size=req.batch_size,
            max_rounds=req.max_rounds,
            model_override=req.model_override,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except NoAvailableSlotsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi khi gọi Gemini dịch thuật ngữ: {exc}")
    return GlossaryTranslateResponse(**res)


@router.post(
    "/series/{series_id}/glossary/translate-selected",
    response_model=GlossaryTranslateResponse,
)
def translate_selected_terms(
    series_id: int,
    payload: GlossaryTranslateSelectedRequest,
) -> GlossaryTranslateResponse:
    try:
        res = translate_selected_glossary_terms(
            series_id=series_id,
            term_ids=payload.term_ids,
            apply_to_filter=payload.apply_to_filter,
            filter_criteria=payload.filter.model_dump() if payload.filter else None,
            exclude_ids=payload.exclude_ids,
            batch_size=payload.batch_size,
            max_rounds=payload.max_rounds,
            model_override=payload.model_override,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except NoAvailableSlotsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi khi gọi Gemini dịch lại thuật ngữ: {exc}")
    return GlossaryTranslateResponse(**res)


@router.get("/series/{series_id}/glossary", response_model=GlossaryListResponse)
def get_series_glossary(
    series_id: int,
    volume_id: int | None = Query(default=None),
    status_filter: GlossaryStatus | None = Query(default=None, alias="status"),
    term_type: str | None = Query(default=None),
    min_freq: int | None = Query(default=None, ge=1),
    max_freq: int | None = Query(default=None, ge=1),
    missing_vi: bool = Query(default=False),
    missing_han_viet: bool = Query(default=False),
    first_seen_vol: int | None = Query(default=None, ge=0),
    search: str | None = Query(default=None),
    sort_by: GlossarySortBy = Query(default="freq"),
    sort_dir: SortDir = Query(default="desc"),
    limit: int = Query(default=100, ge=0, le=100000),
    offset: int = Query(default=0, ge=0),
) -> GlossaryListResponse:
    try:
        data = list_glossary_terms(
            series_id,
            volume_id=volume_id,
            status_filter=status_filter,
            term_type=term_type,
            min_freq=min_freq,
            max_freq=max_freq,
            missing_vi=missing_vi,
            missing_han_viet=missing_han_viet,
            first_seen_vol=first_seen_vol,
            search=search,
            sort_by=sort_by,
            sort_dir=sort_dir,
            limit=limit,
            offset=offset,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return GlossaryListResponse(**data)


@router.post(
    "/series/{series_id}/glossary",
    response_model=GlossaryTermResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_glossary_term(
    series_id: int, payload: GlossaryTermCreate
) -> GlossaryTermResponse:
    norm = normalize_term_key(payload.source_term)
    if not norm:
        raise HTTPException(status_code=422, detail="Thuật ngữ gốc không được để trống.")

    with db_session() as conn:
        if conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")
        try:
            cur = conn.execute(
                """
                INSERT INTO glossary_terms (
                    series_id, source_term, normalized_key,
                    vi_term, reading, han_viet, english_meaning,
                    term_type, status, first_seen_vol, total_freq
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    series_id,
                    payload.source_term,
                    norm,
                    payload.vi_term,
                    payload.reading,
                    payload.han_viet,
                    payload.english_meaning,
                    payload.term_type,
                    payload.status,
                    payload.first_seen_vol,
                    payload.total_freq,
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Thuật ngữ '{payload.source_term}' đã tồn tại trong Master Glossary.",
            )
        row = conn.execute(
            "SELECT *, NULL AS volume_freq FROM glossary_terms WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
    return GlossaryTermResponse(**dict(row))


@router.patch("/glossary/{term_id}", response_model=GlossaryTermResponse)
def update_glossary_term(
    term_id: int, payload: GlossaryTermUpdate
) -> GlossaryTermResponse:
    updates: list[str] = []
    params: list[Any] = []
    for field_name in (
        "vi_term",
        "reading",
        "han_viet",
        "english_meaning",
        "term_type",
        "status",
    ):
        val = getattr(payload, field_name)
        if val is not None:
            updates.append(f"{field_name} = ?")
            params.append(val)

    with db_session() as conn:
        existing = conn.execute(
            "SELECT id FROM glossary_terms WHERE id = ?", (term_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy thuật ngữ.")
        if updates:
            params.append(term_id)
            conn.execute(
                f"UPDATE glossary_terms SET {', '.join(updates)} WHERE id = ?",
                params,
            )
        row = conn.execute(
            "SELECT *, NULL AS volume_freq FROM glossary_terms WHERE id = ?",
            (term_id,),
        ).fetchone()
    return GlossaryTermResponse(**dict(row))


@router.delete("/glossary/{term_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_glossary_term(term_id: int) -> None:
    with db_session() as conn:
        cur = conn.execute("DELETE FROM glossary_terms WHERE id = ?", (term_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Không tìm thấy thuật ngữ.")


@router.post("/glossary/bulk-status", response_model=dict[str, int])
def bulk_update_glossary_status(payload: GlossaryBulkStatusRequest) -> dict[str, int]:
    try:
        updated = bulk_update_glossary_status_service(
            payload.status,
            series_id=payload.series_id,
            term_ids=payload.term_ids,
            apply_to_filter=payload.apply_to_filter,
            filter_criteria=payload.filter.model_dump() if payload.filter else None,
            exclude_ids=payload.exclude_ids,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"updated": updated}


@router.post("/glossary/bulk-type", response_model=dict[str, int])
def bulk_update_glossary_type(payload: GlossaryBulkTypeRequest) -> dict[str, int]:
    try:
        updated = bulk_update_glossary_type_service(
            payload.term_type,
            series_id=payload.series_id,
            term_ids=payload.term_ids,
            apply_to_filter=payload.apply_to_filter,
            filter_criteria=payload.filter.model_dump() if payload.filter else None,
            exclude_ids=payload.exclude_ids,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"updated": updated}


@router.post("/glossary/bulk-delete", response_model=dict[str, int])
def bulk_delete_glossary_terms(payload: GlossaryBulkDeleteRequest) -> dict[str, int]:
    try:
        deleted = bulk_delete_glossary_terms_service(
            series_id=payload.series_id,
            term_ids=payload.term_ids,
            apply_to_filter=payload.apply_to_filter,
            filter_criteria=payload.filter.model_dump() if payload.filter else None,
            exclude_ids=payload.exclude_ids,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"deleted": deleted}


@router.post(
    "/series/{series_id}/glossary/import",
    response_model=GlossaryImportResponse,
)
async def import_glossary_file(
    series_id: int,
    file: UploadFile = File(...),
    default_status: GlossaryStatus = Form(default="approved"),
    duplicate_mode: GlossaryDuplicateMode = Form(default="upsert"),
    default_first_seen_vol: int = Form(default=0),
    force_default_status: bool = Form(default=True),
) -> GlossaryImportResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Thiếu tên tệp TSV/CSV.")
    raw = await file.read()
    try:
        res = import_glossary_tabular(
            series_id,
            file.filename,
            raw,
            default_status=default_status,
            duplicate_mode=duplicate_mode,
            default_first_seen_vol=default_first_seen_vol,
            force_default_status=force_default_status,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return GlossaryImportResponse(**res)


@router.get("/series/{series_id}/glossary/export")
def export_glossary_file(
    series_id: int,
    fmt: Literal["tsv", "csv"] = Query(default="tsv", alias="format"),
    volume_id: int | None = Query(default=None),
    status_filter: GlossaryStatus | None = Query(default=None, alias="status"),
    term_type: str | None = Query(default=None),
    min_freq: int | None = Query(default=None, ge=1),
    max_freq: int | None = Query(default=None, ge=1),
    missing_vi: bool = Query(default=False),
    missing_han_viet: bool = Query(default=False),
    first_seen_vol: int | None = Query(default=None, ge=0),
    search: str | None = Query(default=None),
) -> Response:
    try:
        content, media_type = export_glossary_tabular(
            series_id,
            fmt=fmt,
            volume_id=volume_id,
            status_filter=status_filter,
            term_type=term_type,
            min_freq=min_freq,
            max_freq=max_freq,
            missing_vi=missing_vi,
            missing_han_viet=missing_han_viet,
            first_seen_vol=first_seen_vol,
            search=search,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    ext = "tsv" if fmt == "tsv" else "csv"
    scope = f"vol{volume_id}" if volume_id else "all"
    filename = f"glossary_series{series_id}_{scope}.{ext}"
    return Response(
        content=content.encode("utf-8"),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/series/{series_id}/glossary/xml")
def export_glossary_xml(
    series_id: int,
    volume_id: int | None = Query(default=None),
) -> Response:
    try:
        xml_str = render_glossary_xml(series_id, volume_id=volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return Response(content=xml_str.encode("utf-8"), media_type="application/xml; charset=utf-8")
