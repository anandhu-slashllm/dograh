import type {
    ConversationNodeTransitionItem,
    RealtimeFeedbackMessage,
} from "../types";

/**
 * Live transcript state built from `rtf-*` realtime feedback events.
 *
 * Shared by the browser voice tester (events over its signaling WebSocket) and
 * the live call monitor (events over server-sent events), so both render a
 * call the same way.
 */
export interface LiveFeedbackState {
    messages: RealtimeFeedbackMessage[];
    userMuted: boolean;
    firstBotSpeechCompleted: boolean;
    currentAllowInterrupt?: boolean;
    interruptWarningShown: boolean;
}

export interface LiveFeedbackEvent {
    type: string;
    // Event payloads are loosely typed JSON from the backend.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any;
}

export interface LiveFeedbackUpdate {
    state: LiveFeedbackState;
    handled: boolean;
    nodeTransition?: ConversationNodeTransitionItem;
}

export const SUPERVISOR_NOTE_EVENT_TYPE = "rtf-supervisor-note";

export function createLiveFeedbackState(): LiveFeedbackState {
    return {
        messages: [],
        userMuted: false,
        firstBotSpeechCompleted: false,
        currentAllowInterrupt: undefined,
        interruptWarningShown: false,
    };
}

let idCounter = 0;

function nextId(prefix: string) {
    idCounter += 1;
    return `${prefix}-${Date.now()}-${idCounter}`;
}

function nowIso() {
    return new Date().toISOString();
}

