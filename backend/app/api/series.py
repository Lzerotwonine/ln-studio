"""CRUD API routes for Series and Volumes."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.core.database import db_session
from app.models.schemas import (
    HybridConfig,
    SeriesCreate,
    SeriesResponse,
    SeriesUpdate,
    VolumeCreate,
    VolumeResponse,
    VolumeUpdate,
)

router = APIRouter(prefix="/api", tags=["series & volumes"])


def _row_to_series(row: sqlite3.Row) -> SeriesResponse:
    raw_cfg = row["hybrid_config_json"] or "{}"
    try:
        parsed_cfg = HybridConfig(**json.loads(raw_cfg))
    except Exception:
        parsed_cfg = HybridConfig()
    return SeriesResponse(
        id=row["id"],
        title=row["title"],
        source_lang=row["source_lang"],
        translation_mode=row["translation_mode"],
        system_prompt=row["system_prompt"] or "",
        master_prompt_file=row["master_prompt_file"] or "master_prompt_vn.xml",
        hybrid_config=parsed_cfg,
        hybrid_config_json=parsed_cfg.model_dump_json(),
        created_at=row["created_at"],
        volume_count=row["volume_count"] if "volume_count" in row.keys() else 0,
    )


def _row_to_volume(row: sqlite3.Row) -> VolumeResponse:
    return VolumeResponse(
        id=row["id"],
        series_id=row["series_id"],
        volume_number=row["volume_number"],
        title=row["title"],
        volume_summary=row["volume_summary"] or "",
        rtas_baseline=float(row["rtas_baseline"]),
        rtas_current_avg=float(row["rtas_current_avg"]),
        rtas_drift=row["rtas_drift"] or "",
        status=row["status"],
        created_at=row["created_at"],
    )


@router.get("/series", response_model=list[SeriesResponse])
def list_series() -> list[SeriesResponse]:
    with db_session() as conn:
        rows = conn.execute(
            """
            SELECT s.*, COUNT(v.id) AS volume_count
            FROM series s
            LEFT JOIN volumes v ON v.series_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC, s.id DESC
            """
        ).fetchall()
    return [_row_to_series(row) for row in rows]


@router.post("/series", response_model=SeriesResponse, status_code=status.HTTP_201_CREATED)
def create_series(payload: SeriesCreate) -> SeriesResponse:
    hybrid_json = payload.hybrid_config.model_dump_json()
    with db_session() as conn:
        cur = conn.execute(
            """
            INSERT INTO series (
                title, source_lang, translation_mode,
                system_prompt, master_prompt_file, hybrid_config_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.title,
                payload.source_lang,
                payload.translation_mode,
                payload.system_prompt,
                payload.master_prompt_file,
                hybrid_json,
            ),
        )
        series_id = cur.lastrowid
        row = conn.execute(
            """
            SELECT s.*, 0 AS volume_count
            FROM series s
            WHERE s.id = ?
            """,
            (series_id,),
        ).fetchone()
    return _row_to_series(row)


