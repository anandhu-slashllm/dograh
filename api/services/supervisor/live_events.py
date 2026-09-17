"""Mirror a run's realtime feedback events to Redis for the live monitor.

Browser test calls already stream these events over their signaling
WebSocket. Telephony calls have no such socket, so the supervisor console
reads the same events from Redis instead: a capped backlog list (so a console
opened mid-call sees what already happened) plus a pub/sub channel for new
events. Every event is wrapped in an envelope carrying a per-run sequence
number, which lets a subscriber drop events it received both from the backlog
and from the channel.
"""

import asyncio
import json
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from loguru import logger

from api.services.supervisor.redis_client import create_pubsub_connection, get_redis

BACKLOG_MAX_EVENTS = 2000
BACKLOG_TTL_SECONDS = 24 * 60 * 60
QUEUE_MAX_EVENTS = 2000
CLOSE_FLUSH_TIMEOUT_SECONDS = 2.0

CALL_ENDED_EVENT_TYPE = "supervisor-call-ended"

# High-volume signals that only matter to a viewer watching at that moment.
# They are published live but kept out of the backlog so a console opened
# mid-call replays the conversation rather than a stream of partials.
_LIVE_ONLY_EVENT_TYPES = frozenset(
    {
        "rtf-user-mute-started",
        "rtf-user-mute-stopped",
        "rtf-latency-measured",
        "rtf-bot-started-speaking",
    }
)


def _is_live_only(event: dict[str, Any]) -> bool:
    event_type = event.get("type")
    if event_type in _LIVE_ONLY_EVENT_TYPES:
        return True
    return (
        event_type == "rtf-user-transcription"
        and (event.get("payload") or {}).get("final") is False
    )


def backlog_key(run_id: int) -> str:
    return f"live:events:{run_id}"


def events_channel(run_id: int) -> str:
    return f"live:{run_id}"


class LiveEventPublisher:
    """Publishes a run's events to Redis in order, without blocking the caller.

    ``publish`` only enqueues. A single background task drains the queue so
    the audio pipeline never waits on Redis and events keep their order.
    """

    def __init__(self, run_id: int):
        self._run_id = run_id
        self._seq = 0
        self._queue: asyncio.Queue[Optional[dict[str, Any]]] = asyncio.Queue(
            maxsize=QUEUE_MAX_EVENTS
        )
        self._task: asyncio.Task | None = None
        self._dropped = 0

    def publish(self, event: dict[str, Any]) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._drain(), name=f"live-events:{self._run_id}"
            )
        self._seq += 1
        try:
            self._queue.put_nowait({"seq": self._seq, "event": event})
        except asyncio.QueueFull:
            self._dropped += 1
            if self._dropped == 1 or self._dropped % 100 == 0:
                logger.warning(
                    f"Live event queue full for run {self._run_id}; "
                    f"dropped {self._dropped} events"
                )

    async def close(self) -> None:
        """Publish the call-ended marker and flush what is still queued."""
        self.publish({"type": CALL_ENDED_EVENT_TYPE, "payload": {}})
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        if self._task is None:
            return
        try:
            await asyncio.wait_for(self._task, timeout=CLOSE_FLUSH_TIMEOUT_SECONDS)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._task.cancel()
        except Exception as e:
            logger.debug(f"Live event publisher for run {self._run_id} failed: {e}")

    async def _drain(self) -> None:
        key = backlog_key(self._run_id)
        channel = events_channel(self._run_id)
        while True:
            envelope = await self._queue.get()
            if envelope is None:
                return
            try:
                data = json.dumps(envelope, default=str)
                redis = await get_redis()
                async with redis.pipeline(transaction=False) as pipe:
                    if not _is_live_only(envelope["event"]):
                        pipe.rpush(key, data)
                        pipe.ltrim(key, -BACKLOG_MAX_EVENTS, -1)
                        pipe.expire(key, BACKLOG_TTL_SECONDS)
                    pipe.publish(channel, data)
                    await pipe.execute()
            except Exception as e:
                logger.debug(
                    f"Failed to publish live event for run {self._run_id}: {e}"
                )


def mirror_ws_sender(
    ws_sender: Optional[Callable[[dict], Awaitable[None]]],
    publisher: LiveEventPublisher,
) -> Callable[[dict], Awaitable[None]]:
    """Wrap a run's WebSocket sender so every event also reaches Redis.

    The returned sender is always callable, so events for telephony calls
    (which have no WebSocket) are still mirrored.
    """

    async def send(message: dict) -> None:
        publisher.publish(message)
        if ws_sender:
            await ws_sender(message)

    return send


def _parse_envelope(raw: Any) -> Optional[dict[str, Any]]:
    try:
        envelope = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(envelope, dict) or "event" not in envelope:
        return None
    return envelope


async def stream_events(
    run_id: int, *, heartbeat_seconds: float = 15.0
) -> AsyncIterator[Optional[dict[str, Any]]]:
    """Yield a run's events: the backlog first, then new events as they arrive.

    Yields ``None`` as a heartbeat when nothing arrived for
    ``heartbeat_seconds``. Stops after the call-ended marker.
    """
    connection = create_pubsub_connection()
    pubsub = connection.pubsub()
    channel = events_channel(run_id)
    try:
        # Subscribe before reading the backlog so nothing published in between
        # is missed; the sequence number removes the resulting duplicates.
        await pubsub.subscribe(channel)

        last_seq = 0
        redis = await get_redis()
        for raw in await redis.lrange(backlog_key(run_id), 0, -1):
            envelope = _parse_envelope(raw)
            if envelope is None:
                continue
            last_seq = max(last_seq, int(envelope.get("seq", 0)))
            yield envelope["event"]
            if envelope["event"].get("type") == CALL_ENDED_EVENT_TYPE:
                return

        while True:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=heartbeat_seconds
            )
            if message is None:
                yield None
                continue
            envelope = _parse_envelope(message.get("data"))
            if envelope is None:
                continue
            seq = int(envelope.get("seq", 0))
            if seq and seq <= last_seq:
                continue
            last_seq = max(last_seq, seq)
            yield envelope["event"]
            if envelope["event"].get("type") == CALL_ENDED_EVENT_TYPE:
                return
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
            await connection.aclose()
        except Exception as e:
            logger.debug(f"Failed to close live event subscription for {run_id}: {e}")
