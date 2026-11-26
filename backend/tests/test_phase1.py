"""Phase 1 smoke & unit tests for LN-Studio backend."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import DEFAULT_PROMPT_PRESETS, db_session, get_connection, init_db
from app.core.gemini_pool import GeminiPool, NoAvailableSlotsError, sanitize_models
from app.main import create_app


class FakeApiError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class FakeModelsAPI:
    def __init__(self, handler) -> None:
        self._handler = handler

    def generate_content(self, *, model: str, contents: str, config=None):
        return self._handler(model, contents, config)


class FakeGenaiClient:
    def __init__(self, api_key: str, handler) -> None:
        self.api_key = api_key
        self.models = FakeModelsAPI(lambda model, contents, cfg: handler(api_key, model, contents, cfg))


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_app.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


# ---------- Database Tests ----------

def test_init_db_enables_wal_fk_and_seeds_presets(isolated_db: Path) -> None:
    assert isolated_db.exists()
    conn = get_connection(isolated_db)
    try:
        journal = conn.execute("PRAGMA journal_mode;").fetchone()[0]
        fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
        presets = conn.execute("SELECT name, source_lang, mode FROM prompt_presets ORDER BY id").fetchall()
    finally:
        conn.close()

    assert str(journal).lower() == "wal"
    assert fk == 1
    assert len(presets) == 4
    expected_names = {p["name"] for p in DEFAULT_PROMPT_PRESETS}
    assert {row["name"] for row in presets} == expected_names


# ---------- GeminiPool Tests ----------

def test_sanitize_models_filters_empty_and_duplicates() -> None:
    raw = ["", "   ", "gemini-2.5-flash", " ", "gemini-2.5-pro", "gemini-2.5-flash", ""]
    assert sanitize_models(raw) == ["gemini-2.5-flash", "gemini-2.5-pro"]


def test_pool_503_backoff_rotates_keys_same_model_before_fallback(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_A', 'secret-a', 1)")
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_B', 'secret-b', 1)")

    calls: list[tuple[str, str]] = []
    sleeps: list[float] = []

    def handler(api_key: str, model: str, contents: str, cfg):
        calls.append((api_key, model))
        # First key on primary model returns 503; second key on SAME model succeeds
        if api_key == "secret-a" and model == "gemini-2.5-flash":
            raise FakeApiError(503, "503 UNAVAILABLE: model overloaded")
        return SimpleNamespace(text="ok-same-model")

    pool = GeminiPool(
        db_path=isolated_db,
        clock=lambda: 1000.0,
        today_fn=lambda: "2026-11-26",
        sleep_fn=lambda d: sleeps.append(d),
        client_factory=lambda key: FakeGenaiClient(key, handler),
        backoff_base_sec=0.5,
    )

    resp = pool.generate_content(
        "hello",
        models=["", "gemini-2.5-flash", "gemini-2.5-pro", "   "],
    )
    assert resp.text == "ok-same-model"
    assert resp.model_id == "gemini-2.5-flash"
    assert resp.key_name == "KEY_B"
    # Verify it rotated to KEY_B on SAME model before ever touching gemini-2.5-pro
    assert calls == [
        ("secret-a", "gemini-2.5-flash"),
        ("secret-b", "gemini-2.5-flash"),
    ]
    assert len(sleeps) == 1 and sleeps[0] >= 0.5


def test_pool_503_falls_back_to_next_model_after_all_keys_fail(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_A', 'secret-a', 1)")
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_B', 'secret-b', 1)")

    calls: list[tuple[str, str]] = []
    sleeps: list[float] = []

    def handler(api_key: str, model: str, contents: str, cfg):
        calls.append((api_key, model))
        if model == "gemini-2.5-flash":
            raise FakeApiError(503, "503 Service Unavailable")
        return SimpleNamespace(text="fallback-ok")

    pool = GeminiPool(
        db_path=isolated_db,
        clock=lambda: 2000.0,
        today_fn=lambda: "2026-11-26",
        sleep_fn=lambda d: sleeps.append(d),
        client_factory=lambda key: FakeGenaiClient(key, handler),
        backoff_base_sec=0.5,
    )

    resp = pool.generate_content("hello", models=["gemini-2.5-flash", "gemini-2.5-pro"])
    assert resp.text == "fallback-ok"
    assert resp.model_id == "gemini-2.5-pro"
    assert calls == [
        ("secret-a", "gemini-2.5-flash"),
        ("secret-b", "gemini-2.5-flash"),
        ("secret-a", "gemini-2.5-pro"),
    ]
    # Exponential backoff increased between 1st and 2nd 503
    assert len(sleeps) == 2
    assert sleeps[1] >= 1.0


def test_pool_429_daily_vs_rpm_and_401_session_disable_and_date_rollover(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_DAILY', 'k-daily', 1)")
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_RPM', 'k-rpm', 1)")
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_AUTH', 'k-auth', 1)")
        conn.execute("INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_OK', 'k-ok', 1)")

    current_day = ["2026-11-26"]
    now_ts = [5000.0]

    def handler(api_key: str, model: str, contents: str, cfg):
        if api_key == "k-daily":
            raise FakeApiError(429, "429 RESOURCE_EXHAUSTED: GenerateRequestsPerDayPerProjectPerModel exceeded")
        if api_key == "k-rpm":
            raise FakeApiError(429, "429 RESOURCE_EXHAUSTED: Rate limit per minute exceeded")
        if api_key == "k-auth":
            raise FakeApiError(403, "403 PERMISSION_DENIED: API key invalid")
        return SimpleNamespace(text="success-ok")

    pool = GeminiPool(
        db_path=isolated_db,
        clock=lambda: now_ts[0],
        today_fn=lambda: current_day[0],
        sleep_fn=lambda _d: None,
        client_factory=lambda key: FakeGenaiClient(key, handler),
    )

    resp = pool.generate_content("translate", models=["gemini-2.5-flash"])
    assert resp.key_name == "KEY_OK"
    assert resp.text == "success-ok"

    slots = {s["slot_id"]: s for s in pool.get_quota_status()}
    assert slots["KEY_DAILY|gemini-2.5-flash"]["is_daily_exhausted"] is True
    assert slots["KEY_DAILY|gemini-2.5-flash"]["status"] == "daily_exhausted"

    assert slots["KEY_RPM|gemini-2.5-flash"]["is_daily_exhausted"] is False
    assert slots["KEY_RPM|gemini-2.5-flash"]["status"] == "cooldown"
    assert slots["KEY_RPM|gemini-2.5-flash"]["cooldown_until"] == pytest.approx(5060.0)

    assert slots["KEY_AUTH|gemini-2.5-flash"]["is_session_disabled"] is True
    assert slots["KEY_AUTH|gemini-2.5-flash"]["status"] == "session_disabled"

    assert slots["KEY_OK|gemini-2.5-flash"]["requests_today"] == 1

    # Roll over to next day -> daily exhaustion & counts auto-reset
    current_day[0] = "2026-11-27"
    now_ts[0] = 90000.0
    slots_next_day = {s["slot_id"]: s for s in pool.get_quota_status()}
    assert slots_next_day["KEY_DAILY|gemini-2.5-flash"]["is_daily_exhausted"] is False
    assert slots_next_day["KEY_DAILY|gemini-2.5-flash"]["requests_today"] == 0
    assert slots_next_day["KEY_OK|gemini-2.5-flash"]["requests_today"] == 0
    # 401/403 stays disabled in-session until reset_quota
    assert slots_next_day["KEY_AUTH|gemini-2.5-flash"]["is_session_disabled"] is True

    pool.reset_quota("KEY_AUTH|gemini-2.5-flash")
    slots_after_reset = {s["slot_id"]: s for s in pool.get_quota_status()}
    assert slots_after_reset["KEY_AUTH|gemini-2.5-flash"]["is_session_disabled"] is False


def test_pool_raises_when_no_keys(isolated_db: Path) -> None:
    pool = GeminiPool(db_path=isolated_db)
    with pytest.raises(NoAvailableSlotsError):
        pool.generate_content("hello")


# ---------- REST API Smoke Tests ----------

def test_health_endpoint(client: TestClient) -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["journal_mode"].lower() == "wal"
    assert body["foreign_keys"] == "ON"


def test_series_and_volumes_crud(client: TestClient) -> None:
    # Create series
    create_res = client.post(
        "/api/series",
        json={
            "title": "Mushoku Tensei",
            "source_lang": "ja",
            "translation_mode": "hybrid",
            "system_prompt": "Test prompt",
            "hybrid_config": {
                "use_glossary": True,
                "use_characters": True,
                "use_relationships": True,
                "use_subarc": True,
                "rolling_context_lines": 8,
            },
        },
    )
    assert create_res.status_code == 201
    series = create_res.json()
    series_id = series["id"]
    assert series["source_lang"] == "ja"
    assert series["translation_mode"] == "hybrid"
    assert series["hybrid_config"]["rolling_context_lines"] == 8

    # Update series
    upd_res = client.put(
        f"/api/series/{series_id}",
        json={"title": "Mushoku Tensei VN", "source_lang": "ja"},
    )
    assert upd_res.status_code == 200
    assert upd_res.json()["title"] == "Mushoku Tensei VN"

    # Create volume
    vol_res = client.post(
        f"/api/series/{series_id}/volumes",
        json={
            "volume_number": 1,
            "title": "Tập 1 — Thời thơ ấu",
            "volume_summary": "Khởi đầu tại làng Buena",
            "rtas_baseline": 3.5,
        },
    )
    assert vol_res.status_code == 201
    vol = vol_res.json()
    assert vol["volume_number"] == 1

    # Duplicate volume_number -> 409
    dup_res = client.post(
        f"/api/series/{series_id}/volumes",
        json={"volume_number": 1, "title": "Trùng"},
    )
    assert dup_res.status_code == 409

    # Update volume
    vol_upd = client.put(
        f"/api/volumes/{vol['id']}",
        json={"status": "glossary_done", "title": "Tập 1 (Edited)"},
    )
    assert vol_upd.status_code == 200
    assert vol_upd.json()["status"] == "glossary_done"

    # List volumes
    vols = client.get(f"/api/series/{series_id}/volumes").json()
    assert len(vols) == 1

    # Delete series cascades volume
    del_res = client.delete(f"/api/series/{series_id}")
    assert del_res.status_code == 204
    assert client.get(f"/api/volumes/{vol['id']}").status_code == 404


def test_settings_api_keys_models_and_quota(client: TestClient) -> None:
    # Add API key
    k_res = client.post(
        "/api/settings/api-keys",
        json={"name": "API_KEY_1", "api_key": "AIzaSyTestSecretKey123456"},
    )
    assert k_res.status_code == 201
    key_obj = k_res.json()
    assert key_obj["masked_key"] == "AIza...3456"
    assert key_obj["is_active"] is True

    # Duplicate key name -> 409
    assert (
        client.post(
            "/api/settings/api-keys",
            json={"name": "API_KEY_1", "api_key": "AIzaSyOther"},
        ).status_code
        == 409
    )

    # Update models with empty strings -> filtered out
    m_res = client.put(
        "/api/settings/models",
        json={"models": ["", "  gemini-2.5-flash ", "", "gemini-2.5-pro", "gemini-2.5-flash"]},
    )
    assert m_res.status_code == 200
    assert m_res.json()["models"] == ["gemini-2.5-flash", "gemini-2.5-pro"]

    # Quota slots auto-populated for active key x models
    q_res = client.get("/api/settings/quota")
    assert q_res.status_code == 200
    q_data = q_res.json()
    slot_ids = {s["slot_id"] for s in q_data["slots"]}
    assert "API_KEY_1|gemini-2.5-flash" in slot_ids
    assert "API_KEY_1|gemini-2.5-pro" in slot_ids
    assert q_data["summary"]["ready"] >= 2

    # Reset quota
    rst_res = client.post("/api/settings/quota/reset", json={"slot_id": "API_KEY_1|gemini-2.5-flash"})
    assert rst_res.status_code == 200

    # Toggle inactive & delete
    patch_res = client.patch(f"/api/settings/api-keys/{key_obj['id']}", json={"is_active": False})
    assert patch_res.status_code == 200
    assert patch_res.json()["is_active"] is False

    assert client.delete(f"/api/settings/api-keys/{key_obj['id']}").status_code == 204


def test_presets_crud_and_seed_defaults(client: TestClient) -> None:
    res = client.get("/api/presets")
    assert res.status_code == 200
    initial = res.json()
    assert len(initial) == 4

    created = client.post(
        "/api/presets",
        json={
            "name": "Custom Slice of Life",
            "source_lang": "ja",
            "mode": "freeform",
            "content": "Dịch nhẹ nhàng đời thường.",
        },
    )
    assert created.status_code == 201
    pid = created.json()["id"]

    updated = client.put(f"/api/presets/{pid}", json={"content": "Đã cập nhật."})
    assert updated.status_code == 200
    assert updated.json()["content"] == "Đã cập nhật."

    # Delete a default preset and verify seed-defaults restores it
    first_default_id = initial[0]["id"]
    assert client.delete(f"/api/presets/{first_default_id}").status_code == 204

    seed_res = client.post("/api/presets/seed-defaults")
    assert seed_res.status_code == 200
    assert seed_res.json()["inserted"] == 1


def test_spa_dist_auto_serving(isolated_db: Path, tmp_path: Path) -> None:
    fake_dist = tmp_path / "dist"
    fake_dist.mkdir()
    (fake_dist / "index.html").write_text("<html><body>LN-Studio SPA</body></html>", encoding="utf-8")

    app = create_app(dist_dir=fake_dist)
    with TestClient(app) as tc:
        root_res = tc.get("/")
        assert root_res.status_code == 200
        assert "LN-Studio SPA" in root_res.text
        # Unknown /api route still returns 404 JSON instead of index.html
        assert tc.get("/api/does-not-exist").status_code == 404
