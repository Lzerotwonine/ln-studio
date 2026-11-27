"""Multi-Key x Multi-Model Gemini API Pool backed by SQLite quota_slots."""

from __future__ import annotations

import logging
import random
import re
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable

from google import genai
from google.genai import types

from app.core.database import (
    DEFAULT_MODEL_LIMITS,
    DEFAULT_MODELS,
    DEFAULT_TASK_MODELS,
    TASK_MODEL_KEYS,
    db_session,
    get_setting,
)

logger = logging.getLogger(__name__)

_STATUS_CODE_RE = re.compile(r"\b(401|403|429|500|502|503|504)\b")


class GeminiPoolError(Exception):
    """Base exception for GeminiPool failures."""


class NoAvailableSlotsError(GeminiPoolError):
    """Raised when no API keys or models are configured, or all slots are exhausted."""


@dataclass(frozen=True)
class PoolResponse:
    """Structured response returned by GeminiPool.generate_content."""

    text: str
    slot_id: str
    key_name: str
    model_id: str
    attempts: int


def sanitize_models(models: Iterable[str] | None) -> list[str]:
    """Filter out empty/whitespace strings and deduplicate while preserving priority order."""
    if not models:
        return []
    seen: set[str] = set()
    cleaned: list[str] = []
    for raw in models:
        if not isinstance(raw, str):
            continue
        model_id = raw.strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        cleaned.append(model_id)
    return cleaned


def make_slot_id(key_name: str, model_id: str) -> str:
    """Build canonical slot identifier KEY_NAME|model-id."""
    return f"{key_name}|{model_id}"


def classify_gemini_error(exc: Exception) -> tuple[str, int | None, str]:
    """Classify a Gemini SDK exception into a handling category.

    Returns (category, status_code, message) where category is one of:
    - 'auth_error'   (401/403 or invalid key/permission denied)
    - 'daily_quota'  (429 containing PerDay / Daily / GenerateRequestsPerDay)
    - 'rate_limit'   (429 transient RPM/TPM quota)
    - 'unavailable'  (503 / overloaded / service unavailable)
    - 'transient'    (500 / 502 / 504 / connection timeout)
    - 'fatal'        (non-retryable client/prompt error)
    """
    msg = str(exc) or exc.__class__.__name__
    msg_lower = msg.lower()

    status_code: int | None = None
    for attr in ("code", "status_code"):
        val = getattr(exc, attr, None)
        if isinstance(val, int):
            status_code = val
            break
    if status_code is None:
        match = _STATUS_CODE_RE.search(msg)
        if match:
            status_code = int(match.group(1))

    # 1. Authentication / Permission errors -> disable slot for session
    if (
        status_code in (401, 403)
        or "api_key_invalid" in msg_lower
        or "api key not valid" in msg_lower
        or "permission_denied" in msg_lower
        or "unauthenticated" in msg_lower
        or "unauthorized" in msg_lower
    ):
        return "auth_error", status_code, msg

    # 2. Quota / Rate limit errors (429 / RESOURCE_EXHAUSTED)
    if (
        status_code == 429
        or "resource_exhausted" in msg_lower
        or "quota" in msg_lower
        or "rate limit" in msg_lower
    ):
        if (
            "perday" in msg_lower
            or "daily" in msg_lower
            or "generaterequestsperday" in msg_lower
        ):
            return "daily_quota", status_code or 429, msg
        return "rate_limit", status_code or 429, msg

    # 3. 503 / Overloaded / Service Unavailable
    if (
        status_code == 503
        or "unavailable" in msg_lower
        or "overloaded" in msg_lower
        or "service unavailable" in msg_lower
    ):
        return "unavailable", status_code or 503, msg

    # 4. Other 5xx / transient network errors
    if (
        status_code in (500, 502, 504)
        or "timeout" in msg_lower
        or "timed out" in msg_lower
        or "connection reset" in msg_lower
    ):
        return "transient", status_code, msg

    return "fatal", status_code, msg


