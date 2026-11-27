"""CRUD API routes for API Keys, Model Priority Config, and Quota Slots."""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from fastapi import APIRouter, HTTPException, status
from google import genai
from google.genai import types

from app.core.database import (
    DEFAULT_MODEL_LIMITS,
    DEFAULT_MODELS,
    DEFAULT_TASK_MODELS,
    TASK_MODEL_KEYS,
    db_session,
    get_setting,
    set_setting,
)
from app.core.gemini_pool import gemini_pool, sanitize_models
from app.models.schemas import (
    ApiKeyCreate,
    ApiKeyResponse,
    ApiKeyUpdate,
    DiscoveredModelItem,
    ModelConfigPayload,
    ModelConfigResponse,
    ModelDiscoverRequest,
    ModelDiscoverResponse,
    ModelLimitItem,
    ModelTestRequest,
    ModelTestResponse,
    QuotaResetRequest,
    QuotaResetResponse,
    QuotaSlotResponse,
    QuotaStatusResponse,
    QuotaSummary,
    TaskModelAssignment,
    TaskModelsResponse,
    TaskModelsUpdatePayload,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _build_genai_client(api_key: str) -> Any:
    """Factory wrapper around google-genai Client so unit tests can cleanly monkeypatch it."""
    return genai.Client(api_key=api_key)


def _pick_active_api_key(key_id: int | None = None) -> tuple[str, str]:
    with db_session() as conn:
        if key_id is not None:
            row = conn.execute(
                "SELECT name, api_key FROM api_keys WHERE id = ?",
                (key_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Không tìm thấy API Key được chỉ định.")
            return str(row["name"]), str(row["api_key"])
        row = conn.execute(
            "SELECT name, api_key FROM api_keys WHERE is_active = 1 ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=400,
                detail="Chưa có API Key nào đang bật. Hãy thêm hoặc bật ít nhất 1 API Key trước.",
            )
        return str(row["name"]), str(row["api_key"])


def _mask_api_key(raw_key: str) -> str:
    key = raw_key.strip()
    if len(key) <= 8:
        return "*" * max(4, len(key))
    return f"{key[:4]}...{key[-4:]}"


def _row_to_api_key(row: sqlite3.Row) -> ApiKeyResponse:
    return ApiKeyResponse(
        id=row["id"],
        name=row["name"],
        masked_key=_mask_api_key(row["api_key"]),
        is_active=bool(row["is_active"]),
    )


# ---------- API Keys ----------

@router.get("/api-keys", response_model=list[ApiKeyResponse])
def list_api_keys() -> list[ApiKeyResponse]:
    with db_session() as conn:
        rows = conn.execute(
            "SELECT id, name, api_key, is_active FROM api_keys ORDER BY id ASC"
        ).fetchall()
    return [_row_to_api_key(row) for row in rows]


@router.post("/api-keys", response_model=ApiKeyResponse, status_code=status.HTTP_201_CREATED)
def create_api_key(payload: ApiKeyCreate) -> ApiKeyResponse:
    with db_session() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO api_keys (name, api_key, is_active) VALUES (?, ?, ?)",
                (payload.name, payload.api_key, 1 if payload.is_active else 0),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Tên API Key '{payload.name}' đã tồn tại.",
            )
        row = conn.execute(
            "SELECT id, name, api_key, is_active FROM api_keys WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
    return _row_to_api_key(row)


@router.patch("/api-keys/{key_id}", response_model=ApiKeyResponse)
def update_api_key(key_id: int, payload: ApiKeyUpdate) -> ApiKeyResponse:
    updates: list[str] = []
    params: list[Any] = []

    if payload.name is not None:
        updates.append("name = ?")
        params.append(payload.name)
    if payload.api_key is not None:
        updates.append("api_key = ?")
        params.append(payload.api_key)
    if payload.is_active is not None:
        updates.append("is_active = ?")
        params.append(1 if payload.is_active else 0)

    with db_session() as conn:
        existing = conn.execute(
            "SELECT id, name FROM api_keys WHERE id = ?", (key_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy API Key.")
        old_name = existing["name"]

        if updates:
            params.append(key_id)
            try:
                conn.execute(f"UPDATE api_keys SET {', '.join(updates)} WHERE id = ?", params)
            except sqlite3.IntegrityError:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Tên API Key đã tồn tại.",
                )

            # Remove obsolete quota_slot entries if key was renamed
            if payload.name is not None and payload.name != old_name:
                conn.execute("DELETE FROM quota_slots WHERE key_name = ?", (old_name,))

        row = conn.execute(
            "SELECT id, name, api_key, is_active FROM api_keys WHERE id = ?",
            (key_id,),
        ).fetchone()
    return _row_to_api_key(row)


@router.delete("/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_api_key(key_id: int) -> None:
    with db_session() as conn:
        existing = conn.execute(
            "SELECT id, name FROM api_keys WHERE id = ?", (key_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy API Key.")
        conn.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        conn.execute("DELETE FROM quota_slots WHERE key_name = ?", (existing["name"],))


# ---------- Models Config ----------

@router.get("/models", response_model=ModelConfigResponse)
def get_models_config() -> ModelConfigResponse:
    with db_session() as conn:
        raw_models = get_setting(conn, "model_priority", DEFAULT_MODELS)
        raw_limits = get_setting(conn, "model_limits", DEFAULT_MODEL_LIMITS)

    models = sanitize_models(raw_models if isinstance(raw_models, list) else DEFAULT_MODELS)
    limits_dict: dict[str, ModelLimitItem] = {}
    merged = dict(DEFAULT_MODEL_LIMITS)
    if isinstance(raw_limits, dict):
        merged.update(raw_limits)
    for k, v in merged.items():
        if isinstance(v, dict):
            limits_dict[k] = ModelLimitItem(
                rpm=int(v.get("rpm", 10)),
                rpd=int(v.get("rpd", 250)),
            )
    return ModelConfigResponse(models=models, model_limits=limits_dict)


@router.put("/models", response_model=ModelConfigResponse)
def update_models_config(payload: ModelConfigPayload) -> ModelConfigResponse:
    cleaned_models = sanitize_models(payload.models)
    if not cleaned_models:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cần ít nhất một model hợp lệ (chuỗi rỗng sẽ tự động bị loại bỏ).",
        )

    with db_session() as conn:
        set_setting(conn, "model_priority", cleaned_models)
        if payload.model_limits is not None:
            serialized_limits = {
                k.strip(): {"rpm": v.rpm, "rpd": v.rpd}
                for k, v in payload.model_limits.items()
                if k.strip()
            }
            if "default" not in serialized_limits:
                serialized_limits["default"] = DEFAULT_MODEL_LIMITS["default"]
            set_setting(conn, "model_limits", serialized_limits)

    return get_models_config()


@router.post("/models/discover", response_model=ModelDiscoverResponse)
def discover_live_models(
    payload: ModelDiscoverRequest | None = None,
) -> ModelDiscoverResponse:
    """Query Google Gemini API (client.models.list()) using an active API key to discover callable text models."""
    key_name, raw_key = _pick_active_api_key(payload.key_id if payload else None)
    try:
        client = _build_genai_client(raw_key)
        raw_iter = client.models.list()
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Không thể tải danh sách model từ Gemini API ({key_name}): {exc}",
        )

    discovered: list[DiscoveredModelItem] = []
    seen: set[str] = set()
    skip_markers = (
        "embedding",
        "imagen",
        "veo",
        "aqa",
        "tts",
        "audio",
        "robotics",
        "computer-use",
        "deep-research",
    )

    try:
        for item in raw_iter:
            raw_name = str(getattr(item, "name", "") or "").strip()
            if not raw_name:
                continue
            model_id = raw_name.removeprefix("models/").strip()
            lower_id = model_id.lower()
            if not lower_id.startswith("gemini-"):
                continue
            if any(m in lower_id for m in skip_markers):
                continue

            actions = getattr(item, "supported_actions", None) or getattr(
                item, "supported_generation_methods", None
            )
            if actions is not None:
                action_strs = {str(a) for a in actions}
                if "generateContent" not in action_strs:
                    continue

            if model_id in seen:
                continue
            seen.add(model_id)
            discovered.append(
                DiscoveredModelItem(
                    id=model_id,
                    display_name=str(getattr(item, "display_name", "") or model_id),
                    description=str(getattr(item, "description", "") or "")[:240],
                    input_token_limit=getattr(item, "input_token_limit", None),
                    output_token_limit=getattr(item, "output_token_limit", None),
                )
            )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Lỗi khi đọc danh sách model từ Gemini API ({key_name}): {exc}",
        )

    # Sort newest/latest aliases first for convenient browsing
    def _sort_key(m: DiscoveredModelItem) -> tuple[int, str]:
        mid = m.id.lower()
        if "latest" in mid:
            return (0, mid)
        if mid.startswith("gemini-3") or mid.startswith("gemini-4"):
            return (1, mid)
        if mid.startswith("gemini-2.5"):
            return (2, mid)
        return (3, mid)

    discovered.sort(key=_sort_key)
    return ModelDiscoverResponse(key_used=key_name, models=discovered)


@router.post("/models/test", response_model=ModelTestResponse)
def test_live_model(payload: ModelTestRequest) -> ModelTestResponse:
    """Send a minimal probe request to verify whether a model is callable with the active API key."""
    model_id = payload.model.strip()
    if not model_id:
        raise HTTPException(status_code=422, detail="Mã model không được để trống.")
    key_name, raw_key = _pick_active_api_key(payload.key_id)

    t0 = time.perf_counter()
    try:
        client = _build_genai_client(raw_key)
        resp = client.models.generate_content(
            model=model_id,
            contents="Reply with OK.",
            config=types.GenerateContentConfig(max_output_tokens=16, temperature=0.0),
        )
        latency_ms = int((time.perf_counter() - t0) * 1000)
        text = str(getattr(resp, "text", "") or "").strip()
        return ModelTestResponse(
            ok=True,
            model=model_id,
            key_used=key_name,
            latency_ms=latency_ms,
            reply_preview=text[:120] or "OK",
            error=None,
        )
    except Exception as exc:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return ModelTestResponse(
            ok=False,
            model=model_id,
            key_used=key_name,
            latency_ms=latency_ms,
            reply_preview="",
            error=str(exc)[:300],
        )


# ---------- Task-based Model Routing ----------

@router.get("/task-models", response_model=TaskModelsResponse)
def get_task_models_config() -> TaskModelsResponse:
    with db_session() as conn:
        raw = get_setting(conn, "task_models", DEFAULT_TASK_MODELS)
        global_models = sanitize_models(get_setting(conn, "model_priority", DEFAULT_MODELS))

    tasks: dict[str, TaskModelAssignment] = {}
    all_available: list[str] = list(global_models)
    for key in TASK_MODEL_KEYS:
        default_cfg = DEFAULT_TASK_MODELS[key]
        entry = raw.get(key) if isinstance(raw, dict) else None
        if isinstance(entry, dict):
            primary = str(entry.get("primary") or default_cfg["primary"]).strip() or default_cfg["primary"]
            fallbacks = [m for m in sanitize_models(entry.get("fallbacks")) if m != primary]
        else:
            primary = default_cfg["primary"]
            fallbacks = list(default_cfg["fallbacks"])
        tasks[key] = TaskModelAssignment(primary=primary, fallbacks=fallbacks)
        all_available.append(primary)
        all_available.extend(fallbacks)

    return TaskModelsResponse(
        tasks=tasks,
        available_models=sanitize_models(all_available),
    )


@router.put("/task-models", response_model=TaskModelsResponse)
def update_task_models_config(payload: TaskModelsUpdatePayload) -> TaskModelsResponse:
    with db_session() as conn:
        existing_raw = get_setting(conn, "task_models", DEFAULT_TASK_MODELS)
        next_map: dict[str, dict[str, Any]] = {}
        for key in TASK_MODEL_KEYS:
            if key in payload.tasks:
                cfg = payload.tasks[key]
                primary = cfg.primary.strip()
                if not primary:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Model ưu tiên cho tác vụ '{key}' không được để trống.",
                    )
                fallbacks = [m for m in sanitize_models(cfg.fallbacks) if m != primary]
                next_map[key] = {"primary": primary, "fallbacks": fallbacks}
            else:
                prev = existing_raw.get(key) if isinstance(existing_raw, dict) else None
                next_map[key] = prev if isinstance(prev, dict) else dict(DEFAULT_TASK_MODELS[key])
        set_setting(conn, "task_models", next_map)
    return get_task_models_config()


# ---------- Quota Slots ----------

@router.get("/quota", response_model=QuotaStatusResponse)
def get_quota_slots() -> QuotaStatusResponse:
    raw_slots = gemini_pool.get_quota_status()
    slots = [QuotaSlotResponse(**item) for item in raw_slots]
    summary = QuotaSummary(
        total=len(slots),
        active=sum(1 for s in slots if s.is_active_slot),
        ready=sum(1 for s in slots if s.is_active_slot and s.status == "ready"),
        cooldown=sum(1 for s in slots if s.is_active_slot and s.status == "cooldown"),
        daily_exhausted=sum(
            1 for s in slots if s.is_active_slot and s.status == "daily_exhausted"
        ),
        session_disabled=sum(
            1 for s in slots if s.is_active_slot and s.status == "session_disabled"
        ),
    )
    return QuotaStatusResponse(slots=slots, summary=summary)


@router.post("/quota/reset", response_model=QuotaResetResponse)
def reset_quota_slots(payload: QuotaResetRequest | None = None) -> QuotaResetResponse:
    slot_id = payload.slot_id if payload else None
    reset_count = gemini_pool.reset_quota(slot_id=slot_id)
    updated_slots = [QuotaSlotResponse(**item) for item in gemini_pool.get_quota_status()]
    return QuotaResetResponse(reset_count=reset_count, slots=updated_slots)
