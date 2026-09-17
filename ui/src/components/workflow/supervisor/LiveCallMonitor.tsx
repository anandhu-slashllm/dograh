"use client";

import { Radio } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { ConversationRailFrame, RealtimeFeedback } from "@/components/workflow/conversation";
import { useLiveRunEvents } from "@/hooks/useLiveRunEvents";

import { SupervisorPanel, type SupervisorPanelHandle } from "./SupervisorPanel";

interface LiveCallMonitorProps {
    runId: number;
    getAccessToken: () => Promise<string>;
    /** Called once the call has ended, so the page can load the run details. */
    onCallEnded?: () => void;
}

const STATUS_LABEL = {
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    ended: "Call ended",
} as const;

export function LiveCallMonitor({ runId, getAccessToken, onCallEnded }: LiveCallMonitorProps) {
    const panelRef = useRef<SupervisorPanelHandle>(null);
    const onCallEndedRef = useRef(onCallEnded);

    useEffect(() => {
        onCallEndedRef.current = onCallEnded;
    }, [onCallEnded]);

    const handleSupervisorNote = useCallback(() => {
        panelRef.current?.refresh();
    }, []);

    const { messages, status, isEnded } = useLiveRunEvents({
        runId,
        getAccessToken,
        onSupervisorNote: handleSupervisorNote,
    });

    useEffect(() => {
        if (isEnded) {
            onCallEndedRef.current?.();
        }
    }, [isEnded]);

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 p-6">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Run #{runId}
                    </p>
                    <h1 className="text-2xl font-semibold text-foreground">Live call monitor</h1>
                </div>
                <Badge variant={status === "live" ? "default" : "secondary"} className="gap-1.5">
                    <Radio className={status === "live" ? "h-3.5 w-3.5 animate-pulse" : "h-3.5 w-3.5"} />
                    {STATUS_LABEL[status]}
                </Badge>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
                <ConversationRailFrame className="min-h-[320px]">
                    <RealtimeFeedback
                        mode="live"
                        messages={messages}
                        isCallActive={status === "live"}
                        isCallCompleted={isEnded}
                    />
                </ConversationRailFrame>
                <SupervisorPanel ref={panelRef} runId={runId} callEnded={isEnded} />
            </div>
        </div>
    );
}
