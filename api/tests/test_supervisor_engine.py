"""The engine applies supervisor notes to the running call."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    LLMContextFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext

from api.services.workflow.pipecat_engine import (
    SUPERVISOR_NOTE_EVENT_TYPE,
    PipecatEngine,
)
from api.services.workflow.pipecat_engine_context_composer import (
    SUPERVISOR_INSTRUCTIONS_HEADER,
)

NOTE = {"id": "n1", "text": "Offer a discount", "created_at": "now"}


def _engine() -> tuple[PipecatEngine, AsyncMock, AsyncMock]:
    llm = AsyncMock()
    engine = PipecatEngine(
        llm=llm,
        context=LLMContext(),
        workflow=SimpleNamespace(global_node_id=None, nodes={}),
        call_context_vars={},
    )
    engine._current_node = SimpleNamespace(
        name="Main", prompt="Node prompt", add_global_prompt=False, allow_interrupt=True
    )
    events = AsyncMock()
    engine.set_supervisor_event_callback(events)
    return engine, llm, events


def _system_instruction(llm: AsyncMock) -> str:
    settings = llm._update_settings.await_args.args[0]
    return settings.system_instruction


@pytest.mark.asyncio
async def test_notes_update_only_the_system_instruction():
    engine, llm, _ = _engine()

    await engine.set_supervisor_notes([NOTE], change="added", note=NOTE)

    instruction = _system_instruction(llm)
    assert instruction.startswith("Node prompt\n\n" + SUPERVISOR_INSTRUCTIONS_HEADER)
    assert instruction.endswith("- Offer a discount")
    llm.queue_frame.assert_not_awaited()


@pytest.mark.asyncio
async def test_notes_persist_into_later_node_prompts():
    engine, _, _ = _engine()
    await engine.set_supervisor_notes([NOTE])

    next_node = SimpleNamespace(prompt="Next node", add_global_prompt=False)

    assert engine._compose_system_prompt(next_node).endswith("- Offer a discount")


@pytest.mark.asyncio
async def test_clearing_notes_restores_the_node_prompt():
    engine, llm, events = _engine()
    await engine.set_supervisor_notes([NOTE], change="added", note=NOTE)

    await engine.set_supervisor_notes([], change="cleared")

    assert _system_instruction(llm) == "Node prompt"
    payload = events.await_args.args[0]["payload"]
    assert payload["change"] == "cleared"
    assert payload["active_notes"] == 0


@pytest.mark.asyncio
async def test_respond_now_generates_when_the_call_is_idle():
    engine, llm, events = _engine()

    await engine.set_supervisor_notes(
        [NOTE], change="added", note=NOTE, respond_now=True
    )

    frame = llm.queue_frame.await_args.args[0]
    assert isinstance(frame, LLMContextFrame)
    event = events.await_args.args[0]
    assert event["type"] == SUPERVISOR_NOTE_EVENT_TYPE
    assert event["payload"]["responded"] is True
    assert event["payload"]["text"] == "Offer a discount"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "busy_frame", [BotStartedSpeakingFrame(), VADUserStartedSpeakingFrame()]
)
async def test_respond_now_is_deferred_while_someone_is_speaking(busy_frame):
    engine, llm, events = _engine()
    await engine.should_mute_user(busy_frame)

    await engine.set_supervisor_notes(
        [NOTE], change="added", note=NOTE, respond_now=True
    )

    llm.queue_frame.assert_not_awaited()
    payload = events.await_args.args[0]["payload"]
    assert payload["responded"] is False
    assert payload["deferred_reason"] == "busy"


@pytest.mark.asyncio
async def test_respond_now_resumes_once_speech_stops():
    engine, llm, _ = _engine()
    await engine.should_mute_user(BotStartedSpeakingFrame())
    await engine.should_mute_user(BotStoppedSpeakingFrame())
    await engine.should_mute_user(VADUserStartedSpeakingFrame())
    await engine.should_mute_user(VADUserStoppedSpeakingFrame())

    await engine.set_supervisor_notes([NOTE], respond_now=True)

    llm.queue_frame.assert_awaited_once()


@pytest.mark.asyncio
async def test_respond_now_is_deferred_for_speech_to_speech_services():
    engine, llm, events = _engine()
    engine.set_supervisor_respond_now_supported(False)

    await engine.set_supervisor_notes(
        [NOTE], change="added", note=NOTE, respond_now=True
    )

    llm.queue_frame.assert_not_awaited()
    assert events.await_args.args[0]["payload"]["deferred_reason"] == "unsupported"


@pytest.mark.asyncio
async def test_initial_sync_without_a_change_records_no_event():
    engine, _, events = _engine()

    await engine.set_supervisor_notes([NOTE])

    events.assert_not_awaited()


@pytest.mark.asyncio
async def test_notes_before_the_first_node_are_kept_for_it():
    engine, llm, _ = _engine()
    engine._current_node = None

    await engine.set_supervisor_notes([NOTE])

    llm._update_settings.assert_not_awaited()
    start = SimpleNamespace(prompt="Start", add_global_prompt=False)
    assert engine._compose_system_prompt(start).endswith("- Offer a discount")
