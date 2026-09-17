import { describe, expect, it } from "vitest";

import {
    applyRealtimeFeedbackEvent,
    createLiveFeedbackState,
    type LiveFeedbackEvent,
    type LiveFeedbackState,
} from "./applyRealtimeFeedbackEvent";
import { conversationItemsFromLiveFeedback, conversationItemsFromRealtimeFeedbackEvents } from "./fromRealtimeFeedback";

function replay(events: LiveFeedbackEvent[], state: LiveFeedbackState = createLiveFeedbackState()) {
    return events.reduce((current, event) => applyRealtimeFeedbackEvent(current, event).state, state);
}

function summary(state: LiveFeedbackState) {
    return state.messages.map((m) => `${m.type}:${m.text}:${m.final ?? ""}`);
}

describe("applyRealtimeFeedbackEvent", () => {
    it("replaces interim transcriptions and finalizes the bot message the user interrupts", () => {
        const state = replay([
            { type: "rtf-bot-text", payload: { text: "Hello" } },
            { type: "rtf-bot-text", payload: { text: "there" } },
            { type: "rtf-user-transcription", payload: { text: "I wa", final: false } },
            { type: "rtf-user-transcription", payload: { text: "I want", final: false } },
            { type: "rtf-user-transcription", payload: { text: "I want a slot", final: true } },
        ]);

        expect(summary(state)).toEqual([
            "bot-text:Hello there:true",
            "user-transcription:I want a slot:true",
        ]);
    });

    it("starts a new bot message after the bot stops speaking", () => {
        const state = replay([
            { type: "rtf-bot-text", payload: { text: "One" } },
            { type: "rtf-bot-stopped-speaking", payload: {} },
            { type: "rtf-bot-text", payload: { text: "Two" } },
        ]);

        expect(summary(state)).toEqual(["bot-text:One:true", "bot-text:Two:false"]);
        expect(state.firstBotSpeechCompleted).toBe(true);
    });

    it("tracks tool calls by id and ignores duplicate starts", () => {
        const state = replay([
            { type: "rtf-function-call-start", payload: { function_name: "check_availability", tool_call_id: "t1" } },
            { type: "rtf-function-call-start", payload: { function_name: "check_availability", tool_call_id: "t1" } },
            { type: "rtf-function-call-end", payload: { tool_call_id: "t1", result: "3 slots" } },
        ]);

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toMatchObject({ id: "func-t1", status: "completed", result: "3 slots" });
    });

    it("reports node transitions to the caller", () => {
        const update = applyRealtimeFeedbackEvent(createLiveFeedbackState(), {
            type: "rtf-node-transition",
            payload: { node_id: "2", node_name: "Main", previous_node_name: "Start", allow_interrupt: false },
        });

        expect(update.nodeTransition).toMatchObject({ kind: "node-transition", nodeName: "Main", previousNodeName: "Start" });
        expect(update.state.currentAllowInterrupt).toBe(false);
    });

    it("warns once when the user talks over a no-interrupt node", () => {
        const state = replay([
            { type: "rtf-node-transition", payload: { node_name: "Main", allow_interrupt: false } },
            { type: "rtf-bot-stopped-speaking", payload: {} },
            { type: "rtf-user-mute-started", payload: {} },
            { type: "rtf-user-transcription", payload: { text: "hello", final: true } },
            { type: "rtf-user-transcription", payload: { text: "hello?", final: true } },
        ]);

        expect(state.messages.filter((m) => m.type === "interrupt-warning")).toHaveLength(1);
    });

    it("does not warn during the first bot greeting", () => {
        const state = replay([
            { type: "rtf-node-transition", payload: { node_name: "Start", allow_interrupt: false } },
            { type: "rtf-user-mute-started", payload: {} },
            { type: "rtf-user-transcription", payload: { text: "hello", final: true } },
        ]);

        expect(state.messages.some((m) => m.type === "interrupt-warning")).toBe(false);
    });

    it("records supervisor notes and reports unknown events as unhandled", () => {
        const noteUpdate = applyRealtimeFeedbackEvent(createLiveFeedbackState(), {
            type: "rtf-supervisor-note",
            payload: { change: "added", text: "Offer a discount", respond_now: true, responded: false, deferred_reason: "busy" },
        });
        expect(noteUpdate.state.messages[0]).toMatchObject({
            type: "supervisor-note",
            text: "Offer a discount",
            supervisorResponded: false,
            supervisorDeferredReason: "busy",
        });

        const unknown = applyRealtimeFeedbackEvent(noteUpdate.state, { type: "something-else" });
        expect(unknown.handled).toBe(false);
        expect(unknown.state).toBe(noteUpdate.state);
    });
});

describe("supervisor notes in the transcript", () => {
    it("renders live notes as supervisor notices", () => {
        const state = replay([
            { type: "rtf-supervisor-note", payload: { change: "added", text: "Offer a discount", respond_now: true, responded: true } },
            { type: "rtf-supervisor-note", payload: { change: "cleared" } },
        ]);

        const items = conversationItemsFromLiveFeedback(state.messages);

        expect(items).toMatchObject([
            { kind: "notice", tone: "supervisor", title: "Supervisor note · agent responding now", text: "Offer a discount" },
            { kind: "notice", tone: "supervisor", title: "Supervisor cleared all notes" },
        ]);
    });

    it("renders saved notes in the historical transcript", () => {
        const items = conversationItemsFromRealtimeFeedbackEvents([
            {
                type: "rtf-supervisor-note",
                payload: { change: "added", text: "Keep it short", respond_now: true, responded: false, deferred_reason: "unsupported" },
                timestamp: "2026-09-17T10:00:00Z",
                turn: 2,
            },
        ]);

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: "notice", tone: "supervisor", text: "Keep it short" });
        expect((items[0] as { title: string }).title).toContain("next reply");
    });
});