@router.get("/series/{series_id}", response_model=SeriesResponse)
def get_series(series_id: int) -> SeriesResponse:
    with db_session() as conn:
        row = conn.execute(
            """
            SELECT s.*, COUNT(v.id) AS volume_count
            FROM series s
            LEFT JOIN volumes v ON v.series_id = s.id
            WHERE s.id = ?
            GROUP BY s.id
            """,
            (series_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")
    return _row_to_series(row)


@router.put("/series/{series_id}", response_model=SeriesResponse)
def update_series(series_id: int, payload: SeriesUpdate) -> SeriesResponse:
    updates: list[str] = []
    params: list[Any] = []

    if payload.title is not None:
        updates.append("title = ?")
        params.append(payload.title)
    if payload.source_lang is not None:
        updates.append("source_lang = ?")
        params.append(payload.source_lang)
    if payload.translation_mode is not None:
        updates.append("translation_mode = ?")
        params.append(payload.translation_mode)
    if payload.system_prompt is not None:
        updates.append("system_prompt = ?")
        params.append(payload.system_prompt)
    if payload.master_prompt_file is not None:
        updates.append("master_prompt_file = ?")
        params.append(payload.master_prompt_file)
    if payload.hybrid_config is not None:
        updates.append("hybrid_config_json = ?")
        params.append(payload.hybrid_config.model_dump_json())

    with db_session() as conn:
        existing = conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")

        if updates:
            params.append(series_id)
            conn.execute(f"UPDATE series SET {', '.join(updates)} WHERE id = ?", params)

        row = conn.execute(
            """
            SELECT s.*, COUNT(v.id) AS volume_count
            FROM series s
            LEFT JOIN volumes v ON v.series_id = s.id
            WHERE s.id = ?
            GROUP BY s.id
            """,
            (series_id,),
        ).fetchone()
    return _row_to_series(row)


@router.delete("/series/{series_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_series(series_id: int) -> None:
    with db_session() as conn:
        cur = conn.execute("DELETE FROM series WHERE id = ?", (series_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")


# ---------- Volumes ----------

@router.get("/series/{series_id}/volumes", response_model=list[VolumeResponse])
def list_volumes(series_id: int) -> list[VolumeResponse]:
    with db_session() as conn:
        series_row = conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone()
        if series_row is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")
        rows = conn.execute(
            """
            SELECT * FROM volumes
            WHERE series_id = ?
            ORDER BY volume_number ASC, id ASC
            """,
            (series_id,),
        ).fetchall()
    return [_row_to_volume(row) for row in rows]


@router.post(
    "/series/{series_id}/volumes",
    response_model=VolumeResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_volume(series_id: int, payload: VolumeCreate) -> VolumeResponse:
    with db_session() as conn:
        series_row = conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone()
        if series_row is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")
        effective_title = payload.title.strip() or f"Tập {payload.volume_number}"
        try:
            cur = conn.execute(
                """
                INSERT INTO volumes (
                    series_id, volume_number, title,
                    volume_summary, rtas_baseline, rtas_current_avg, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    series_id,
                    payload.volume_number,
                    effective_title,
                    payload.volume_summary,
                    payload.rtas_baseline,
                    payload.rtas_baseline,
                    payload.status,
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Tập số {payload.volume_number} đã tồn tại trong bộ truyện này.",
            )
        row = conn.execute("SELECT * FROM volumes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _row_to_volume(row)


@router.get("/volumes/{volume_id}", response_model=VolumeResponse)
def get_volume(volume_id: int) -> VolumeResponse:
    with db_session() as conn:
        row = conn.execute("SELECT * FROM volumes WHERE id = ?", (volume_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy tập truyện.")
    return _row_to_volume(row)


@router.put("/volumes/{volume_id}", response_model=VolumeResponse)
def update_volume(volume_id: int, payload: VolumeUpdate) -> VolumeResponse:
    updates: list[str] = []
    params: list[Any] = []

    for field_name in (
        "volume_number",
        "title",
        "volume_summary",
        "rtas_baseline",
        "rtas_current_avg",
        "rtas_drift",
        "status",
    ):
        val = getattr(payload, field_name)
        if val is not None:
            updates.append(f"{field_name} = ?")
            params.append(val)

    with db_session() as conn:
        existing = conn.execute("SELECT id, volume_number FROM volumes WHERE id = ?", (volume_id,)).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy tập truyện.")
        if payload.title is not None and not payload.title.strip():
            # Fallback label if user clears title completely
            target_num = payload.volume_number if payload.volume_number is not None else int(existing["volume_number"])
            for i, col in enumerate(updates):
                if col == "title = ?":
                    params[i] = f"Tập {target_num}"
                    break
        if updates:
            params.append(volume_id)
            try:
                conn.execute(f"UPDATE volumes SET {', '.join(updates)} WHERE id = ?", params)
            except sqlite3.IntegrityError:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Số tập bị trùng với một tập khác trong cùng bộ truyện.",
                )
        row = conn.execute("SELECT * FROM volumes WHERE id = ?", (volume_id,)).fetchone()
    return _row_to_volume(row)


@router.delete("/volumes/{volume_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_volume(volume_id: int) -> None:
    with db_session() as conn:
        cur = conn.execute("DELETE FROM volumes WHERE id = ?", (volume_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Không tìm thấy tập truyện.")
