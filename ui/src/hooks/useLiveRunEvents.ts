import { useCallback, useEffect, useRef, useState } from "react";

import type { RealtimeFeedbackMessage } from "@/components/workflow/conversation";
import {
    applyRealtimeFeedbackEvent,
    createLiveFeedbackState,
    type LiveFeedbackEvent,
    SUPERVISOR_NOTE_EVENT_TYPE,
} from "@/components/workflow/conversation/adapters/applyRealtimeFeedbackEvent";
import logger from "@/lib/logger";
import { parseSseChunk, supervisorEventsUrl } from "@/lib/supervisorApi";

export const CALL_ENDED_EVENT_TYPE = "supervisor-call-ended";

const MAX_RECONNECT_DELAY_MS = 10_000;

export type LiveRunStreamStatus = "connecting" | "live" | "reconnecting" | "ended";

interface UseLiveRunEventsOptions {
    runId: number;
    getAccessToken: () => Promise<string>;
    enabled?: boolean;
    onSupervisorNote?: () => void;
}

/**
 * Stream a call's realtime feedback events (transcript, tool calls, node
 * transitions, supervisor notes) from the backend, for any call type.
 *
 * The backend replays the call's backlog on every (re)connect, so the
 * transcript is rebuilt from scratch each time a connection opens.
 */
export function useLiveRunEvents({
    runId,
    getAccessToken,
    enabled = true,
    onSupervisorNote,
}: UseLiveRunEventsOptions) {
    const [messages, setMessages] = useState<RealtimeFeedbackMessage[]>([]);
    const [status, setStatus] = useState<LiveRunStreamStatus>("connecting");
    const getAccessTokenRef = useRef(getAccessToken);
    const onSupervisorNoteRef = useRef(onSupervisorNote);

    useEffect(() => {
        getAccessTokenRef.current = getAccessToken;
        onSupervisorNoteRef.current = onSupervisorNote;
    }, [getAccessToken, onSupervisorNote]);

    const run = useCallback(async (signal: AbortSignal) => {
        let attempt = 0;

        while (!signal.aborted) {
            let state = createLiveFeedbackState();
            let ended = false;

            try {
                const token = await getAccessTokenRef.current();
                const response = await fetch(supervisorEventsUrl(runId), {
                    headers: {
                        Accept: "text/event-stream",
                        Authorization: `Bearer ${token}`,
                    },
                    cache: "no-store",
                    signal,
                });
                if (!response.ok || !response.body) {
                    throw new Error(`Live events request failed (${response.status})`);
                }

                attempt = 0;
                setStatus("live");
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!ended) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const { events, rest } = parseSseChunk(buffer);
                    buffer = rest;

                    let changed = false;
                    for (const raw of events) {
                        const event = raw as LiveFeedbackEvent;
                        if (event.type === CALL_ENDED_EVENT_TYPE) {
                            ended = true;
                            break;
                        }
                        const update = applyRealtimeFeedbackEvent(state, event);
                        if (update.handled) {
                            state = update.state;
                            changed = true;
                        }
                        if (event.type === SUPERVISOR_NOTE_EVENT_TYPE) {
                            onSupervisorNoteRef.current?.();
                        }
                    }
                    if (changed) {
                        setMessages(state.messages);
                    }
                }

                if (ended) {
                    // Finalize any bot message left streaming when the call ended.
                    const finalState = applyRealtimeFeedbackEvent(state, { type: "rtf-bot-stopped-speaking" }).state;
                    setMessages(finalState.messages);
                    setStatus("ended");
                    return;
                }
            } catch (error) {
                if (signal.aborted) return;
                logger.warn("Live run event stream error:", error);
            }

            if (signal.aborted) return;
            attempt += 1;
            setStatus("reconnecting");
            const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }, [runId]);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        setMessages([]);
        setStatus("connecting");
        void run(controller.signal);
        return () => controller.abort();
    }, [enabled, run]);

    return { messages, status, isEnded: status === "ended" };
}
