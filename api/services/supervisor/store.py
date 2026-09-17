"""Redis-backed storage for the supervisor notes of a workflow run."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from api.services.supervisor.redis_client import get_redis

MAX_NOTE_LENGTH = 1000
MAX_ACTIVE_NOTES = 20
NOTES_TTL_SECONDS = 24 * 60 * 60

CHANGE_ADDED = "added"
CHANGE_CLEARED = "cleared"


class SupervisorNoteError(ValueError):
    """A note was rejected (empty, too long, or too many active notes)."""


def notes_key(run_id: int) -> str:
    return f"supervisor:notes:{run_id}"


def control_channel(run_id: int) -> str:
    return f"supervisor:ctl:{run_id}"


def build_note(text: str, created_by: int | None) -> dict[str, Any]:
    """Validate note text and return the stored note record."""
    text = (text or "").strip()
    if not text:
        raise SupervisorNoteError("Note text is empty")
    if len(text) > MAX_NOTE_LENGTH:
        raise SupervisorNoteError(
            f"Note is longer than {MAX_NOTE_LENGTH} characters"
        )
    return {
        "id": uuid.uuid4().hex,
        "text": text,
        "created_by": created_by,
        "created_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
    }


async def list_notes(run_id: int) -> list[dict[str, Any]]:
    redis = await get_redis()
    raw_notes = await redis.lrange(notes_key(run_id), 0, -1)
    notes = []
    for raw in raw_notes:
        try:
            notes.append(json.loads(raw))
        except (TypeError, ValueError):
            continue
    return notes


async def add_note(
    run_id: int, text: str, created_by: int | None = None
) -> dict[str, Any]:
    note = build_note(text, created_by)
    redis = await get_redis()
    key = notes_key(run_id)
    if await redis.llen(key) >= MAX_ACTIVE_NOTES:
        raise SupervisorNoteError(
            f"A call can have at most {MAX_ACTIVE_NOTES} active notes; clear some first"
        )
    async with redis.pipeline(transaction=True) as pipe:
        pipe.rpush(key, json.dumps(note))
        pipe.expire(key, NOTES_TTL_SECONDS)
        await pipe.execute()
    return note


async def clear_notes(run_id: int) -> None:
    redis = await get_redis()
    await redis.delete(notes_key(run_id))


async def publish_change(
    run_id: int,
    change: str,
    *,
    respond_now: bool = False,
    note: dict[str, Any] | None = None,
) -> None:
    """Tell the process running this call that its notes changed.

    The message is only a signal: the subscriber re-reads the full note list,
    so a lost or duplicated message cannot leave the call with stale notes.
    """
    redis = await get_redis()
    message = {
        "change": change,
        "respond_now": respond_now,
        "note": note,
    }
    await redis.publish(control_channel(run_id), json.dumps(message))
