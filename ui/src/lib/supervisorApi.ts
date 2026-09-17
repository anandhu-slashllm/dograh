import { client } from "@/client/client.gen";
import { resolveBrowserBackendUrl } from "@/lib/apiClient";
import { detailFromError } from "@/lib/apiError";

/**
 * Live supervisor notes API (`/api/v1/workflow-runs/{run_id}/supervisor`).
 *
 * Uses the shared API client, so requests carry the same base URL and auth
 * interceptor as the generated SDK.
 */

export interface SupervisorNote {
    id: string;
    text: string;
    created_by?: number | null;
    created_at: string;
}

export interface SupervisorNotesResponse {
    run_id: number;
    is_completed: boolean;
    notes: SupervisorNote[];
    max_notes: number;
    max_note_length: number;
}

const notesUrl = "/api/v1/workflow-runs/{run_id}/supervisor/notes";

async function unwrap(
    request: Promise<{ data?: unknown; error?: unknown }>,
    fallback: string,
): Promise<SupervisorNotesResponse> {
    const { data, error } = await request;
    if (error || !data) {
        throw new Error(detailFromError(error, fallback));
    }
    return data as SupervisorNotesResponse;
}

export function getSupervisorNotes(runId: number) {
    return unwrap(
        client.get({ url: notesUrl, path: { run_id: runId } }),
        "Could not load supervisor notes",
    );
}

export function addSupervisorNote(runId: number, text: string, respondNow: boolean) {
    return unwrap(
        client.post({
            url: notesUrl,
            path: { run_id: runId },
            body: { text, respond_now: respondNow },
            headers: { "Content-Type": "application/json" },
        }),
        "Could not send the note",
    );
}

export function clearSupervisorNotes(runId: number) {
    return unwrap(
        client.delete({ url: notesUrl, path: { run_id: runId } }),
        "Could not clear notes",
    );
}

export function supervisorEventsUrl(runId: number) {
    const baseUrl = (client.getConfig().baseUrl || resolveBrowserBackendUrl()).replace(/\/+$/, "");
    return `${baseUrl}/api/v1/workflow-runs/${runId}/supervisor/events`;
}

/**
 * Split a server-sent events buffer into complete `data:` payloads.
 * Returns the parsed payloads and whatever incomplete text remains.
 */
export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
    const events: unknown[] = [];
    const normalized = buffer.replace(/\r\n/g, "\n");
    const blocks = normalized.split("\n\n");
    const rest = blocks.pop() ?? "";

    for (const block of blocks) {
        const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
        if (!data) continue; // comment/heartbeat
        try {
            events.push(JSON.parse(data));
        } catch {
            // Ignore malformed events rather than breaking the stream.
        }
    }

    return { events, rest };
}
