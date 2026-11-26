"""CRUD API routes for API Keys, Model Priority Config, and Quota Slots."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.core.database import (
    DEFAULT_MODEL_LIMITS,
    DEFAULT_MODELS,
    db_session,
    get_setting,
    set_setting,
)
from app.core.gemini_pool import gemini_pool, sanitize_models
from app.models.schemas import (
    ApiKeyCreate,
    ApiKeyResponse,
    ApiKeyUpdate,
    ModelConfigPayload,
    ModelConfigResponse,
    ModelLimitItem,
    QuotaResetRequest,
    QuotaResetResponse,
    QuotaSlotResponse,
    QuotaStatusResponse,
    QuotaSummary,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


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
