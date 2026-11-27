"""Batch B tests: Per-volume strict filtering, XML unification, pagination/sort/advanced filters, bulk-by-filter + translate-selected, and 2-step historical Excel import."""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import db_session, init_db
from app.core.gemini_pool import GeminiPool
from app.main import create_app
from app.services.continuity_service import render_continuity_xml
from app.services.epub_service import import_book_to_volume
from app.services.glossary_service import (
    extract_volume_glossary,
    import_glossary_tabular,
    render_glossary_xml,
    translate_selected_glossary_terms,
)


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_batch_b.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


def test_strict_per_volume_filtering_and_xml_consistency(
    client: TestClient, isolated_db: Path
) -> None:
    # 1. Create JA series with 2 volumes
    s_ja = client.post(
        "/api/series",
        json={"title": "JA Scope Test", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()
    v1 = client.post(
        f"/api/series/{s_ja['id']}/volumes",
        json={"volume_number": 1, "title": "Quyển 1"},
    ).json()
    v2 = client.post(
        f"/api/series/{s_ja['id']}/volumes",
        json={"volume_number": 2, "title": "Quyển 2"},
    ).json()

    # Import historical term (not present in Vol 1 or Vol 2!)
    hist_tsv = "jp\tvn\tromaji\ttype\n古語術\tCổ Ngữ Thuật\tkogojutsu\tSkill\n".encode("utf-8")
    import_glossary_tabular(
        s_ja["id"],
        "hist.tsv",
        hist_tsv,
        default_status="approved",
        default_first_seen_vol=0,
        db_path=isolated_db,
    )

    # Extract distinct terms in Vol 1 vs Vol 2
    import_book_to_volume(
        v1["id"],
        "v1.txt",
        "《ファイアボール》と《氷刃》を放った。ファイアボール！".encode("utf-8"),
        db_path=isolated_db,
    )
    import_book_to_volume(
        v2["id"],
        "v2.txt",
        "《ファイアボール》と《聖剣》が輝いた。".encode("utf-8"),
        db_path=isolated_db,
    )
    extract_volume_glossary(v1["id"], db_path=isolated_db)
    extract_volume_glossary(v2["id"], db_path=isolated_db)

    # Query Vol 1 ONLY: must contain ファイアボール (volume_freq=2) and 氷刃, NEVER 聖剣 or 古語術
    res_v1 = client.get(f"/api/series/{s_ja['id']}/glossary", params={"volume_id": v1["id"]}).json()
    keys_v1 = {item["normalized_key"]: item for item in res_v1["items"]}
    assert "ファイアボール" in keys_v1
    assert keys_v1["ファイアボール"]["volume_freq"] == 2
    assert keys_v1["ファイアボール"]["total_freq"] == 3
    assert "氷刃" in keys_v1
    assert "聖剣" not in keys_v1
    assert "古語術" not in keys_v1

    # Query Vol 2 ONLY: must contain ファイアボール (volume_freq=1) and 聖剣, NEVER 氷刃 or 古語術
    res_v2 = client.get(f"/api/series/{s_ja['id']}/glossary", params={"volume_id": v2["id"]}).json()
    keys_v2 = {item["normalized_key"]: item for item in res_v2["items"]}
    assert "ファイアボール" in keys_v2
    assert keys_v2["ファイアボール"]["volume_freq"] == 1
    assert "聖剣" in keys_v2
    assert "氷刃" not in keys_v2
    assert "古語術" not in keys_v2

    # Query ALL Series: must contain ALL 4 terms with volume_freq=None and distinct_first_seen_vols including 0, 1, 2
    res_all = client.get(f"/api/series/{s_ja['id']}/glossary").json()
    keys_all = {item["normalized_key"]: item for item in res_all["items"]}
    assert {"古語術", "ファイアボール", "氷刃", "聖剣"}.issubset(keys_all.keys())
    assert keys_all["ファイアボール"]["volume_freq"] is None
    assert keys_all["ファイアボール"]["total_freq"] == 3
    assert 0 in res_all["distinct_first_seen_vols"]
    assert 1 in res_all["distinct_first_seen_vols"]
    assert 2 in res_all["distinct_first_seen_vols"]

    # Approve ファイアボール and verify XML consistency between glossary_service and continuity_service
    with db_session(isolated_db) as conn:
        conn.execute(
            "UPDATE glossary_terms SET vi_term = 'Hỏa Cầu', reading = 'faiabooru', term_type = 'Skill', status = 'approved' WHERE series_id = ? AND normalized_key = 'ファイアボール'",
            (s_ja["id"],),
        )
    gl_xml = ET.fromstring(render_glossary_xml(s_ja["id"], volume_id=v1["id"], db_path=isolated_db))
    _, cp_xml_str = render_continuity_xml(v1["id"], db_path=isolated_db)
    cp_xml = ET.fromstring(cp_xml_str).find("GLOSSARY")
    assert cp_xml is not None

    gl_terms = [dict(el.attrib) for el in gl_xml.findall("TERM")]
    cp_terms = [dict(el.attrib) for el in cp_xml.findall("TERM")]
    assert gl_terms == cp_terms
    assert gl_terms[0] == {
        "jp": "ファイアボール",
        "vn": "Hỏa Cầu",
        "romaji": "faiabooru",
        "type": "Skill",
    }

    # Verify ZH series XML uses source + reading + han_viet consistently
    s_zh = client.post(
        "/api/series",
        json={"title": "ZH XML Test", "source_lang": "zh", "translation_mode": "freeform"},
    ).json()
    client.post(
        f"/api/series/{s_zh['id']}/glossary",
        json={
            "source_term": "青云宗",
            "vi_term": "Thanh Vân Tông",
            "reading": "Qingyunzong",
            "han_viet": "Thanh Vân Tông",
            "term_type": "Organization",
            "status": "approved",
            "first_seen_vol": 0,
        },
    )
    zh_xml = ET.fromstring(render_glossary_xml(s_zh["id"], db_path=isolated_db))
    zh_el = zh_xml.find("TERM")
    assert zh_el is not None
    assert zh_el.attrib["source"] == "青云宗"
    assert zh_el.attrib["vn"] == "Thanh Vân Tông"
    assert zh_el.attrib["reading"] == "Qingyunzong"
    assert zh_el.attrib["han_viet"] == "Thanh Vân Tông"


def test_uncapped_pagination_sorting_advanced_filters_and_bulk_by_filter(
    client: TestClient, isolated_db: Path
) -> None:
    s_id = client.post(
        "/api/series",
        json={"title": "Large Glossary 1250", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()["id"]

    # Insert 1,250 terms directly to verify removal of 1,000 limit + chunked bulk-by-filter
    with db_session(isolated_db) as conn:
        conn.executemany(
            """
            INSERT INTO glossary_terms (
                series_id, source_term, normalized_key, vi_term, reading, han_viet,
                english_meaning, term_type, status, first_seen_vol, total_freq
            ) VALUES (?, ?, ?, ?, '', ?, '', ?, ?, ?, ?)
            """,
            [
                (
                    s_id,
                    f"Term_{i:04d}",
                    f"Term_{i:04d}",
                    "" if i % 10 == 0 else f"Nghĩa {i:04d}",
                    "" if i % 5 == 0 else f"HV {i:04d}",
                    "Skill" if i % 2 == 0 else "Item",
                    "new" if i % 10 == 0 else "translated",
                    0 if i < 200 else 13,
                    (i % 20) + 1,
                )
                for i in range(1, 1251)
            ],
        )

    # 1. limit=0 returns ALL 1,250 terms (no 1000 cap!)
    res_all = client.get(f"/api/series/{s_id}/glossary", params={"limit": 0}).json()
    assert res_all["total_count"] == 1250
    assert len(res_all["items"]) == 1250

    # 2. Pagination limit=100, offset=100 + sort by source_term ASC
    res_p2 = client.get(
        f"/api/series/{s_id}/glossary",
        params={"limit": 100, "offset": 100, "sort_by": "source_term", "sort_dir": "asc"},
    ).json()
    assert res_p2["total_count"] == 1250
    assert len(res_p2["items"]) == 100
    assert res_p2["items"][0]["source_term"] == "Term_0101"
    assert res_p2["items"][-1]["source_term"] == "Term_0200"

    # 3. Advanced filters: missing_vi + first_seen_vol=0 + min_freq=5 + max_freq=15
    res_adv = client.get(
        f"/api/series/{s_id}/glossary",
        params={
            "missing_vi": "true",
            "first_seen_vol": 0,
            "min_freq": 5,
            "max_freq": 15,
            "limit": 0,
        },
    ).json()
    assert res_adv["total_count"] > 0
    for item in res_adv["items"]:
        assert item["vi_term"] == ""
        assert item["first_seen_vol"] == 0
        assert 5 <= item["total_freq"] <= 15

    # 4. Bulk status & bulk type using apply_to_filter=True across >600 rows (excluding 1 ID)
    skill_list = client.get(
        f"/api/series/{s_id}/glossary",
        params={"term_type": "Skill", "limit": 0},
    ).json()
    assert skill_list["total_count"] == 625
    excluded_id = skill_list["items"][0]["id"]

    bs = client.post(
        "/api/glossary/bulk-status",
        json={
            "series_id": s_id,
            "apply_to_filter": True,
            "filter": {"term_type": "Skill"},
            "exclude_ids": [excluded_id],
            "status": "approved",
        },
    )
    assert bs.status_code == 200
    assert bs.json()["updated"] == 624

    # Bulk type change on first_seen_vol=0 (199 items)
    bt = client.post(
        "/api/glossary/bulk-type",
        json={
            "series_id": s_id,
            "apply_to_filter": True,
            "filter": {"first_seen_vol": 0},
            "term_type": "Concept",
        },
    )
    assert bt.status_code == 200
    assert bt.json()["updated"] == 199

    # Bulk delete using apply_to_filter=True on missing_vi=True (125 items)
    bd = client.post(
        "/api/glossary/bulk-delete",
        json={
            "series_id": s_id,
            "apply_to_filter": True,
            "filter": {"missing_vi": True},
        },
    )
    assert bd.status_code == 200
    assert bd.json()["deleted"] == 125

    after_del = client.get(f"/api/series/{s_id}/glossary", params={"limit": 1}).json()
    assert after_del["total_count"] == 1125


def test_translate_selected_terms_and_two_step_excel_sync(
    client: TestClient, isolated_db: Path
) -> None:
    s_id = client.post(
        "/api/series",
        json={"title": "Mushoku Sync Test", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()["id"]

    with db_session(isolated_db) as conn:
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )

    # STEP 1: Import unfiltered historical File 1 (3 terms, 1 with empty vi_term) as 'ignored', first_seen_vol=0
    file1_tsv = (
        "jp\tvn\tromaji\ttype\n"
        "無詠唱\t\tmueishou\tSkill\n"
        "魔力\tma lực cũ\tmaryoku\tConcept\n"
        "ノイズ語\t\tnoizu\tConcept\n"
    ).encode("utf-8")

    r1 = client.post(
        f"/api/series/{s_id}/glossary/import",
        files={"file": ("vol1_12_raw.tsv", file1_tsv, "text/tab-separated-values")},
        data={
            "default_status": "ignored",
            "duplicate_mode": "skip",
            "default_first_seen_vol": "0",
            "force_default_status": "true",
        },
    )
    assert r1.status_code == 200
    assert r1.json() == {"imported": 3, "updated": 0, "skipped": 0}

    # Verify all 3 are 'ignored' (even with blank vi_term!) and first_seen_vol == 0
    after_step1 = client.get(f"/api/series/{s_id}/glossary", params={"limit": 0}).json()
    by_key_1 = {i["normalized_key"]: i for i in after_step1["items"]}
    assert by_key_1["無詠唱"]["status"] == "ignored"
    assert by_key_1["無詠唱"]["first_seen_vol"] == 0
    assert by_key_1["ノイズ語"]["status"] == "ignored"

    # STEP 2: Import filtered File 2 (2 terms) with status='approved', duplicate_mode='upsert', first_seen_vol=0
    file2_tsv = (
        "jp\tvn\tromaji\than_viet\ttype\n"
        "無詠唱\tVô niệm\tmueishou\tVô Vịnh Xướng\tSkill\n"
        "魔力\tMa lực\tmaryoku\tMa Lực\tConcept\n"
    ).encode("utf-8")
    r2 = client.post(
        f"/api/series/{s_id}/glossary/import",
        files={"file": ("vol1_12_clean.tsv", file2_tsv, "text/tab-separated-values")},
        data={
            "default_status": "approved",
            "duplicate_mode": "upsert",
            "default_first_seen_vol": "0",
            "force_default_status": "true",
        },
    )
    assert r2.status_code == 200
    assert r2.json() == {"imported": 0, "updated": 2, "skipped": 0}

    after_step2 = client.get(f"/api/series/{s_id}/glossary", params={"limit": 0}).json()
    by_key_2 = {i["normalized_key"]: i for i in after_step2["items"]}
    assert by_key_2["無詠唱"]["status"] == "approved"
    assert by_key_2["無詠唱"]["vi_term"] == "Vô niệm"
    assert by_key_2["無詠唱"]["han_viet"] == "Vô Vịnh Xướng"
    assert by_key_2["魔力"]["status"] == "approved"
    assert by_key_2["魔力"]["vi_term"] == "Ma lực"
    assert by_key_2["ノイズ語"]["status"] == "ignored"  # untouched!

    # Test duplicate_mode='skip' does NOT overwrite existing approved term
    file3_tsv = "jp\tvn\n無詠唱\tBản dịch sai\n新語\tTừ mới\n".encode("utf-8")
    r3 = client.post(
        f"/api/series/{s_id}/glossary/import",
        files={"file": ("extra.tsv", file3_tsv, "text/tab-separated-values")},
        data={
            "default_status": "translated",
            "duplicate_mode": "skip",
            "default_first_seen_vol": "0",
            "force_default_status": "true",
        },
    )
    assert r3.status_code == 200
    assert r3.json() == {"imported": 1, "updated": 0, "skipped": 1}

    # Test translate_selected_glossary_terms re-translates an ALREADY approved term when explicitly selected
    target_id = by_key_2["魔力"]["id"]

    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            payload = [
                {
                    "source_term": "魔力",
                    "reading": "maryoku",
                    "english_meaning": "mana",
                    "han_viet": "Ma Lực",
                    "vi_term": "Ma Lực (AI dịch lại)",
                    "term_type": "Concept",
                }
            ]
            return SimpleNamespace(text=json.dumps(payload, ensure_ascii=False))

    fake_pool = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )
    tr_res = translate_selected_glossary_terms(
        s_id,
        term_ids=[target_id],
        pool=fake_pool,
        db_path=isolated_db,
    )
    assert tr_res["total_new_found"] == 1
    assert tr_res["translated_count"] == 1
    with db_session(isolated_db) as conn:
        row = conn.execute(
            "SELECT vi_term, status FROM glossary_terms WHERE id = ?",
            (target_id,),
        ).fetchone()
    assert row["vi_term"] == "Ma Lực (AI dịch lại)"
    assert row["status"] == "translated"
