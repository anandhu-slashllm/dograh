"""Supervisor routes are org-scoped and only steer calls that are still live."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.supervisor import router
from api.services.auth.depends import get_user
from api.services.supervisor import store
from api.services.supervisor.live_events import CALL_ENDED_EVENT_TYPE

NOTE = {"id": "n1", "text": "Offer a discount", "created_by": 1, "created_at": "t"}


def _client(org_id=11) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_user] = lambda: SimpleNamespace(
        id=1, selected_organization_id=org_id
    )
    return TestClient(app)


@pytest.fixture
def db():
    with patch("api.routes.supervisor.db_client") as mock_db:
        mock_db.get_workflow_run = AsyncMock(
            return_value=SimpleNamespace(id=5, is_completed=False)
        )
        yield mock_db


@pytest.fixture
def notes_store():
    with (
        patch.object(store, "add_note", AsyncMock(return_value=NOTE)) as add,
        patch.object(store, "list_notes", AsyncMock(return_value=[NOTE])) as list_,
        patch.object(store, "clear_notes", AsyncMock()) as clear,
        patch.object(store, "publish_change", AsyncMock()) as publish,
    ):
        yield SimpleNamespace(add=add, list=list_, clear=clear, publish=publish)


def test_runs_are_looked_up_in_the_users_organization(db, notes_store):
    response = _client().get("/workflow-runs/5/supervisor/notes")

    assert response.status_code == 200
    db.get_workflow_run.assert_awaited_once_with(5, organization_id=11)
    assert response.json()["notes"][0]["text"] == "Offer a discount"


def test_another_organizations_run_is_not_found(db, notes_store):
    db.get_workflow_run.return_value = None

    response = _client().post(
        "/workflow-runs/5/supervisor/notes", json={"text": "hi"}
    )

    assert response.status_code == 404
    notes_store.add.assert_not_awaited()


def test_a_user_without_an_organization_is_rejected(db, notes_store):
    response = _client(org_id=None).get("/workflow-runs/5/supervisor/notes")

    assert response.status_code == 403
    db.get_workflow_run.assert_not_awaited()


def test_posting_a_note_signals_the_call(db, notes_store):
    response = _client().post(
        "/workflow-runs/5/supervisor/notes",
        json={"text": "Offer a discount", "respond_now": True},
    )

    assert response.status_code == 200
    notes_store.add.assert_awaited_once_with(5, "Offer a discount", created_by=1)
    notes_store.publish.assert_awaited_once_with(
        5, store.CHANGE_ADDED, respond_now=True, note=NOTE
    )


def test_a_finished_call_cannot_be_steered(db, notes_store):
    db.get_workflow_run.return_value = SimpleNamespace(id=5, is_completed=True)

    response = _client().post(
        "/workflow-runs/5/supervisor/notes", json={"text": "hi"}
    )

    assert response.status_code == 409
    notes_store.add.assert_not_awaited()


def test_note_length_is_limited(db, notes_store):
    response = _client().post(
        "/workflow-runs/5/supervisor/notes",
        json={"text": "x" * (store.MAX_NOTE_LENGTH + 1)},
    )

    assert response.status_code == 422


def test_store_rejections_are_reported(db, notes_store):
    notes_store.add.side_effect = store.SupervisorNoteError("too many")

    response = _client().post(
        "/workflow-runs/5/supervisor/notes", json={"text": "hi"}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "too many"
    notes_store.publish.assert_not_awaited()


def test_clearing_notes_signals_the_call(db, notes_store):
    response = _client().delete("/workflow-runs/5/supervisor/notes")

    assert response.status_code == 200
    assert response.json()["notes"] == []
    notes_store.clear.assert_awaited_once_with(5)
    notes_store.publish.assert_awaited_once_with(5, store.CHANGE_CLEARED)


def test_event_stream_replays_and_ends(db):
    db.get_workflow_run.return_value = SimpleNamespace(id=5, is_completed=True)

    async def fake_stream(run_id, heartbeat_seconds):
        yield {"type": "rtf-bot-text", "payload": {"text": "Hello"}}
        yield None

    with patch("api.routes.supervisor.stream_events", fake_stream):
        response = _client().get("/workflow-runs/5/supervisor/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert '"rtf-bot-text"' in body
    assert body.rstrip().endswith(
        f'data: {{"type": "{CALL_ENDED_EVENT_TYPE}", "payload": {{}}}}'
    )
