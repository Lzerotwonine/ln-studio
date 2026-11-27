"""Batch A tests: Legacy preset cleanup, flexible Volume labels, and Chapter Manager APIs."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import DEFAULT_PROMPT_PRESETS, db_session, init_db
from app.main import create_app


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "test_batch_a.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)
    return db_file


@pytest.fixture()
def client(isolated_db: Path) -> TestClient:
    app = create_app()
    with TestClient(app) as tc:
        yield tc


def test_default_presets_have_freeform_name_and_legacy_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Ensure default preset names use "Nhật Tự Do (Freeform)" and contain no legacy name
    preset_names = [p["name"] for p in DEFAULT_PROMPT_PRESETS]
    assert "Nhật Tự Do (Freeform)" in preset_names
    legacy_token = "ai" + "ko"
    for preset in DEFAULT_PROMPT_PRESETS:
        assert legacy_token not in preset["name"].lower()
        assert legacy_token not in preset["content"].lower()

    # Simulate an older DB with the legacy preset name and verify init_db migrates it cleanly
    db_file = tmp_path / "legacy_migration.db"
    monkeypatch.setenv("LN_STUDIO_DB_PATH", str(db_file))
    init_db(db_file)

    legacy_name = ("Ai" + "ko") + "-style Nhật tự do"
    with db_session(db_file) as conn:
        conn.execute("DELETE FROM prompt_presets WHERE name = 'Nhật Tự Do (Freeform)'")
        conn.execute(
            """
            INSERT INTO prompt_presets (name, source_lang, mode, content)
            VALUES (?, 'ja', 'freeform', 'old content')
            """,
            (legacy_name,),
        )

    # Re-running init_db must rename the legacy preset to "Nhật Tự Do (Freeform)"
    init_db(db_file)
    with db_session(db_file) as conn:
        rows = conn.execute("SELECT name, content FROM prompt_presets").fetchall()
        names = [r["name"] for r in rows]
        assert "Nhật Tự Do (Freeform)" in names
        assert legacy_name not in names


def test_flexible_volume_labels_optional_title(client: TestClient) -> None:
    s_resp = client.post(
        "/api/series",
        json={"title": "Truyện Trung Dài Kỳ", "source_lang": "zh", "translation_mode": "freeform"},
    )
    assert s_resp.status_code == 201
    series_id = s_resp.json()["id"]

    # 1. Empty title defaults cleanly to "Tập 1"
    v1 = client.post(
        f"/api/series/{series_id}/volumes",
        json={"volume_number": 1, "title": ""},
    )
    assert v1.status_code == 201
    assert v1.json()["title"] == "Tập 1"

    # 2. Freeform label without forced prefix
    v2 = client.post(
        f"/api/series/{series_id}/volumes",
        json={"volume_number": 2, "title": "Chương 1-200"},
    )
    assert v2.status_code == 201
    assert v2.json()["title"] == "Chương 1-200"

    # 3. Updating title to empty string falls back to "Tập {volume_number}"
    v2_id = v2.json()["id"]
    upd = client.put(f"/api/volumes/{v2_id}", json={"title": "   "})
    assert upd.status_code == 200
    assert upd.json()["title"] == "Tập 2"

    # 4. Updating title to another freeform label
    upd2 = client.put(f"/api/volumes/{v2_id}", json={"title": "Full Truyện"})
    assert upd2.status_code == 200
    assert upd2.json()["title"] == "Full Truyện"


def test_chapter_manager_crud_split_merge_and_reindex(client: TestClient) -> None:
    s_id = client.post(
        "/api/series",
        json={"title": "Kho Chương Test", "source_lang": "ja", "translation_mode": "ln_vn"},
    ).json()["id"]
    v_id = client.post(
        f"/api/series/{s_id}/volumes",
        json={"volume_number": 1, "title": "Quyển 1"},
    ).json()["id"]

    # 1. Paste-add 2 chapters
    c1 = client.post(
        f"/api/volumes/{v_id}/chapters",
        json={"title": "Mở đầu", "raw_text": "Đoạn A của chương 1.\n\nĐoạn B của chương 1."},
    )
    assert c1.status_code == 201
    c1_data = c1.json()
    assert c1_data["chapter_index"] == 1
    assert c1_data["raw_chars"] > 0

    c2 = client.post(
        f"/api/volumes/{v_id}/chapters",
        json={"title": "Hành trình", "raw_text": "Nội dung chương 2."},
    )
    assert c2.status_code == 201
    c2_data = c2.json()
    assert c2_data["chapter_index"] == 2

    # 2. Rename chapter 1 via PATCH
    ren = client.patch(
        f"/api/chapters/{c1_data['id']}",
        json={"title": "Chương 1: Khởi hành"},
    )
    assert ren.status_code == 200
    assert ren.json()["title"] == "Chương 1: Khởi hành"

    # 3. Split chapter 1 at cursor offset -> should now have 3 chapters [1, 2, 3]
    raw_c1 = client.get(f"/api/chapters/{c1_data['id']}").json()["raw_text"]
    split_pos = raw_c1.index("Đoạn B")
    sp = client.post(
        f"/api/chapters/{c1_data['id']}/split",
        json={"split_offset": split_pos, "second_title": "Chương 1.5: Nửa sau"},
    )
    assert sp.status_code == 200
    sp_data = sp.json()
    assert sp_data["first_chapter_index"] == 1
    assert sp_data["second_chapter_index"] == 2
    assert sp_data["total_chapters"] == 3

    listed = client.get(f"/api/volumes/{v_id}/chapters").json()
    assert [c["chapter_index"] for c in listed] == [1, 2, 3]
    assert listed[1]["title"] == "Chương 1.5: Nửa sau"
    assert listed[2]["title"] == "Hành trình"

    # Verify raw content of the two split halves
    ch1_detail = client.get(f"/api/chapters/{listed[0]['id']}").json()
    ch2_detail = client.get(f"/api/chapters/{listed[1]['id']}").json()
    assert "Đoạn A" in ch1_detail["raw_text"]
    assert "Đoạn B" not in ch1_detail["raw_text"]
    assert "Đoạn B" in ch2_detail["raw_text"]

    # 4. Merge chapter 1 with chapter 2 -> back to 2 chapters [1, 2]
    mg = client.post(f"/api/chapters/{listed[0]['id']}/merge-next")
    assert mg.status_code == 200
    mg_data = mg.json()
    assert mg_data["deleted_chapter_id"] == listed[1]["id"]
    assert mg_data["total_chapters"] == 2

    merged_detail = client.get(f"/api/chapters/{listed[0]['id']}").json()
    assert "Đoạn A" in merged_detail["raw_text"]
    assert "Đoạn B" in merged_detail["raw_text"]

    listed_after_merge = client.get(f"/api/volumes/{v_id}/chapters").json()
    assert [c["chapter_index"] for c in listed_after_merge] == [1, 2]
    assert listed_after_merge[1]["title"] == "Hành trình"

    # 5. Delete chapter 1 individually -> chapter 2 re-indexes cleanly to 1
    del_resp = client.delete(f"/api/chapters/{listed_after_merge[0]['id']}")
    assert del_resp.status_code == 200
    assert del_resp.json()["remaining_chapters"] == 1

    final_list = client.get(f"/api/volumes/{v_id}/chapters").json()
    assert len(final_list) == 1
    assert final_list[0]["chapter_index"] == 1
    assert final_list[0]["title"] == "Hành trình"
