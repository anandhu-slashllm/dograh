"""Live supervisor routes: steer an in-progress call and stream its events.

Notes are stored per workflow run and applied by the process running the call
(see ``api.services.supervisor``). All routes are scoped to the caller's
selected organization.
"""

import json
from contextlib import aclosing
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.db import db_client
from api.db.models import UserModel
from api.services.auth.depends import get_user
from api.services.supervisor import store
from api.services.supervisor.live_events import CALL_ENDED_EVENT_TYPE, stream_events

router = APIRouter(prefix="/workflow-runs/{run_id}/supervisor", tags=["supervisor"])


class SupervisorNote(BaseModel):
    id: str
    text: str
    created_by: Optional[int] = None
    created_at: str


class SupervisorNotesResponse(BaseModel):
    run_id: int
    is_completed: bool
    notes: list[SupervisorNote]
    max_notes: int = store.MAX_ACTIVE_NOTES
    max_note_length: int = store.MAX_NOTE_LENGTH


class CreateSupervisorNoteRequest(BaseModel):
    text: str = Field(min_length=1, max_length=store.MAX_NOTE_LENGTH)
    respond_now: bool = False


async def _get_run_for_user(run_id: int, user: UserModel):
    # get_workflow_run skips the organization filter when it is None, so an
    # unscoped user must never reach it.
    if not user.selected_organization_id:
        raise HTTPException(status_code=403, detail="No organization selected")
    run = await db_client.get_workflow_run(
        run_id, organization_id=user.selected_organization_id
    )
    if not run:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    return run


@router.get("/notes")
async def get_supervisor_notes(
    run_id: int, user: UserModel = Depends(get_user)
) -> SupervisorNotesResponse:
    run = await _get_run_for_user(run_id, user)
    notes = await store.list_notes(run_id)
    return SupervisorNotesResponse(
        run_id=run_id, is_completed=bool(run.is_completed), notes=notes
    )


@router.post("/notes")
async def create_supervisor_note(
    run_id: int,
    request: CreateSupervisorNoteRequest,
    user: UserModel = Depends(get_user),
) -> SupervisorNotesResponse:
    run = await _get_run_for_user(run_id, user)
    if run.is_completed:
        raise HTTPException(status_code=409, detail="This call has already ended")
    try:
        note = await store.add_note(run_id, request.text, created_by=user.id)
    except store.SupervisorNoteError as e:
        raise HTTPException(status_code=422, detail=str(e))
    await store.publish_change(
        run_id, store.CHANGE_ADDED, respond_now=request.respond_now, note=note
    )
    notes = await store.list_notes(run_id)
    return SupervisorNotesResponse(run_id=run_id, is_completed=False, notes=notes)


@router.delete("/notes")
async def clear_supervisor_notes(
    run_id: int, user: UserModel = Depends(get_user)
) -> SupervisorNotesResponse:
    run = await _get_run_for_user(run_id, user)
    await store.clear_notes(run_id)
    if not run.is_completed:
        await store.publish_change(run_id, store.CHANGE_CLEARED)
    return SupervisorNotesResponse(
        run_id=run_id, is_completed=bool(run.is_completed), notes=[]
    )


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"


@router.get("/events")
async def stream_supervisor_events(
    run_id: int, user: UserModel = Depends(get_user)
) -> StreamingResponse:
    """Server-sent events: the run's realtime feedback events, backlog first.

    Ends with a ``supervisor-call-ended`` event once the call is over.
    """
    run = await _get_run_for_user(run_id, user)
    is_completed = bool(run.is_completed)

    async def event_stream():
        # A finished call may still have its backlog in Redis; replay it and
        # make sure the stream always terminates with the call-ended marker.
        ended = False
        events = stream_events(run_id, heartbeat_seconds=0.5 if is_completed else 15.0)
        async with aclosing(events):
            async for event in events:
                if event is None:
                    if is_completed:
                        break
                    yield ": ping\n\n"
                    continue
                ended = event.get("type") == CALL_ENDED_EVENT_TYPE
                yield _sse(event)
        if not ended:
            yield _sse({"type": CALL_ENDED_EVENT_TYPE, "payload": {}})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
