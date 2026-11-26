"""CRUD API routes for Prompt Presets."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status

from app.core.database import db_session, seed_default_presets
from app.models.schemas import (
    PresetSourceLang,
    PromptPresetCreate,
    PromptPresetResponse,
    PromptPresetUpdate,
    TranslationMode,
)

router = APIRouter(prefix="/api/presets", tags=["prompt presets"])


def _row_to_preset(row: sqlite3.Row) -> PromptPresetResponse:
    return PromptPresetResponse(
        id=row["id"],
        name=row["name"],
        source_lang=row["source_lang"],
        mode=row["mode"],
        content=row["content"],
    )


@router.get("", response_model=list[PromptPresetResponse])
def list_presets(
    source_lang: PresetSourceLang | None = Query(default=None),
    mode: TranslationMode | None = Query(default=None),
) -> list[PromptPresetResponse]:
    clauses: list[str] = []
    params: list[Any] = []
    if source_lang is not None:
        clauses.append("(source_lang = ? OR source_lang = 'any')")
        params.append(source_lang)
    if mode is not None:
        clauses.append("mode = ?")
        params.append(mode)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db_session() as conn:
        rows = conn.execute(
            f"SELECT * FROM prompt_presets {where_sql} ORDER BY id ASC",
            params,
        ).fetchall()
    return [_row_to_preset(row) for row in rows]


@router.post("", response_model=PromptPresetResponse, status_code=status.HTTP_201_CREATED)
def create_preset(payload: PromptPresetCreate) -> PromptPresetResponse:
    with db_session() as conn:
        try:
            cur = conn.execute(
                """
                INSERT INTO prompt_presets (name, source_lang, mode, content)
                VALUES (?, ?, ?, ?)
                """,
                (payload.name, payload.source_lang, payload.mode, payload.content),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Prompt preset '{payload.name}' đã tồn tại.",
            )
        row = conn.execute(
            "SELECT * FROM prompt_presets WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return _row_to_preset(row)


@router.put("/{preset_id}", response_model=PromptPresetResponse)
def update_preset(preset_id: int, payload: PromptPresetUpdate) -> PromptPresetResponse:
    updates: list[str] = []
    params: list[Any] = []
    for field_name in ("name", "source_lang", "mode", "content"):
        val = getattr(payload, field_name)
        if val is not None:
            updates.append(f"{field_name} = ?")
            params.append(val)

    with db_session() as conn:
        existing = conn.execute(
            "SELECT id FROM prompt_presets WHERE id = ?", (preset_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy Prompt Preset.")
        if updates:
            params.append(preset_id)
            try:
                conn.execute(
                    f"UPDATE prompt_presets SET {', '.join(updates)} WHERE id = ?",
                    params,
                )
            except sqlite3.IntegrityError:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Tên Prompt Preset đã tồn tại.",
                )
        row = conn.execute(
            "SELECT * FROM prompt_presets WHERE id = ?", (preset_id,)
        ).fetchone()
    return _row_to_preset(row)


@router.delete("/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_preset(preset_id: int) -> None:
    with db_session() as conn:
        cur = conn.execute("DELETE FROM prompt_presets WHERE id = ?", (preset_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Không tìm thấy Prompt Preset.")


@router.post("/seed-defaults", response_model=dict[str, Any])
def restore_default_presets() -> dict[str, Any]:
    with db_session() as conn:
        inserted = seed_default_presets(conn)
        rows = conn.execute("SELECT * FROM prompt_presets ORDER BY id ASC").fetchall()
    return {
        "inserted": inserted,
        "presets": [_row_to_preset(row).model_dump() for row in rows],
    }
