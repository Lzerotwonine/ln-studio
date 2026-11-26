"""Phase 3 tests: MAP/REDUCE Continuity Pack, Lock protection, Symmetry check, Deterministic XML, and Shared-Surname-Safe Alias Indexer."""

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
from app.services.continuity_service import (
    MISSING_REVERSE_PREFIX,
    ChapterMapSchema,
    VolumeReduceSchema,
    build_relevant_context,
    render_continuity_xml,
    run_map_phase,
    run_reduce_and_merge,
)


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_phase3.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


def test_map_phase_schema_caching_and_resume(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        s_id = conn.execute(
            "INSERT INTO series (title, source_lang, translation_mode) VALUES ('Mushoku Tensei', 'ja', 'ln_vn')"
        ).lastrowid
        v_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 12, 'Vol 12')",
            (s_id,),
        ).lastrowid
        conn.execute(
            "INSERT INTO chapters (volume_id, chapter_index, title, raw_text) VALUES (?, 1, 'Ch 1', '「シルフィ、ただいま」')",
            (v_id,),
        )
        conn.execute(
            "INSERT INTO chapters (volume_id, chapter_index, title, raw_text) VALUES (?, 2, 'Ch 2', '「ノルン、剣術を教えよう」')",
            (v_id,),
        )
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )

    calls: list[dict] = []

    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            calls.append({"model": model, "config": config})
            if "Ch 1" in contents:
                data = {
                    "main_events": ["Rudeus trở về nhà gặp Sylphiette."],
                    "characters_actual": [
                        {"name": "ルーデウス・グレイラット", "display_name": "Rudeus Greyrat", "aliases": ["ルディ"]},
                        {"name": "シルフィエット・グレイラット", "display_name": "Sylphiette Greyrat", "aliases": ["シルフィ"]},
                    ],
                    "characters_mentioned": [
                        {"name": "パウロ・グレイラット", "display_name": "Paul Greyrat", "aliases": ["パウロ"]}
                    ],
                    "dialogue_interactions": [
                        {
                            "speaker": "ルーデウス・グレイラット",
                            "listener": "シルフィエット・グレイラット",
                            "self_pronoun_raw": "俺",
                            "address_raw": "シルフィ",
                            "suggested_pair_vi": "Anh-Em",
                            "emotion_note": "Vợ chồng ấm áp",
                            "evidence_quote": "「シルフィ、ただいま」",
                        }
                    ],
                }
            else:
                data = {
                    "main_events": ["Rudeus đồng ý dạy kiếm thuật cho Norn."],
                    "characters_actual": [
                        {"name": "ルーデウス・グレイラット", "display_name": "Rudeus Greyrat", "aliases": ["ルディ"]},
                        {"name": "ノルン・グレイラット", "display_name": "Norn Greyrat", "aliases": ["ノルン"]},
                    ],
                    "characters_mentioned": [],
                    "dialogue_interactions": [
                        {
                            "speaker": "ルーデウス・グレイラット",
                            "listener": "ノルン・グレイラット",
                            "self_pronoun_raw": "俺",
                            "address_raw": "ノルン",
                            "suggested_pair_vi": "Anh-Em",
                            "emotion_note": "Anh trai quan tâm em gái",
                            "evidence_quote": "「ノルン、剣術を教えよう」",
                        }
                    ],
                }
            return SimpleNamespace(text=json.dumps(data, ensure_ascii=False))

    fake_pool = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )

    res1 = run_map_phase(v_id, pool=fake_pool, db_path=isolated_db)
    assert res1["processed_chapters"] == 2
    assert res1["skipped_cached"] == 0
    assert len(calls) == 2
    # Verify response_schema and JSON mime type passed to google-genai
    assert calls[0]["config"].response_mime_type == "application/json"
    assert calls[0]["config"].response_schema is ChapterMapSchema

    # Re-run without force_rerun -> resumes from chapters.summary_json cache (0 API calls)
    res2 = run_map_phase(v_id, force_rerun=False, pool=fake_pool, db_path=isolated_db)
    assert res2["processed_chapters"] == 0
    assert res2["skipped_cached"] == 2
    assert len(calls) == 2


