import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getNotesMock, addNoteMock, clearNotesMock } = vi.hoisted(() => ({
    getNotesMock: vi.fn(),
    addNoteMock: vi.fn(),
    clearNotesMock: vi.fn(),
}));

vi.mock("@/lib/supervisorApi", () => ({
    getSupervisorNotes: getNotesMock,
    addSupervisorNote: addNoteMock,
    clearSupervisorNotes: clearNotesMock,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SupervisorPanel } from "./SupervisorPanel";

const NOTE = { id: "n1", text: "Offer a discount", created_at: "2026-09-17T10:00:00Z" };

function response(notes = [NOTE], isCompleted = false) {
    return { run_id: 7, is_completed: isCompleted, notes, max_notes: 20, max_note_length: 1000 };
}

describe("SupervisorPanel", () => {
    beforeEach(() => {
        getNotesMock.mockReset().mockResolvedValue(response([]));
        addNoteMock.mockReset().mockResolvedValue(response());
        clearNotesMock.mockReset().mockResolvedValue(response([]));
    });

    it("sends guidance without asking for an immediate reply", async () => {
        render(<SupervisorPanel runId={7} />);
        await waitFor(() => expect(getNotesMock).toHaveBeenCalledWith(7));

        fireEvent.change(screen.getByLabelText("Supervisor note"), { target: { value: "  Offer a discount  " } });
        fireEvent.click(screen.getByRole("button", { name: /send guidance/i }));

        await waitFor(() => expect(addNoteMock).toHaveBeenCalledWith(7, "Offer a discount", false));
        expect(await screen.findByText("Offer a discount")).toBeTruthy();
        expect((screen.getByLabelText("Supervisor note") as HTMLTextAreaElement).value).toBe("");
    });

    it("asks the agent to respond now", async () => {
        render(<SupervisorPanel runId={7} />);
        await waitFor(() => expect(getNotesMock).toHaveBeenCalled());

        fireEvent.change(screen.getByLabelText("Supervisor note"), { target: { value: "Wrap up" } });
        fireEvent.click(screen.getByRole("button", { name: /send & respond now/i }));

        await waitFor(() => expect(addNoteMock).toHaveBeenCalledWith(7, "Wrap up", true));
    });

    it("does not send empty notes", async () => {
        render(<SupervisorPanel runId={7} />);
        await waitFor(() => expect(getNotesMock).toHaveBeenCalled());

        fireEvent.change(screen.getByLabelText("Supervisor note"), { target: { value: "   " } });

        expect((screen.getByRole("button", { name: /send guidance/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("clears notes after confirmation", async () => {
        getNotesMock.mockResolvedValue(response([NOTE]));
        render(<SupervisorPanel runId={7} />);
        expect(await screen.findByText("Offer a discount")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: /clear notes/i }));
        const confirm = await screen.findAllByRole("button", { name: /clear notes/i });
        fireEvent.click(confirm[confirm.length - 1]);

        await waitFor(() => expect(clearNotesMock).toHaveBeenCalledWith(7));
        expect(await screen.findByText("No active notes")).toBeTruthy();
    });

    it("stops accepting notes once the call has ended", async () => {
        getNotesMock.mockResolvedValue(response([NOTE], true));
        render(<SupervisorPanel runId={7} />);

        expect(await screen.findByText(/this call has ended/i)).toBeTruthy();
        expect(screen.queryByLabelText("Supervisor note")).toBeNull();
    });
});