class GeminiPool:
    """Manages a Multi-Key x Multi-Model Gemini execution pool with SQLite quota tracking."""

    def __init__(
        self,
        db_path: Path | str | None = None,
        *,
        clock: Callable[[], float] = time.time,
        today_fn: Callable[[], str] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        client_factory: Callable[[str], Any] | None = None,
        backoff_base_sec: float = 1.0,
        backoff_max_sec: float = 16.0,
        cooldown_429_sec: float = 60.0,
        cooldown_503_sec: float = 15.0,
    ) -> None:
        self.db_path = db_path
        self._clock = clock
        self._today_fn = today_fn or (lambda: datetime.now().strftime("%Y-%m-%d"))
        self._sleep = sleep_fn
        self._client_factory = client_factory or (lambda api_key: genai.Client(api_key=api_key))
        self.backoff_base_sec = backoff_base_sec
        self.backoff_max_sec = backoff_max_sec
        self.cooldown_429_sec = cooldown_429_sec
        self.cooldown_503_sec = cooldown_503_sec

        self._lock = threading.RLock()
        self._clients: dict[str, Any] = {}
        self._session_disabled: dict[str, str] = {}
        self._rpm_windows: dict[str, deque[float]] = {}

    def _get_client(self, api_key: str) -> Any:
        with self._lock:
            client = self._clients.get(api_key)
            if client is None:
                client = self._client_factory(api_key)
                self._clients[api_key] = client
            return client

    def _load_active_keys(self, conn: sqlite3.Connection) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT id, name, api_key FROM api_keys WHERE is_active = 1 ORDER BY id ASC"
        ).fetchall()
        return [dict(r) for r in rows if (r["api_key"] or "").strip()]

    def _load_task_models_map(self, conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
        raw = get_setting(conn, "task_models", DEFAULT_TASK_MODELS)
        merged: dict[str, dict[str, Any]] = {}
        for key in TASK_MODEL_KEYS:
            default_cfg = DEFAULT_TASK_MODELS[key]
            entry = raw.get(key) if isinstance(raw, dict) else None
            if isinstance(entry, dict):
                primary = str(entry.get("primary") or default_cfg["primary"]).strip()
                fallbacks = sanitize_models(entry.get("fallbacks"))
                merged[key] = {
                    "primary": primary or default_cfg["primary"],
                    "fallbacks": [m for m in fallbacks if m != primary],
                }
            else:
                merged[key] = {
                    "primary": default_cfg["primary"],
                    "fallbacks": list(default_cfg["fallbacks"]),
                }
        return merged

    def _load_models(
        self,
        conn: sqlite3.Connection,
        override_models: Iterable[str] | None = None,
        task_type: str | None = None,
    ) -> list[str]:
        if override_models is not None:
            cleaned = sanitize_models(override_models)
            if cleaned:
                return cleaned
        if task_type and task_type in TASK_MODEL_KEYS:
            task_map = self._load_task_models_map(conn)
            cfg = task_map.get(task_type)
            if cfg:
                ordered = sanitize_models([cfg["primary"], *cfg.get("fallbacks", [])])
                if ordered:
                    return ordered
        raw_models = get_setting(conn, "model_priority", DEFAULT_MODELS)
        return sanitize_models(raw_models if isinstance(raw_models, list) else DEFAULT_MODELS)

    def _load_all_configured_models(self, conn: sqlite3.Connection) -> list[str]:
        """Collect all models configured in global priority AND task_models for quota tracking."""
        base = self._load_models(conn)
        task_map = self._load_task_models_map(conn)
        extra: list[str] = []
        for cfg in task_map.values():
            extra.append(cfg["primary"])
            extra.extend(cfg.get("fallbacks", []))
        return sanitize_models([*base, *extra])

    def _load_model_limits(self, conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
        raw = get_setting(conn, "model_limits", DEFAULT_MODEL_LIMITS)
        if not isinstance(raw, dict):
            return dict(DEFAULT_MODEL_LIMITS)
        merged = dict(DEFAULT_MODEL_LIMITS)
        merged.update(raw)
        return merged

    def _limits_for_model(
        self, limits_map: dict[str, dict[str, int]], model_id: str
    ) -> tuple[int, int]:
        default_cfg = limits_map.get("default", {"rpm": 10, "rpd": 250})
        model_cfg = limits_map.get(model_id, default_cfg)
        rpm = int(model_cfg.get("rpm", default_cfg.get("rpm", 10)))
        rpd = int(model_cfg.get("rpd", default_cfg.get("rpd", 250)))
        return max(1, rpm), max(1, rpd)

    def _ensure_and_rollover_slots(
        self,
        conn: sqlite3.Connection,
        active_keys: list[dict[str, Any]],
        models: list[str],
        today: str,
    ) -> None:
        """Reset any stale-date quota_slots and ensure rows exist for active key x model pairs."""
        # Auto-reset all rows from previous dates
        conn.execute(
            """
            UPDATE quota_slots
            SET requests_today = 0,
                quota_date = ?,
                cooldown_until = 0,
                is_daily_exhausted = 0,
                last_error = NULL
            WHERE quota_date != ?
            """,
            (today, today),
        )

        for model_id in models:
            for key_info in active_keys:
                slot_id = make_slot_id(key_info["name"], model_id)
                conn.execute(
                    """
                    INSERT OR IGNORE INTO quota_slots (
                        slot_id, key_name, model_id,
                        requests_today, quota_date, last_request_ts,
                        cooldown_until, is_daily_exhausted, last_error
                    )
                    VALUES (?, ?, ?, 0, ?, 0, 0, 0, NULL)
                    """,
                    (slot_id, key_info["name"], model_id, today),
                )

    def _prune_rpm_window(self, slot_id: str, now: float) -> deque[float]:
        window = self._rpm_windows.setdefault(slot_id, deque())
        cutoff = now - 60.0
        while window and window[0] <= cutoff:
            window.popleft()
        return window

    def _record_success(
        self,
        conn: sqlite3.Connection,
        slot_id: str,
        key_name: str,
        model_id: str,
        today: str,
        now: float,
    ) -> None:
        conn.execute(
            """
            INSERT INTO quota_slots (
                slot_id, key_name, model_id, requests_today, quota_date,
                last_request_ts, cooldown_until, is_daily_exhausted, last_error
            )
            VALUES (?, ?, ?, 1, ?, ?, 0, 0, NULL)
            ON CONFLICT(slot_id) DO UPDATE SET
                requests_today = CASE
                    WHEN quota_slots.quota_date != excluded.quota_date THEN 1
                    ELSE quota_slots.requests_today + 1
                END,
                quota_date = excluded.quota_date,
                last_request_ts = excluded.last_request_ts,
                cooldown_until = 0,
                last_error = NULL
            """,
            (slot_id, key_name, model_id, today, now),
        )
        with self._lock:
            window = self._prune_rpm_window(slot_id, now)
            window.append(now)

    def _record_slot_error(
        self,
        conn: sqlite3.Connection,
        slot_id: str,
        *,
        cooldown_until: float | None = None,
        is_daily_exhausted: int | None = None,
        last_error: str,
    ) -> None:
        truncated_error = last_error[:500]
        updates: list[str] = ["last_error = ?"]
        params: list[Any] = [truncated_error]
        if cooldown_until is not None:
            updates.append("cooldown_until = ?")
            params.append(cooldown_until)
        if is_daily_exhausted is not None:
            updates.append("is_daily_exhausted = ?")
            params.append(is_daily_exhausted)
        params.append(slot_id)
        conn.execute(
            f"UPDATE quota_slots SET {', '.join(updates)} WHERE slot_id = ?",
            params,
        )

    def get_quota_status(self) -> list[dict[str, Any]]:
        """Synchronize slots and return real-time status for all tracked slots."""
        now = self._clock()
        today = self._today_fn()

        with db_session(self.db_path) as conn:
            active_keys = self._load_active_keys(conn)
            models = self._load_all_configured_models(conn)
            limits_map = self._load_model_limits(conn)
            self._ensure_and_rollover_slots(conn, active_keys, models, today)

            active_slot_ids = {
                make_slot_id(k["name"], m) for m in models for k in active_keys
            }
            model_rank = {m: idx for idx, m in enumerate(models)}
            key_rank = {k["name"]: idx for idx, k in enumerate(active_keys)}

            rows = conn.execute("SELECT * FROM quota_slots").fetchall()

        results: list[dict[str, Any]] = []
        with self._lock:
            for row in rows:
                slot_id = row["slot_id"]
                model_id = row["model_id"]
                key_name = row["key_name"]
                rpm_limit, rpd_limit = self._limits_for_model(limits_map, model_id)
                window = self._prune_rpm_window(slot_id, now)
                rpm_used = len(window)
                cooldown_until = float(row["cooldown_until"] or 0.0)
                cooldown_remaining = max(0.0, cooldown_until - now)
                is_daily_exhausted = bool(row["is_daily_exhausted"])
                session_disabled_reason = self._session_disabled.get(slot_id)
                requests_today = int(row["requests_today"] or 0)

                if session_disabled_reason is not None:
                    status = "session_disabled"
                elif is_daily_exhausted or requests_today >= rpd_limit:
                    status = "daily_exhausted"
                elif cooldown_remaining > 0 or rpm_used >= rpm_limit:
                    status = "cooldown"
                else:
                    status = "ready"

                results.append(
                    {
                        "slot_id": slot_id,
                        "key_name": key_name,
                        "model_id": model_id,
                        "requests_today": requests_today,
                        "quota_date": row["quota_date"],
                        "last_request_ts": float(row["last_request_ts"] or 0.0),
                        "cooldown_until": cooldown_until,
                        "cooldown_remaining_sec": round(cooldown_remaining, 1),
                        "is_daily_exhausted": is_daily_exhausted,
                        "is_session_disabled": session_disabled_reason is not None,
                        "rpm_used": rpm_used,
                        "rpm_limit": rpm_limit,
                        "rpd_limit": rpd_limit,
                        "status": status,
                        "is_active_slot": slot_id in active_slot_ids,
                        "last_error": session_disabled_reason or row["last_error"],
                        "_sort": (
                            0 if slot_id in active_slot_ids else 1,
                            model_rank.get(model_id, 999),
                            key_rank.get(key_name, 999),
                            slot_id,
                        ),
                    }
                )

        results.sort(key=lambda item: item["_sort"])
        for item in results:
            item.pop("_sort", None)
        return results

    def reset_quota(self, slot_id: str | None = None) -> int:
        """Reset quota counters, cooldowns, daily exhaustion, and session disables."""
        today = self._today_fn()
        with db_session(self.db_path) as conn:
            if slot_id:
                cur = conn.execute(
                    """
                    UPDATE quota_slots
                    SET requests_today = 0,
                        quota_date = ?,
                        last_request_ts = 0,
                        cooldown_until = 0,
                        is_daily_exhausted = 0,
                        last_error = NULL
                    WHERE slot_id = ?
                    """,
                    (today, slot_id),
                )
                affected = cur.rowcount
            else:
                cur = conn.execute(
                    """
                    UPDATE quota_slots
                    SET requests_today = 0,
                        quota_date = ?,
                        last_request_ts = 0,
                        cooldown_until = 0,
                        is_daily_exhausted = 0,
                        last_error = NULL
                    """,
                    (today,),
                )
                affected = cur.rowcount

        with self._lock:
            if slot_id:
                self._session_disabled.pop(slot_id, None)
                self._rpm_windows.pop(slot_id, None)
            else:
                self._session_disabled.clear()
                self._rpm_windows.clear()

        return affected

    def _select_ordered_keys_for_model(
        self,
        conn: sqlite3.Connection,
        active_keys: list[dict[str, Any]],
        model_id: str,
        rpm_limit: int,
        rpd_limit: int,
        now: float,
    ) -> list[dict[str, Any]]:
        """Return active keys that are currently eligible for `model_id`, balanced by usage."""
        candidates: list[tuple[tuple[int, float, int], dict[str, Any]]] = []
        with self._lock:
            for idx, key_info in enumerate(active_keys):
                slot_id = make_slot_id(key_info["name"], model_id)
                if slot_id in self._session_disabled:
                    continue

                row = conn.execute(
                    """
                    SELECT requests_today, last_request_ts, cooldown_until, is_daily_exhausted
                    FROM quota_slots
                    WHERE slot_id = ?
                    """,
                    (slot_id,),
                ).fetchone()
                if row is None:
                    continue
                if row["is_daily_exhausted"]:
                    continue
                requests_today = int(row["requests_today"] or 0)
                if requests_today >= rpd_limit:
                    continue
                cooldown_until = float(row["cooldown_until"] or 0.0)
                if cooldown_until > now:
                    continue
                window = self._prune_rpm_window(slot_id, now)
                if len(window) >= rpm_limit:
                    continue

                last_ts = float(row["last_request_ts"] or 0.0)
                # Prefer least-used key today, then least-recently-used key, then DB order
                candidates.append(((requests_today, last_ts, idx), key_info))

        candidates.sort(key=lambda item: item[0])
        return [item[1] for item in candidates]

    def generate_content(
        self,
        prompt: str,
        *,
        system_instruction: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
        response_mime_type: str | None = None,
        response_schema: Any = None,
        safety_settings: list[Any] | None = None,
        task_type: str | None = None,
        models: Iterable[str] | None = None,
        max_503_rounds_per_model: int = 1,
    ) -> PoolResponse:
        """Execute a Gemini generation call with automatic key/model failover and quota tracking."""
        today = self._today_fn()
        with db_session(self.db_path) as conn:
            active_keys = self._load_active_keys(conn)
            target_models = self._load_models(
                conn, override_models=models, task_type=task_type
            )
            limits_map = self._load_model_limits(conn)
            if not active_keys:
                raise NoAvailableSlotsError("Không có API Key nào đang hoạt động.")
            if not target_models:
                raise NoAvailableSlotsError("Danh sách model cấu hình đang trống.")
            self._ensure_and_rollover_slots(conn, active_keys, target_models, today)

        config_kwargs: dict[str, Any] = {}
        if system_instruction:
            config_kwargs["system_instruction"] = system_instruction
        if temperature is not None:
            config_kwargs["temperature"] = temperature
        if max_output_tokens is not None:
            config_kwargs["max_output_tokens"] = max_output_tokens
        if response_mime_type is not None:
            config_kwargs["response_mime_type"] = response_mime_type
        if response_schema is not None:
            config_kwargs["response_schema"] = response_schema
        if safety_settings is not None:
            config_kwargs["safety_settings"] = safety_settings
        gen_config = types.GenerateContentConfig(**config_kwargs) if config_kwargs else None

        attempts = 0
        errors: list[str] = []

        # Iterate model-by-model in priority order; exhaust keys of the same model before falling back
        for model_id in target_models:
            rpm_limit, rpd_limit = self._limits_for_model(limits_map, model_id)
            model_503_count = 0
            tried_keys_this_model: set[str] = set()

            for round_idx in range(max(1, max_503_rounds_per_model)):
                if round_idx > 0:
                    # Only do another round on the same model if 503 occurred and keys remain
                    if model_503_count == 0:
                        break
                    tried_keys_this_model.clear()

                while True:
                    now = self._clock()
                    today = self._today_fn()
                    with db_session(self.db_path) as conn:
                        self._ensure_and_rollover_slots(conn, active_keys, target_models, today)
                        eligible_keys = self._select_ordered_keys_for_model(
                            conn, active_keys, model_id, rpm_limit, rpd_limit, now
                        )

                    # Filter out keys already tried in this round for this model
                    next_key = next(
                        (k for k in eligible_keys if k["name"] not in tried_keys_this_model),
                        None,
                    )
                    if next_key is None:
                        break

                    key_name = next_key["name"]
                    tried_keys_this_model.add(key_name)
                    slot_id = make_slot_id(key_name, model_id)
                    attempts += 1

                    try:
                        client = self._get_client(next_key["api_key"])
                        call_kwargs: dict[str, Any] = {
                            "model": model_id,
                            "contents": prompt,
                        }
                        if gen_config is not None:
                            call_kwargs["config"] = gen_config
                        response = client.models.generate_content(**call_kwargs)
                        text = getattr(response, "text", None)
                        if text is None:
                            text = str(response)

                        success_now = self._clock()
                        success_today = self._today_fn()
                        with db_session(self.db_path) as conn:
                            self._record_success(
                                conn, slot_id, key_name, model_id, success_today, success_now
                            )

                        return PoolResponse(
                            text=text,
                            slot_id=slot_id,
                            key_name=key_name,
                            model_id=model_id,
                            attempts=attempts,
                        )
                    except Exception as exc:
                        category, status_code, msg = classify_gemini_error(exc)
                        err_now = self._clock()
                        errors.append(f"{slot_id} [{category}/{status_code}]: {msg}")
                        logger.warning(
                            "Gemini slot %s failed (%s, code=%s): %s",
                            slot_id,
                            category,
                            status_code,
                            msg,
                        )

                        if category == "auth_error":
                            with self._lock:
                                self._session_disabled[slot_id] = msg
                            with db_session(self.db_path) as conn:
                                self._record_slot_error(
                                    conn,
                                    slot_id,
                                    last_error=f"[401/403 Session Disabled] {msg}",
                                )
                            continue

                        if category == "daily_quota":
                            with db_session(self.db_path) as conn:
                                self._record_slot_error(
                                    conn,
                                    slot_id,
                                    cooldown_until=0,
                                    is_daily_exhausted=1,
                                    last_error=f"[429 Daily Exhausted] {msg}",
                                )
                            continue

                        if category == "rate_limit":
                            with db_session(self.db_path) as conn:
                                self._record_slot_error(
                                    conn,
                                    slot_id,
                                    cooldown_until=err_now + self.cooldown_429_sec,
                                    last_error=f"[429 Cooldown {int(self.cooldown_429_sec)}s] {msg}",
                                )
                            continue

                        if category in ("unavailable", "transient"):
                            # Exponential backoff + rotate to another key on the SAME model first
                            delay = min(
                                self.backoff_max_sec,
                                self.backoff_base_sec * (2**model_503_count),
                            )
                            jitter = random.uniform(0, delay * 0.25) if delay > 0 else 0.0
                            model_503_count += 1
                            with db_session(self.db_path) as conn:
                                self._record_slot_error(
                                    conn,
                                    slot_id,
                                    cooldown_until=err_now + self.cooldown_503_sec,
                                    last_error=f"[503 Unavailable] {msg}",
                                )
                            if delay + jitter > 0:
                                self._sleep(delay + jitter)
                            continue

                        # Fatal non-retryable error (e.g., invalid request / safety block)
                        with db_session(self.db_path) as conn:
                            self._record_slot_error(conn, slot_id, last_error=msg)
                        raise

        summary = "; ".join(errors[-6:]) if errors else "Tất cả slot đều đang cooldown hoặc đã hết quota."
        raise NoAvailableSlotsError(f"Không còn slot Gemini khả dụng. Chi tiết: {summary}")


# Shared singleton pool instance used by API routes and services
gemini_pool = GeminiPool()
