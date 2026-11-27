"""API routes for Continuity Pack: MAP/REDUCE pipeline, Characters, Relationships Review Queue, XML & Relevant Context."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response, status

from app.core.database import db_session
from app.core.gemini_pool import NoAvailableSlotsError
from app.models.schemas import (
    CharacterCreate,
    CharacterUpdate,
    CharacterWithStateResponse,
    ContinuityStatusResponse,
    MapPhaseRequest,
    MapPhaseResponse,
    ReducePhaseRequest,
    ReducePhaseResponse,
    RelationshipApproveRequest,
    RelationshipBulkApproveRequest,
    RelationshipCreate,
    RelationshipResponse,
    RelationshipUpdate,
    RelevantContextRequest,
    RelevantContextResponse,
    VolumeCharacterStateUpdate,
)
from app.services.continuity_service import (
    MISSING_REVERSE_PREFIX,
    build_relevant_context,
    get_continuity_status,
    render_continuity_xml,
    run_map_phase,
    run_reduce_and_merge,
)

router = APIRouter(prefix="/api", tags=["continuity"])


def _parse_aliases(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(x).strip() for x in parsed if str(x).strip()]
    except (ValueError, TypeError):
        pass
    return []


def _row_to_relationship(row: sqlite3.Row, all_pairs: set[tuple[int, int]] | None = None) -> RelationshipResponse:
    src_id = int(row["source_char_id"])
    tgt_id = int(row["target_char_id"])
    notes = str(row["notes"] or "")
    has_missing_tag = notes.startswith(MISSING_REVERSE_PREFIX)
    missing_counterpart = all_pairs is not None and (tgt_id, src_id) not in all_pairs
    return RelationshipResponse(
        id=int(row["id"]),
        series_id=int(row["series_id"]),
        source_char_id=src_id,
        target_char_id=tgt_id,
        source_name=str(row["source_name"]),
        source_canonical=str(row["source_canonical"]),
        target_name=str(row["target_name"]),
        target_canonical=str(row["target_canonical"]),
        pair_pronoun=str(row["pair_pronoun"] or ""),
        rtas_score=float(row["rtas_score"] or 3.5),
        notes=notes,
        evidence_quote=str(row["evidence_quote"] or ""),
        needs_review=bool(row["needs_review"]),
        is_locked=bool(row["is_locked"]),
        is_missing_reverse=has_missing_tag or missing_counterpart,
        last_updated_vol=int(row["last_updated_vol"] or 1),
    )


# ---------- Pipeline Status, MAP & REDUCE ----------

@router.get(
    "/volumes/{volume_id}/continuity/status",
    response_model=ContinuityStatusResponse,
)
def continuity_status(volume_id: int) -> ContinuityStatusResponse:
    try:
        data = get_continuity_status(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ContinuityStatusResponse(**data)


@router.post(
    "/volumes/{volume_id}/continuity/map",
    response_model=MapPhaseResponse,
)
def trigger_map_phase(
    volume_id: int, payload: MapPhaseRequest | None = None
) -> MapPhaseResponse:
    req = payload or MapPhaseRequest()
    try:
        res = run_map_phase(
            volume_id,
            force_rerun=req.force_rerun,
            chapter_ids=req.chapter_ids,
            model_override=req.model_override,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except NoAvailableSlotsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi khi chạy MAP PHASE: {exc}")
    return MapPhaseResponse(**res)


@router.post(
    "/volumes/{volume_id}/continuity/reduce",
    response_model=ReducePhaseResponse,
)
def trigger_reduce_phase(
    volume_id: int, payload: ReducePhaseRequest | None = None
) -> ReducePhaseResponse:
    req = payload or ReducePhaseRequest()
    try:
        res = run_reduce_and_merge(
            volume_id,
            skip_ai_summary=req.skip_ai_summary,
            model_override=req.model_override,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except NoAvailableSlotsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi khi chạy REDUCE & MERGE: {exc}")
    return ReducePhaseResponse(**res)


# ---------- Characters & Volume Sub-Arc States ----------

@router.get(
    "/volumes/{volume_id}/characters",
    response_model=list[CharacterWithStateResponse],
)
def list_volume_characters(volume_id: int) -> list[CharacterWithStateResponse]:
    with db_session() as conn:
        vol = conn.execute(
            "SELECT id, series_id FROM volumes WHERE id = ?", (volume_id,)
        ).fetchone()
        if vol is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy tập truyện.")
        series_id = int(vol["series_id"])
        rows = conn.execute(
            """
            SELECT c.*,
                   COALESCE(vcs.appearance, 'MENTIONED') AS appearance,
                   COALESCE(vcs.subarc, '') AS subarc,
                   COALESCE(vcs.current_state, '') AS current_state,
                   COALESCE(vcs.notes, '') AS state_notes,
                   CASE WHEN vcs.volume_id IS NOT NULL THEN 1 ELSE 0 END AS in_volume
            FROM characters c
            LEFT JOIN volume_character_states vcs
                ON vcs.character_id = c.id AND vcs.volume_id = ?
            WHERE c.series_id = ?
            ORDER BY
                CASE WHEN vcs.appearance = 'ACTUAL' THEN 0
                     WHEN vcs.appearance = 'MENTIONED' THEN 1
                     ELSE 2 END,
                c.id ASC
            """,
            (volume_id, series_id),
        ).fetchall()

    return [
        CharacterWithStateResponse(
            id=int(r["id"]),
            series_id=int(r["series_id"]),
            canonical_name=str(r["canonical_name"]),
            display_name=str(r["display_name"]),
            aliases=_parse_aliases(r["aliases_json"]),
            archetype=str(r["archetype"] or "NORMAL"),
            default_pair=str(r["default_pair"] or "Tôi-Cậu"),
            rtas_baseline=float(r["rtas_baseline"] or 3.5),
            appearance=str(r["appearance"]),
            subarc=str(r["subarc"]),
            current_state=str(r["current_state"]),
            state_notes=str(r["state_notes"]),
            in_volume=bool(r["in_volume"]),
        )
        for r in rows
    ]


@router.post(
    "/series/{series_id}/characters",
    response_model=CharacterWithStateResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_character(
    series_id: int, payload: CharacterCreate
) -> CharacterWithStateResponse:
    aliases_clean = [a.strip() for a in payload.aliases if a.strip()]
    aliases_json = json.dumps(aliases_clean, ensure_ascii=False)

    with db_session() as conn:
        if conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")
        try:
            cur = conn.execute(
                """
                INSERT INTO characters (
                    series_id, canonical_name, display_name, aliases_json,
                    archetype, default_pair, rtas_baseline
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    series_id,
                    payload.canonical_name.strip(),
                    payload.display_name.strip(),
                    aliases_json,
                    payload.archetype.strip() or "NORMAL",
                    payload.default_pair.strip() or "Tôi-Cậu",
                    payload.rtas_baseline,
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Nhân vật '{payload.canonical_name}' đã tồn tại trong bộ truyện này.",
            )
        char_id = int(cur.lastrowid)
        in_vol = False
        if payload.volume_id is not None:
            conn.execute(
                """
                INSERT OR REPLACE INTO volume_character_states (volume_id, character_id, appearance)
                VALUES (?, ?, ?)
                """,
                (payload.volume_id, char_id, payload.appearance),
            )
            in_vol = True

    return CharacterWithStateResponse(
        id=char_id,
        series_id=series_id,
        canonical_name=payload.canonical_name.strip(),
        display_name=payload.display_name.strip(),
        aliases=aliases_clean,
        archetype=payload.archetype.strip() or "NORMAL",
        default_pair=payload.default_pair.strip() or "Tôi-Cậu",
        rtas_baseline=payload.rtas_baseline,
        appearance=payload.appearance,
        subarc="",
        current_state="",
        state_notes="",
        in_volume=in_vol,
    )


