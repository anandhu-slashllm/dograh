"""Supervisor notes are appended to the node's system prompt."""

from types import SimpleNamespace

from api.services.workflow.pipecat_engine_context_composer import (
    SUPERVISOR_INSTRUCTIONS_HEADER,
    compose_supervisor_instructions,
    compose_system_prompt_for_node,
)


def _compose(notes=(), *, global_prompt=None):
    node = SimpleNamespace(prompt="Node prompt", add_global_prompt=bool(global_prompt))
    workflow = SimpleNamespace(global_node_id=None, nodes={})
    if global_prompt:
        workflow.global_node_id = "g"
        workflow.nodes["g"] = SimpleNamespace(prompt=global_prompt)
    return compose_system_prompt_for_node(
        node=node,
        workflow=workflow,
        format_prompt=lambda prompt: prompt,
        has_recordings=False,
        supervisor_notes=notes,
    )


def test_prompt_is_unchanged_without_notes():
    assert _compose() == "Node prompt"


def test_notes_follow_the_global_and_node_prompts():
    prompt = _compose(
        [{"text": "Offer the 4:30 slot"}, {"text": "Keep it short"}],
        global_prompt="Global prompt",
    )

    assert prompt.startswith("Global prompt\n\nNode prompt\n\n")
    assert prompt.endswith(
        SUPERVISOR_INSTRUCTIONS_HEADER + "\n- Offer the 4:30 slot\n- Keep it short"
    )


def test_blank_notes_are_skipped():
    assert compose_supervisor_instructions([{"text": "  "}, {}]) == ""


def test_note_text_is_not_rendered_as_a_template():
    # Notes are supervisor-authored; braces must reach the model verbatim.
    prompt = _compose([{"text": "Say {{business_name}} literally"}])

    assert "- Say {{business_name}} literally" in prompt
