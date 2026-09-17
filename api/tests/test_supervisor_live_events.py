"""Supervisor note storage and the Redis mirror of a run's live events."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from api.services.supervisor import live_events, store
from api.services.supervisor.listener import SupervisorListener


class FakePipeline:
    def __init__(self, redis):
        self._redis = redis
        self._ops = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __getattr__(self, name):
        def record(*args):
            self._ops.append((name, args))

        return record

    async def execute(self):
        for name, args in self._ops:
            await getattr(self._redis, name)(*args)


class FakeRedis:
    """Just enough of redis.asyncio for these tests."""

    def __init__(self):
        self.lists: dict[str, list[str]] = {}
        self.published: list[tuple[str, str]] = []

    def pipeline(self, transaction=True):
        return FakePipeline(self)

    async def rpush(self, key, value):
        self.lists.setdefault(key, []).append(value)

    async def ltrim(self, key, start, end):
        values = self.lists.get(key, [])
        self.lists[key] = values[start:] if end == -1 else values[start : end + 1]

    async def lrange(self, key, start, end):
        return list(self.lists.get(key, []))

    async def llen(self, key):
        return len(self.lists.get(key, []))

    async def expire(self, key, seconds):
        pass

    async def delete(self, key):
        self.lists.pop(key, None)

    async def publish(self, channel, data):
        self.published.append((channel, data))


@pytest.fixture
def redis():
    fake = FakeRedis()
    with (
        patch.object(store, "get_redis", AsyncMock(return_value=fake)),
        patch.object(live_events, "get_redis", AsyncMock(return_value=fake)),
    ):
        yield fake


@pytest.mark.asyncio
async def test_notes_are_added_listed_and_cleared(redis):
    note = await store.add_note(7, "  Offer a discount  ", created_by=3)

    assert note["text"] == "Offer a discount"
    assert await store.list_notes(7) == [note]

    await store.clear_notes(7)
    assert await store.list_notes(7) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["", "   ", "x" * (store.MAX_NOTE_LENGTH + 1)])
async def test_invalid_notes_are_rejected(redis, text):
    with pytest.raises(store.SupervisorNoteError):
        await store.add_note(7, text)


@pytest.mark.asyncio
async def test_active_notes_are_capped(redis):
    for i in range(store.MAX_ACTIVE_NOTES):
        await store.add_note(7, f"note {i}")

    with pytest.raises(store.SupervisorNoteError):
        await store.add_note(7, "one too many")


@pytest.mark.asyncio
async def test_change_signal_carries_the_note(redis):
    await store.publish_change(7, store.CHANGE_ADDED, respond_now=True, note={"id": "a"})

    channel, data = redis.published[0]
    assert channel == store.control_channel(7)
    assert json.loads(data) == {
        "change": "added",
        "respond_now": True,
        "note": {"id": "a"},
    }


@pytest.mark.asyncio
async def test_publisher_keeps_order_and_ends_with_the_call_marker(redis):
    publisher = live_events.LiveEventPublisher(9)
    for i in range(3):
        publisher.publish({"type": "rtf-bot-text", "payload": {"text": str(i)}})

    await publisher.close()

    envelopes = [json.loads(raw) for raw in redis.lists[live_events.backlog_key(9)]]
    assert [e["seq"] for e in envelopes] == [1, 2, 3, 4]
    assert [e["event"]["payload"].get("text") for e in envelopes[:3]] == ["0", "1", "2"]
    assert envelopes[-1]["event"]["type"] == live_events.CALL_ENDED_EVENT_TYPE
    assert all(channel == live_events.events_channel(9) for channel, _ in redis.published)


@pytest.mark.asyncio
async def test_interim_signals_are_published_but_not_replayed(redis):
    publisher = live_events.LiveEventPublisher(9)
    publisher.publish({"type": "rtf-user-transcription", "payload": {"final": False}})
    publisher.publish({"type": "rtf-user-mute-started", "payload": {}})
    publisher.publish({"type": "rtf-user-transcription", "payload": {"final": True}})

    await publisher.close()

    backlog = [json.loads(raw) for raw in redis.lists[live_events.backlog_key(9)]]
    assert [e["seq"] for e in backlog] == [3, 4]
    assert len(redis.published) == 4


@pytest.mark.asyncio
async def test_mirrored_sender_forwards_to_the_websocket_when_present(redis):
    publisher = live_events.LiveEventPublisher(9)
    ws = AsyncMock()

    await live_events.mirror_ws_sender(ws, publisher)({"type": "x"})
    await live_events.mirror_ws_sender(None, publisher)({"type": "y"})
    await publisher.close()

    ws.assert_awaited_once_with({"type": "x"})
    types = [json.loads(r)["event"]["type"] for r in redis.lists[live_events.backlog_key(9)]]
    assert types == ["x", "y", live_events.CALL_ENDED_EVENT_TYPE]


class FakePubSub:
    def __init__(self, messages):
        self._messages = list(messages)
        self.subscribed = []

    async def subscribe(self, *channels):
        self.subscribed.extend(channels)

    async def unsubscribe(self, *channels):
        pass

    async def aclose(self):
        pass

    async def get_message(self, ignore_subscribe_messages=True, timeout=None):
        if self._messages:
            return {"type": "message", "data": self._messages.pop(0)}
        return None


class FakeConnection:
    def __init__(self, pubsub):
        self._pubsub = pubsub

    def pubsub(self):
        return self._pubsub

    async def aclose(self):
        pass


def _envelope(seq, event_type):
    return json.dumps({"seq": seq, "event": {"type": event_type, "payload": {}}})


@pytest.mark.asyncio
async def test_stream_replays_backlog_and_skips_duplicates(redis):
    redis.lists[live_events.backlog_key(4)] = [_envelope(1, "a"), _envelope(2, "b")]
    pubsub = FakePubSub(
        [
            _envelope(2, "b"),  # already in the backlog
            _envelope(3, "c"),
            _envelope(4, live_events.CALL_ENDED_EVENT_TYPE),
        ]
    )

    with patch.object(
        live_events, "create_pubsub_connection", return_value=FakeConnection(pubsub)
    ):
        received = [
            event["type"]
            async for event in live_events.stream_events(4, heartbeat_seconds=0)
            if event is not None
        ]

    assert pubsub.subscribed == [live_events.events_channel(4)]
    assert received == ["a", "b", "c", live_events.CALL_ENDED_EVENT_TYPE]


@pytest.mark.asyncio
async def test_listener_rereads_notes_on_every_signal():
    engine = AsyncMock()
    notes = [{"id": "a", "text": "Offer a discount"}]
    listener = SupervisorListener(engine, 4)

    with patch.object(store, "list_notes", AsyncMock(return_value=notes)):
        await listener._handle(
            json.dumps({"change": "added", "respond_now": True, "note": notes[0]})
        )
        await listener._handle("not json")

    engine.set_supervisor_notes.assert_awaited_once_with(
        notes, change="added", note=notes[0], respond_now=True
    )


@pytest.mark.asyncio
async def test_listener_failures_do_not_escape():
    engine = AsyncMock()
    listener = SupervisorListener(engine, 4)

    with patch(
        "api.services.supervisor.listener.create_pubsub_connection",
        side_effect=ConnectionError("redis down"),
    ):
        await listener.start()
        await listener.stop()

    engine.set_supervisor_notes.assert_not_awaited()
    await asyncio.sleep(0)