def test_reduce_merge_lock_protection_symmetry_and_xml(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        s_id = conn.execute(
            "INSERT INTO series (title, source_lang, translation_mode) VALUES ('Mushoku Tensei', 'ja', 'ln_vn')"
        ).lastrowid
        v_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title, rtas_baseline) VALUES (?, 12, 'Vol 12', 3.0)",
            (s_id,),
        ).lastrowid
        v2_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 13, 'Vol 13')",
            (s_id,),
        ).lastrowid
        conn.execute(
            "INSERT INTO api_keys (name, api_key, is_active) VALUES ('KEY_1', 'secret-1', 1)"
        )

        # Pre-existing characters + LOCKED relationship Rudeus -> Sylphiette
        rudy_id = conn.execute(
            """
            INSERT INTO characters (series_id, canonical_name, display_name, aliases_json)
            VALUES (?, 'ルーデウス・グレイラット', 'Rudeus Greyrat', '["ルディ"]')
            """,
            (s_id,),
        ).lastrowid
        sylphy_id = conn.execute(
            """
            INSERT INTO characters (series_id, canonical_name, display_name, aliases_json)
            VALUES (?, 'シルフィエット・グレイラット', 'Sylphiette Greyrat', '["シルフィ"]')
            """,
            (s_id,),
        ).lastrowid
        conn.execute(
            """
            INSERT INTO relationships (
                series_id, source_char_id, target_char_id, pair_pronoun,
                rtas_score, notes, needs_review, is_locked, last_updated_vol
            )
            VALUES (?, ?, ?, 'Anh-Em (Locked)', 5.0, 'Vợ chồng cố định', 0, 1, 11)
            """,
            (s_id, rudy_id, sylphy_id),
        )

        # Seed cached MAP JSON where AI suggests a DIFFERENT pronoun for locked pair + new one-way pair Rudeus -> Norn
        map_payload = {
            "main_events": ["Rudeus hòa giải với Norn và trở về bên Sylphiette."],
            "characters_actual": [
                {"name": "ルーデウス・グレイラット", "display_name": "Rudeus Greyrat", "aliases": ["泥沼のルーデウス"]},
                {"name": "シルフィエット・グレイラット", "display_name": "Sylphiette Greyrat", "aliases": []},
                {"name": "ノルン・グレイラット", "display_name": "Norn Greyrat", "aliases": ["ノルン"]},
            ],
            "characters_mentioned": [
                {"name": "パウロ・グレイラット", "display_name": "Paul Greyrat", "aliases": ["パウロ"]}
            ],
            "dialogue_interactions": [
                {
                    "speaker": "ルーデウス・グレイラット",
                    "listener": "シルフィエット・グレイラット",
                    "self_pronoun_raw": "私",
                    "address_raw": "君",
                    "suggested_pair_vi": "Tôi-Em",
                    "emotion_note": "Thử ghi đè cặp đã khóa",
                    "evidence_quote": "「君に話がある」",
                },
                {
                    "speaker": "ルーデウス・グレイラット",
                    "listener": "ノルン・グレイラット",
                    "self_pronoun_raw": "俺",
                    "address_raw": "ノルン",
                    "suggested_pair_vi": "Anh-Em",
                    "emotion_note": "Quan tâm em gái",
                    "evidence_quote": "「ノルン、大丈夫か？」",
                },
            ],
        }
        conn.execute(
            "INSERT INTO chapters (volume_id, chapter_index, title, raw_text, summary_json, status) VALUES (?, 1, 'Ch 1', 'raw', ?, 'summarized')",
            (v_id, json.dumps(map_payload, ensure_ascii=False)),
        )

        # Seed glossary terms: only 'approved' AND in Vol 12 should appear in Vol 12 XML
        t_ok = conn.execute(
            """
            INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, reading, term_type, status)
            VALUES (?, '無詠唱', '無詠唱', 'vô niệm', 'mueishou', 'Skill', 'approved')
            """,
            (s_id,),
        ).lastrowid
        t_unapproved = conn.execute(
            """
            INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, reading, term_type, status)
            VALUES (?, '魔力', '魔力', 'ma lực', 'maryoku', 'Concept', 'translated')
            """,
            (s_id,),
        ).lastrowid
        t_other_vol = conn.execute(
            """
            INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, reading, term_type, status)
            VALUES (?, '聖剣', '聖剣', 'Thánh Kiếm', 'seiken', 'Item', 'approved')
            """,
            (s_id,),
        ).lastrowid
        conn.execute("INSERT INTO volume_glossary_freq (volume_id, term_id, freq) VALUES (?, ?, 5)", (v_id, t_ok))
        conn.execute("INSERT INTO volume_glossary_freq (volume_id, term_id, freq) VALUES (?, ?, 3)", (v_id, t_unapproved))
        conn.execute("INSERT INTO volume_glossary_freq (volume_id, term_id, freq) VALUES (?, ?, 4)", (v2_id, t_other_vol))

    reduce_calls: list[dict] = []

    class FakeModels:
        def generate_content(self, *, model: str, contents: str, config=None):
            reduce_calls.append({"contents": contents, "config": config})
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "volume_summary": "Tập 12 đánh dấu sự hòa giải của gia đình Greyrat.",
                        "rtas_current_avg": 4.2,
                        "rtas_drift": "Positive - Gắn kết gia đình sâu sắc hơn.",
                        "sub_arc_states": [
                            {
                                "character_name": "Norn Greyrat",
                                "subarc": "TSUNDERE",
                                "current_state": "DERE",
                                "notes": "Hòa giải với anh trai Rudeus.",
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
            )

    fake_pool = GeminiPool(
        db_path=isolated_db,
        client_factory=lambda _k: SimpleNamespace(models=FakeModels()),
    )

    res = run_reduce_and_merge(v_id, pool=fake_pool, db_path=isolated_db)
    assert len(reduce_calls) == 1
    assert reduce_calls[0]["config"].response_schema is VolumeReduceSchema
    assert res["locked_preserved"] == 1
    assert res["relationships_added"] == 1  # Rudeus -> Norn
    assert res["missing_reverse_created"] == 2  # Sylphiette -> Rudeus and Norn -> Rudeus (both ACTUAL!)
    assert res["sub_arc_updated"] == 1

    with db_session(isolated_db) as conn:
        # Locked relationship MUST stay untouched
        locked_row = conn.execute(
            "SELECT pair_pronoun, is_locked, needs_review FROM relationships WHERE source_char_id = ? AND target_char_id = ?",
            (rudy_id, sylphy_id),
        ).fetchone()
        assert locked_row["pair_pronoun"] == "Anh-Em (Locked)"
        assert locked_row["is_locked"] == 1
        assert locked_row["needs_review"] == 0

        # New relationship Rudeus -> Norn has needs_review=1 and evidence_quote
        norn_id = conn.execute(
            "SELECT id FROM characters WHERE canonical_name = 'ノルン・グレイラット'"
        ).fetchone()["id"]
        rudy_norn = conn.execute(
            "SELECT * FROM relationships WHERE source_char_id = ? AND target_char_id = ?",
            (rudy_id, norn_id),
        ).fetchone()
        assert rudy_norn["pair_pronoun"] == "Anh-Em"
        assert rudy_norn["needs_review"] == 1
        assert "ノルン、大丈夫か？" in rudy_norn["evidence_quote"]

        # Auto-created missing reverse draft Norn -> Rudeus
        norn_rudy = conn.execute(
            "SELECT * FROM relationships WHERE source_char_id = ? AND target_char_id = ?",
            (norn_id, rudy_id),
        ).fetchone()
        assert norn_rudy is not None
        assert norn_rudy["needs_review"] == 1
        assert norn_rudy["notes"].startswith(MISSING_REVERSE_PREFIX)

    # Verify Deterministic XML output
    filename, xml_str = render_continuity_xml(v_id, db_path=isolated_db)
    assert filename == "vol12_continuity_pack.xml"
    root = ET.fromstring(xml_str)
    assert root.tag == "CONTINUITY_DATA_PACK"
    assert root.findtext("META/SERIES") == "Mushoku Tensei"
    assert root.findtext("META/VOLUME_END") == "12"
    assert root.findtext("META/LAST_CHAPTER") == "1"
    assert root.findtext("RTAS_ANALYTICS/CURRENT_AVG") == "4.2"
    assert "hòa giải" in (root.findtext("VOLUME_SUMMARY") or "")

    subarcs = root.findall("SUB_ARC_STATE/CHAR")
    assert len(subarcs) == 1 and subarcs[0].attrib["name"] == "Norn Greyrat"

    # Glossary MUST contain ONLY approved term present in Vol 12 ('無詠唱')
    gl_terms = root.findall("GLOSSARY/TERM")
    assert len(gl_terms) == 1
    assert gl_terms[0].attrib["jp"] == "無詠唱"
    assert gl_terms[0].attrib["vn"] == "vô niệm"


def test_build_relevant_context_ignores_shared_surnames(isolated_db: Path) -> None:
    with db_session(isolated_db) as conn:
        s_id = conn.execute(
            "INSERT INTO series (title, source_lang) VALUES ('Mushoku', 'ja')"
        ).lastrowid
        v_id = conn.execute(
            "INSERT INTO volumes (series_id, volume_number, title) VALUES (?, 12, 'Vol 12')",
            (s_id,),
        ).lastrowid

        c_rudy = conn.execute(
            "INSERT INTO characters (series_id, canonical_name, display_name, aliases_json) VALUES (?, 'ルーデウス・グレイラット', 'Rudeus Greyrat', '[\"ルディ\"]')",
            (s_id,),
        ).lastrowid
        c_sylphy = conn.execute(
            "INSERT INTO characters (series_id, canonical_name, display_name, aliases_json) VALUES (?, 'シルフィエット・グレイラット', 'Sylphiette Greyrat', '[\"シルフィ\"]')",
            (s_id,),
        ).lastrowid
        c_norn = conn.execute(
            "INSERT INTO characters (series_id, canonical_name, display_name, aliases_json) VALUES (?, 'ノルン・グレイラット', 'Norn Greyrat', '[\"ノルン\"]')",
            (s_id,),
        ).lastrowid
        c_paul = conn.execute(
            "INSERT INTO characters (series_id, canonical_name, display_name, aliases_json) VALUES (?, 'パウロ・グレイラット', 'Paul Greyrat', '[\"パウロ\"]')",
            (s_id,),
        ).lastrowid

        conn.execute(
            "INSERT INTO relationships (series_id, source_char_id, target_char_id, pair_pronoun) VALUES (?, ?, ?, 'Anh-Em')",
            (s_id, c_rudy, c_norn),
        )
        conn.execute(
            "INSERT INTO relationships (series_id, source_char_id, target_char_id, pair_pronoun) VALUES (?, ?, ?, 'Anh-Em')",
            (s_id, c_rudy, c_sylphy),
        )
        conn.execute(
            "INSERT INTO relationships (series_id, source_char_id, target_char_id, pair_pronoun) VALUES (?, ?, ?, 'Con-Cha')",
            (s_id, c_rudy, c_paul),
        )
        conn.execute(
            "INSERT INTO glossary_terms (series_id, source_term, normalized_key, vi_term, term_type, status) VALUES (?, '無詠唱', '無詠唱', 'vô niệm', 'Skill', 'approved')",
            (s_id,),
        )

    # Chapter mentions Rudeus Greyrat, Norn, and shared family name グレイラット / Greyrat,
    # plus approved term 無詠唱 — MUST NOT match Sylphiette or Paul!
    chapter_text = "ルーデウス・グレイラットはノルンと一緒に無詠唱の練習をした。Greyrat家の誇りを胸に。"
    ctx = build_relevant_context(v_id, chapter_text, db_path=isolated_db)

    matched_names = {c["display_name"] for c in ctx["matched_characters"]}
    assert matched_names == {"Rudeus Greyrat", "Norn Greyrat"}
    assert "Sylphiette Greyrat" not in matched_names
    assert "Paul Greyrat" not in matched_names

    # Shared surname parts must appear in ignored_shared_parts
    ignored_lower = {p.lower() for p in ctx["ignored_shared_parts"]}
    assert "greyrat" in ignored_lower
    assert "グレイラット" in ctx["ignored_shared_parts"]

    # Only Rudeus -> Norn relationship should be included
    assert len(ctx["matched_relationships"]) == 1
    assert ctx["matched_relationships"][0]["target_name"] == "Norn Greyrat"

    # Approved glossary term matched
    assert len(ctx["matched_glossary"]) == 1
    assert ctx["matched_glossary"][0]["source_term"] == "無詠唱"


def test_phase3_rest_api_flow(client: TestClient) -> None:
    series = client.post(
        "/api/series",
        json={"title": "Phase 3 API", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()
    vol = client.post(
        f"/api/series/{series['id']}/volumes",
        json={"volume_number": 1, "title": "Tập 1"},
    ).json()

    c1 = client.post(
        f"/api/series/{series['id']}/characters",
        json={
            "canonical_name": "ルーデウス・グレイラット",
            "display_name": "Rudeus Greyrat",
            "aliases": ["ルディ"],
            "volume_id": vol["id"],
            "appearance": "ACTUAL",
        },
    ).json()
    c2 = client.post(
        f"/api/series/{series['id']}/characters",
        json={
            "canonical_name": "ロキシー・ミグルディア",
            "display_name": "Roxy Migurdia",
            "aliases": ["ロキシー"],
            "volume_id": vol["id"],
            "appearance": "ACTUAL",
        },
    ).json()

    # Update sub-arc state
    st_res = client.put(
        f"/api/volumes/{vol['id']}/characters/{c2['id']}/state",
        json={"appearance": "ACTUAL", "subarc": "MENTOR", "current_state": "TRUST", "notes": "Dạy ma thuật"},
    )
    assert st_res.status_code == 200

    # Create relationship & approve + lock
    rel = client.post(
        f"/api/series/{series['id']}/relationships",
        json={
            "source_char_id": c1["id"],
            "target_char_id": c2["id"],
            "pair_pronoun": "Em-Sư phụ",
            "evidence_quote": "「師匠、お願いします」",
            "needs_review": True,
        },
    ).json()
    assert rel["needs_review"] is True
    assert rel["is_missing_reverse"] is True

    app_res = client.post(
        f"/api/relationships/{rel['id']}/approve",
        json={"pair_pronoun": "Em-Sư phụ", "is_locked": True},
    )
    assert app_res.status_code == 200
    assert app_res.json()["needs_review"] is False
    assert app_res.json()["is_locked"] is True

    # Status + XML download + relevant context endpoint
    status_res = client.get(f"/api/volumes/{vol['id']}/continuity/status")
    assert status_res.status_code == 200
    assert status_res.json()["characters_count"] == 2
    assert status_res.json()["relationships_locked"] == 1

    xml_res = client.get(
        f"/api/volumes/{vol['id']}/continuity/xml", params={"download": "true"}
    )
    assert xml_res.status_code == 200
    assert "vol1_continuity_pack.xml" in xml_res.headers.get("content-disposition", "")
    assert "Em-Sư phụ" in xml_res.text

    ctx_res = client.post(
        f"/api/volumes/{vol['id']}/continuity/relevant-context",
        json={"chapter_text": "ルディはロキシーに挨拶した。"},
    )
    assert ctx_res.status_code == 200
    assert len(ctx_res.json()["matched_characters"]) == 2
    assert len(ctx_res.json()["matched_relationships"]) == 1
