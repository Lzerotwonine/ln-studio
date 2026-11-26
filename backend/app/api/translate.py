"""API routes for background multi-mode translation, SSE logs, retranslation, and Debug Context."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.models.schemas import (
    DebugContextResponse,
    RetranslateChapterRequest,
    SingleTranslateResultResponse,
    TranslateStartRequest,
    TranslateStatusResponse,
    TranslationMode,
)
from app.services.translator_service import (
    HybridOptions,
    TranslationOptions,
    build_chapter_debug_context,
    translate_single_chapter,
    translation_job_manager,
)

router = APIRouter(prefix="/api", tags=["translation"])


@router.post(
    "/volumes/{volume_id}/translate/start",
    response_model=TranslateStatusResponse,
)
def start_volume_translation(
    volume_id: int, payload: TranslateStartRequest | None = None
) -> TranslateStatusResponse:
    req = payload or TranslateStartRequest()
    opts = TranslationOptions(
        mode=req.mode,
        temperature=req.temperature,
        hybrid_config=(
            HybridOptions.from_json_or_dict(req.hybrid_config.model_dump())
            if req.hybrid_config is not None
            else None
        ),
        system_prompt_override=req.system_prompt_override,
    )
    try:
        data = translation_job_manager.start_job(
            volume_id,
            start_chapter=req.start_chapter,
            end_chapter=req.end_chapter,
            chapter_ids=req.chapter_ids,
            only_uncompleted=req.only_uncompleted,
            only_failed_or_blocked=req.only_failed_or_blocked,
            options=opts,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return TranslateStatusResponse(**data)


@router.post(
    "/volumes/{volume_id}/translate/pause",
    response_model=TranslateStatusResponse,
)
def pause_volume_translation(volume_id: int) -> TranslateStatusResponse:
    try:
        data = translation_job_manager.pause_job(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return TranslateStatusResponse(**data)


@router.post(
    "/volumes/{volume_id}/translate/resume",
    response_model=TranslateStatusResponse,
)
def resume_volume_translation(volume_id: int) -> TranslateStatusResponse:
    try:
        data = translation_job_manager.resume_job(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return TranslateStatusResponse(**data)


@router.post(
    "/volumes/{volume_id}/translate/stop",
    response_model=TranslateStatusResponse,
)
def stop_volume_translation(volume_id: int) -> TranslateStatusResponse:
    try:
        data = translation_job_manager.stop_job(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return TranslateStatusResponse(**data)


@router.get(
    "/volumes/{volume_id}/translate/status",
    response_model=TranslateStatusResponse,
)
def get_volume_translation_status(volume_id: int) -> TranslateStatusResponse:
    try:
        data = translation_job_manager.get_status(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return TranslateStatusResponse(**data)


@router.get("/volumes/{volume_id}/translate/events")
async def stream_volume_translation_events(volume_id: int) -> StreamingResponse:
    return StreamingResponse(
        translation_job_manager.subscribe_sse(volume_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/chapters/{chapter_id}/retranslate",
    response_model=SingleTranslateResultResponse,
)
def retranslate_chapter(
    chapter_id: int, payload: RetranslateChapterRequest | None = None
) -> SingleTranslateResultResponse:
    req = payload or RetranslateChapterRequest()
    opts = TranslationOptions(
        mode=req.mode,
        temperature=req.temperature,
        hybrid_config=(
            HybridOptions.from_json_or_dict(req.hybrid_config.model_dump())
            if req.hybrid_config is not None
            else None
        ),
        system_prompt_override=req.system_prompt_override,
    )
    try:
        res = translate_single_chapter(chapter_id, opts)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return SingleTranslateResultResponse(**res)


@router.get(
    "/chapters/{chapter_id}/debug-context",
    response_model=DebugContextResponse,
)
def get_chapter_debug_context(
    chapter_id: int,
    mode: TranslationMode | None = Query(default=None),
    use_glossary: bool | None = Query(default=None),
    use_characters: bool | None = Query(default=None),
    use_relationships: bool | None = Query(default=None),
    use_subarc: bool | None = Query(default=None),
    rolling_context_lines: int | None = Query(default=None, ge=0, le=50),
) -> DebugContextResponse:
    hybrid_override = None
    if any(
        v is not None
        for v in (
            use_glossary,
            use_characters,
            use_relationships,
            use_subarc,
            rolling_context_lines,
        )
    ):
        hybrid_override = HybridOptions(
            use_glossary=True if use_glossary is None else use_glossary,
            use_characters=True if use_characters is None else use_characters,
            use_relationships=True if use_relationships is None else use_relationships,
            use_subarc=False if use_subarc is None else use_subarc,
            rolling_context_lines=5 if rolling_context_lines is None else rolling_context_lines,
        )
    try:
        data = build_chapter_debug_context(
            chapter_id,
            TranslationOptions(mode=mode, hybrid_config=hybrid_override),
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return DebugContextResponse(**data)