export function applyRealtimeFeedbackEvent(
    state: LiveFeedbackState,
    event: LiveFeedbackEvent,
): LiveFeedbackUpdate {
    const payload = event.payload ?? {};

    switch (event.type) {
        case "rtf-user-transcription": {
            let messages = state.messages;
            let interruptWarningShown = state.interruptWarningShown;

            // Show one-time warning if user speaks while muted on a no-interrupt node
            // Skip during initial bot greeting (muted by MuteUntilFirstBotComplete strategy)
            if (
                !interruptWarningShown &&
                state.firstBotSpeechCompleted &&
                state.userMuted &&
                state.currentAllowInterrupt === false
            ) {
                interruptWarningShown = true;
                messages = [...messages, {
                    id: nextId("interrupt-warning"),
                    type: "interrupt-warning",
                    text: "Interruption is disabled for this step. The bot will finish speaking before processing your input. You can enable interruption in the workflow editor.",
                    timestamp: nowIso(),
                }];
            }

            // Finalize the last bot message (user started speaking)
            const lastIndex = messages.length - 1;
            messages = messages.map((msg, idx) =>
                idx === lastIndex && msg.type === "bot-text" && !msg.final
                    ? { ...msg, final: true }
                    : msg
            );

            // Replace any previous interim transcription with the new one
            messages = messages.filter(
                (msg) => !(msg.type === "user-transcription" && !msg.final)
            );
            messages = [...messages, {
                id: nextId("user"),
                type: "user-transcription",
                text: payload.text,
                final: payload.final,
                timestamp: nowIso(),
            }];

            return { state: { ...state, messages, interruptWarningShown }, handled: true };
        }

        case "rtf-bot-text": {
            // TTS text comes as sentences/phrases, concatenate with space
            const last = state.messages[state.messages.length - 1];
            if (last && last.type === "bot-text" && !last.final) {
                return {
                    state: {
                        ...state,
                        messages: [
                            ...state.messages.slice(0, -1),
                            { ...last, text: last.text + " " + payload.text },
                        ],
                    },
                    handled: true,
                };
            }
            return {
                state: {
                    ...state,
                    messages: [...state.messages, {
                        id: nextId("bot"),
                        type: "bot-text",
                        text: payload.text,
                        final: false,
                        timestamp: nowIso(),
                    }],
                },
                handled: true,
            };
        }

        case "rtf-function-call-start": {
            const { function_name, tool_call_id, arguments: toolArguments } = payload;
            const existingId = tool_call_id ? `func-${tool_call_id}` : nextId("func");
            if (state.messages.some((msg) => msg.id === existingId)) {
                return { state, handled: true };
            }
            return {
                state: {
                    ...state,
                    messages: [...state.messages, {
                        id: existingId,
                        type: "function-call",
                        text: function_name ?? "tool",
                        functionName: function_name ?? "tool",
                        toolCallId: tool_call_id,
                        arguments: toolArguments,
                        status: "running",
                        timestamp: nowIso(),
                    }],
                },
                handled: true,
            };
        }

        case "rtf-function-call-end": {
            const { tool_call_id, result } = payload;
            return {
                state: {
                    ...state,
                    messages: state.messages.map((msg) =>
                        msg.id === `func-${tool_call_id}`
                            ? { ...msg, status: "completed" as const, text: result || msg.text, result }
                            : msg
                    ),
                },
                handled: true,
            };
        }

        case "rtf-node-transition": {
            const {
                node_id,
                node_name,
                previous_node_id,
                previous_node_name,
                allow_interrupt,
            } = payload;
            const timestamp = nowIso();
            const transition: ConversationNodeTransitionItem = {
                kind: "node-transition",
                id: nextId("node"),
                timestamp,
                nodeId: node_id,
                nodeName: node_name ?? "Node",
                previousNodeId: previous_node_id,
                previousNodeName: previous_node_name,
                allowInterrupt: allow_interrupt,
            };
            return {
                state: {
                    ...state,
                    currentAllowInterrupt: allow_interrupt,
                    messages: [...state.messages, {
                        id: transition.id,
                        type: "node-transition",
                        text: transition.nodeName,
                        nodeId: transition.nodeId,
                        nodeName: transition.nodeName,
                        previousNodeId: transition.previousNodeId,
                        previousNode: previous_node_name,
                        allowInterrupt: allow_interrupt,
                        timestamp,
                    }],
                },
                handled: true,
                nodeTransition: transition,
            };
        }

        case "rtf-ttfb-metric": {
            const { ttfb_seconds, processor, model } = payload;
            return {
                state: {
                    ...state,
                    messages: [...state.messages, {
                        id: nextId("ttfb"),
                        type: "ttfb-metric",
                        text: `${(ttfb_seconds * 1000).toFixed(0)}ms`,
                        ttfbSeconds: ttfb_seconds,
                        processor,
                        model,
                        timestamp: nowIso(),
                    }],
                },
                handled: true,
            };
        }

        case "rtf-pipeline-error": {
            const { error, fatal, processor } = payload;
            return {
                state: {
                    ...state,
                    messages: [...state.messages, {
                        id: nextId("error"),
                        type: "pipeline-error",
                        text: error,
                        fatal,
                        processor,
                        timestamp: nowIso(),
                    }],
                },
                handled: true,
            };
        }

        case SUPERVISOR_NOTE_EVENT_TYPE: {
            return {
                state: {
                    ...state,
                    messages: [...state.messages, {
                        id: nextId("supervisor"),
                        type: "supervisor-note",
                        text: payload.text ?? "",
                        supervisorChange: payload.change,
                        supervisorResponded: payload.responded,
                        supervisorRespondNow: payload.respond_now,
                        supervisorDeferredReason: payload.deferred_reason,
                        timestamp: nowIso(),
                    }],
                },
                handled: true,
            };
        }

        // Ephemeral state signals — no UI messages
        case "rtf-bot-started-speaking":
        case "rtf-latency-measured":
            return { state, handled: true };

        case "rtf-bot-stopped-speaking": {
            // Finalize the last bot message so "speaking..." indicator is removed
            const lastIndex = state.messages.length - 1;
            const last = state.messages[lastIndex];
            const messages = last && last.type === "bot-text" && !last.final
                ? [...state.messages.slice(0, -1), { ...last, final: true }]
                : state.messages;
            return {
                state: { ...state, messages, firstBotSpeechCompleted: true },
                handled: true,
            };
        }

        case "rtf-user-mute-started":
            return { state: { ...state, userMuted: true }, handled: true };

        case "rtf-user-mute-stopped":
            return { state: { ...state, userMuted: false }, handled: true };

        default:
            return { state, handled: false };
    }
}
