"use client";

import { Loader2, Send, Trash2, UserRoundCog, Zap } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { toast } from "sonner";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
    addSupervisorNote,
    clearSupervisorNotes,
    getSupervisorNotes,
    type SupervisorNote,
} from "@/lib/supervisorApi";
import { cn } from "@/lib/utils";

const DEFAULT_MAX_NOTES = 20;
const DEFAULT_MAX_NOTE_LENGTH = 1000;

export interface SupervisorPanelHandle {
    /** Re-read the active notes, e.g. after a supervisor-note event arrives. */
    refresh: () => void;
}

interface SupervisorPanelProps {
    runId: number;
    /** True once the call is over; notes can no longer be sent. */
    callEnded?: boolean;
    className?: string;
}

export const SupervisorPanel = forwardRef<SupervisorPanelHandle, SupervisorPanelProps>(
    function SupervisorPanel({ runId, callEnded = false, className }, ref) {
        const [notes, setNotes] = useState<SupervisorNote[]>([]);
        const [draft, setDraft] = useState("");
        const [maxNotes, setMaxNotes] = useState(DEFAULT_MAX_NOTES);
        const [maxLength, setMaxLength] = useState(DEFAULT_MAX_NOTE_LENGTH);
        const [serverSaysEnded, setServerSaysEnded] = useState(false);
        const [pending, setPending] = useState<"guide" | "respond" | "clear" | null>(null);

        const ended = callEnded || serverSaysEnded;

        const refresh = useCallback(async () => {
            try {
                const response = await getSupervisorNotes(runId);
                setNotes(response.notes);
                setMaxNotes(response.max_notes);
                setMaxLength(response.max_note_length);
                setServerSaysEnded(response.is_completed);
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not load supervisor notes");
            }
        }, [runId]);

        useImperativeHandle(ref, () => ({ refresh: () => void refresh() }), [refresh]);

        useEffect(() => {
            void refresh();
        }, [refresh]);

        const trimmed = draft.trim();
        const atLimit = notes.length >= maxNotes;
        const canSend = !ended && !pending && trimmed.length > 0 && trimmed.length <= maxLength && !atLimit;

        const send = async (respondNow: boolean) => {
            if (!canSend) return;
            setPending(respondNow ? "respond" : "guide");
            try {
                const response = await addSupervisorNote(runId, trimmed, respondNow);
                setNotes(response.notes);
                setDraft("");
                toast.success(respondNow ? "Note sent — asking the agent to respond" : "Note sent to the agent");
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not send the note");
                void refresh();
            } finally {
                setPending(null);
            }
        };

        const clear = async () => {
            setPending("clear");
            try {
                const response = await clearSupervisorNotes(runId);
                setNotes(response.notes);
                toast.success("Supervisor notes cleared");
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not clear notes");
            } finally {
                setPending(null);
            }
        };

        const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send(event.shiftKey);
            }
        };

        return (
            <div className={cn("flex min-h-0 flex-col gap-3 rounded-xl border border-border bg-background p-4", className)}>
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-violet-500/20 bg-violet-500/10 text-violet-500">
                            <UserRoundCog className="h-4 w-4" />
                        </div>
                        <div>
                            <p className="text-sm font-semibold text-foreground">Supervisor notes</p>
                            <p className="text-xs text-muted-foreground">
                                The agent follows these on its next reply. The caller never hears them.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
                    {notes.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                            No active notes
                        </p>
                    ) : (
                        <ol className="space-y-2">
                            {notes.map((note, index) => (
                                <li
                                    key={note.id}
                                    className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-sm text-foreground"
                                >
                                    <span className="mr-2 font-mono text-xs text-muted-foreground">{index + 1}.</span>
                                    <span className="break-words">{note.text}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>

                {ended ? (
                    <p className="rounded-lg bg-muted/50 px-3 py-2 text-center text-sm text-muted-foreground">
                        This call has ended. Notes can no longer be sent.
                    </p>
                ) : (
                    <div className="space-y-2">
                        <Textarea
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="e.g. Offer the 4:30 PM slot with Dr. Mehta first"
                            aria-label="Supervisor note"
                            maxLength={maxLength}
                            rows={3}
                            disabled={Boolean(pending)}
                            className="max-h-40 resize-none"
                        />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                                {atLimit
                                    ? `Limit of ${maxNotes} notes reached — clear notes to add more`
                                    : "Ctrl+Enter to send · Ctrl+Shift+Enter to send & respond"}
                            </span>
                            <span>{trimmed.length}/{maxLength}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="flex-1 gap-2"
                                disabled={!canSend}
                                onClick={() => void send(false)}
                            >
                                {pending === "guide" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                Send guidance
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                className="flex-1 gap-2"
                                disabled={!canSend}
                                onClick={() => void send(true)}
                            >
                                {pending === "respond" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                                Send &amp; respond now
                            </Button>
                        </div>
                    </div>
                )}

                <AlertDialog>
                    <AlertDialogTrigger asChild>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="gap-2 text-muted-foreground"
                            disabled={ended || notes.length === 0 || Boolean(pending)}
                        >
                            {pending === "clear" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            Clear notes
                        </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Clear all supervisor notes?</AlertDialogTitle>
                            <AlertDialogDescription>
                                The agent stops following them from its next reply.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void clear()}>Clear notes</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        );
    },
);