@router.patch("/characters/{character_id}", response_model=dict[str, Any])
def update_character(character_id: int, payload: CharacterUpdate) -> dict[str, Any]:
    updates: list[str] = []
    params: list[Any] = []
    if payload.canonical_name is not None:
        updates.append("canonical_name = ?")
        params.append(payload.canonical_name.strip())
    if payload.display_name is not None:
        updates.append("display_name = ?")
        params.append(payload.display_name.strip())
    if payload.aliases is not None:
        cleaned = [a.strip() for a in payload.aliases if a.strip()]
        updates.append("aliases_json = ?")
        params.append(json.dumps(cleaned, ensure_ascii=False))
    if payload.archetype is not None:
        updates.append("archetype = ?")
        params.append(payload.archetype.strip() or "NORMAL")
    if payload.default_pair is not None:
        updates.append("default_pair = ?")
        params.append(payload.default_pair.strip())
    if payload.rtas_baseline is not None:
        updates.append("rtas_baseline = ?")
        params.append(payload.rtas_baseline)

    with db_session() as conn:
        if conn.execute("SELECT id FROM characters WHERE id = ?", (character_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy nhân vật.")
        if updates:
            params.append(character_id)
            try:
                conn.execute(f"UPDATE characters SET {', '.join(updates)} WHERE id = ?", params)
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=409, detail="Tên gốc nhân vật bị trùng.")
        row = conn.execute("SELECT * FROM characters WHERE id = ?", (character_id,)).fetchone()

    return {
        "id": int(row["id"]),
        "series_id": int(row["series_id"]),
        "canonical_name": row["canonical_name"],
        "display_name": row["display_name"],
        "aliases": _parse_aliases(row["aliases_json"]),
        "archetype": row["archetype"],
        "default_pair": row["default_pair"],
        "rtas_baseline": float(row["rtas_baseline"]),
    }


@router.delete("/characters/{character_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_character(character_id: int) -> None:
    with db_session() as conn:
        cur = conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Không tìm thấy nhân vật.")


@router.put(
    "/volumes/{volume_id}/characters/{character_id}/state",
    response_model=dict[str, Any],
)
def upsert_volume_character_state(
    volume_id: int, character_id: int, payload: VolumeCharacterStateUpdate
) -> dict[str, Any]:
    with db_session() as conn:
        if conn.execute("SELECT id FROM volumes WHERE id = ?", (volume_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy tập truyện.")
        if conn.execute("SELECT id FROM characters WHERE id = ?", (character_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy nhân vật.")

        existing = conn.execute(
            "SELECT * FROM volume_character_states WHERE volume_id = ? AND character_id = ?",
            (volume_id, character_id),
        ).fetchone()
        appearance = payload.appearance or (existing["appearance"] if existing else "ACTUAL")
        subarc = payload.subarc if payload.subarc is not None else (existing["subarc"] if existing else "")
        current_state = (
            payload.current_state
            if payload.current_state is not None
            else (existing["current_state"] if existing else "")
        )
        notes = payload.notes if payload.notes is not None else (existing["notes"] if existing else "")

        conn.execute(
            """
            INSERT INTO volume_character_states (
                volume_id, character_id, appearance, subarc, current_state, notes
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(volume_id, character_id) DO UPDATE SET
                appearance = excluded.appearance,
                subarc = excluded.subarc,
                current_state = excluded.current_state,
                notes = excluded.notes
            """,
            (volume_id, character_id, appearance, subarc, current_state, notes),
        )

    return {
        "volume_id": volume_id,
        "character_id": character_id,
        "appearance": appearance,
        "subarc": subarc,
        "current_state": current_state,
        "notes": notes,
    }


# ---------- Relationships & Pronoun Review Queue ----------

@router.get(
    "/series/{series_id}/relationships",
    response_model=list[RelationshipResponse],
)
def list_relationships(
    series_id: int,
    needs_review: bool | None = Query(default=None),
    is_locked: bool | None = Query(default=None),
) -> list[RelationshipResponse]:
    with db_session() as conn:
        if conn.execute("SELECT id FROM series WHERE id = ?", (series_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện.")

        all_pairs = {
            (int(r["source_char_id"]), int(r["target_char_id"]))
            for r in conn.execute(
                "SELECT source_char_id, target_char_id FROM relationships WHERE series_id = ?",
                (series_id,),
            ).fetchall()
        }

        clauses = ["r.series_id = ?"]
        params: list[Any] = [series_id]
        if needs_review is not None:
            clauses.append("r.needs_review = ?")
            params.append(1 if needs_review else 0)
        if is_locked is not None:
            clauses.append("r.is_locked = ?")
            params.append(1 if is_locked else 0)

        rows = conn.execute(
            f"""
            SELECT r.*,
                   sc.display_name AS source_name,
                   sc.canonical_name AS source_canonical,
                   tc.display_name AS target_name,
                   tc.canonical_name AS target_canonical
            FROM relationships r
            JOIN characters sc ON sc.id = r.source_char_id
            JOIN characters tc ON tc.id = r.target_char_id
            WHERE {' AND '.join(clauses)}
            ORDER BY r.needs_review DESC, r.is_locked DESC, r.id ASC
            """,
            params,
        ).fetchall()

    return [_row_to_relationship(r, all_pairs) for r in rows]


@router.post(
    "/series/{series_id}/relationships",
    response_model=RelationshipResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_relationship(
    series_id: int, payload: RelationshipCreate
) -> RelationshipResponse:
    if payload.source_char_id == payload.target_char_id:
        raise HTTPException(
            status_code=400, detail="Nhân vật nói và nhân vật nghe không thể giống nhau."
        )
    with db_session() as conn:
        try:
            cur = conn.execute(
                """
                INSERT INTO relationships (
                    series_id, source_char_id, target_char_id,
                    pair_pronoun, rtas_score, notes, evidence_quote,
                    needs_review, is_locked, last_updated_vol
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    series_id,
                    payload.source_char_id,
                    payload.target_char_id,
                    payload.pair_pronoun.strip(),
                    payload.rtas_score,
                    payload.notes.strip(),
                    payload.evidence_quote.strip(),
                    1 if payload.needs_review else 0,
                    1 if payload.is_locked else 0,
                    payload.last_updated_vol,
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=409,
                detail="Cặp quan hệ có hướng này đã tồn tại trong bộ truyện.",
            )
        row = conn.execute(
            """
            SELECT r.*,
                   sc.display_name AS source_name,
                   sc.canonical_name AS source_canonical,
                   tc.display_name AS target_name,
                   tc.canonical_name AS target_canonical
            FROM relationships r
            JOIN characters sc ON sc.id = r.source_char_id
            JOIN characters tc ON tc.id = r.target_char_id
            WHERE r.id = ?
            """,
            (cur.lastrowid,),
        ).fetchone()
        all_pairs = {
            (int(r["source_char_id"]), int(r["target_char_id"]))
            for r in conn.execute(
                "SELECT source_char_id, target_char_id FROM relationships WHERE series_id = ?",
                (series_id,),
            ).fetchall()
        }
    return _row_to_relationship(row, all_pairs)


@router.patch("/relationships/{rel_id}", response_model=RelationshipResponse)
def update_relationship(
    rel_id: int, payload: RelationshipUpdate
) -> RelationshipResponse:
    updates: list[str] = []
    params: list[Any] = []
    if payload.pair_pronoun is not None:
        updates.append("pair_pronoun = ?")
        params.append(payload.pair_pronoun.strip())
    if payload.rtas_score is not None:
        updates.append("rtas_score = ?")
        params.append(payload.rtas_score)
    if payload.notes is not None:
        updates.append("notes = ?")
        params.append(payload.notes.strip())
    if payload.evidence_quote is not None:
        updates.append("evidence_quote = ?")
        params.append(payload.evidence_quote.strip())
    if payload.needs_review is not None:
        updates.append("needs_review = ?")
        params.append(1 if payload.needs_review else 0)
    if payload.is_locked is not None:
        updates.append("is_locked = ?")
        params.append(1 if payload.is_locked else 0)

    with db_session() as conn:
        existing = conn.execute(
            "SELECT id, series_id FROM relationships WHERE id = ?", (rel_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy cặp quan hệ.")
        if updates:
            params.append(rel_id)
            conn.execute(f"UPDATE relationships SET {', '.join(updates)} WHERE id = ?", params)

        row = conn.execute(
            """
            SELECT r.*,
                   sc.display_name AS source_name,
                   sc.canonical_name AS source_canonical,
                   tc.display_name AS target_name,
                   tc.canonical_name AS target_canonical
            FROM relationships r
            JOIN characters sc ON sc.id = r.source_char_id
            JOIN characters tc ON tc.id = r.target_char_id
            WHERE r.id = ?
            """,
            (rel_id,),
        ).fetchone()
        all_pairs = {
            (int(r["source_char_id"]), int(r["target_char_id"]))
            for r in conn.execute(
                "SELECT source_char_id, target_char_id FROM relationships WHERE series_id = ?",
                (int(existing["series_id"]),),
            ).fetchall()
        }
    return _row_to_relationship(row, all_pairs)


@router.post("/relationships/{rel_id}/approve", response_model=RelationshipResponse)
def approve_relationship(
    rel_id: int, payload: RelationshipApproveRequest | None = None
) -> RelationshipResponse:
    req = payload or RelationshipApproveRequest()
    with db_session() as conn:
        existing = conn.execute(
            "SELECT * FROM relationships WHERE id = ?", (rel_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy cặp quan hệ.")

        pair_val = (
            req.pair_pronoun.strip()
            if req.pair_pronoun is not None
            else str(existing["pair_pronoun"] or "").strip()
        )
        notes_val = (
            req.notes.strip()
            if req.notes is not None
            else str(existing["notes"] or "").replace(MISSING_REVERSE_PREFIX, "").strip()
        )
        conn.execute(
            """
            UPDATE relationships
            SET pair_pronoun = ?,
                notes = ?,
                needs_review = 0,
                is_locked = CASE WHEN ? = 1 THEN 1 ELSE is_locked END
            WHERE id = ?
            """,
            (pair_val, notes_val, 1 if req.is_locked else 0, rel_id),
        )
        row = conn.execute(
            """
            SELECT r.*,
                   sc.display_name AS source_name,
                   sc.canonical_name AS source_canonical,
                   tc.display_name AS target_name,
                   tc.canonical_name AS target_canonical
            FROM relationships r
            JOIN characters sc ON sc.id = r.source_char_id
            JOIN characters tc ON tc.id = r.target_char_id
            WHERE r.id = ?
            """,
            (rel_id,),
        ).fetchone()
        all_pairs = {
            (int(r["source_char_id"]), int(r["target_char_id"]))
            for r in conn.execute(
                "SELECT source_char_id, target_char_id FROM relationships WHERE series_id = ?",
                (int(existing["series_id"]),),
            ).fetchall()
        }
    return _row_to_relationship(row, all_pairs)


@router.post("/relationships/bulk-approve", response_model=dict[str, int])
def bulk_approve_relationships(
    payload: RelationshipBulkApproveRequest,
) -> dict[str, int]:
    if not payload.relationship_ids:
        return {"updated": 0}
    placeholders = ",".join("?" for _ in payload.relationship_ids)
    with db_session() as conn:
        cur = conn.execute(
            f"""
            UPDATE relationships
            SET needs_review = 0,
                is_locked = CASE WHEN ? = 1 THEN 1 ELSE is_locked END
            WHERE id IN ({placeholders})
            """,
            [1 if payload.is_locked else 0, *payload.relationship_ids],
        )
    return {"updated": cur.rowcount}


@router.delete("/relationships/{rel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_relationship(rel_id: int) -> None:
    with db_session() as conn:
        cur = conn.execute("DELETE FROM relationships WHERE id = ?", (rel_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Không tìm thấy cặp quan hệ.")


# ---------- Deterministic XML & Relevant Context ----------

@router.get("/volumes/{volume_id}/continuity/xml")
def get_continuity_xml(
    volume_id: int,
    download: bool = Query(default=False),
) -> Response:
    try:
        filename, xml_text = render_continuity_xml(volume_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    headers: dict[str, str] = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return Response(
        content=xml_text.encode("utf-8"),
        media_type="application/xml; charset=utf-8",
        headers=headers,
    )


@router.post(
    "/volumes/{volume_id}/continuity/relevant-context",
    response_model=RelevantContextResponse,
)
def preview_relevant_context(
    volume_id: int, payload: RelevantContextRequest
) -> RelevantContextResponse:
    try:
        data = build_relevant_context(volume_id, payload.chapter_text)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return RelevantContextResponse(**data)
