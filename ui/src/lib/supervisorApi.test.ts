import { describe, expect, it } from "vitest";

import { parseSseChunk } from "./supervisorApi";

describe("parseSseChunk", () => {
    it("returns complete events and keeps the partial remainder", () => {
        const { events, rest } = parseSseChunk(
            'data: {"type":"a"}\n\n: ping\n\ndata: {"type":"b"}\n\ndata: {"ty',
        );

        expect(events).toEqual([{ type: "a" }, { type: "b" }]);
        expect(rest).toBe('data: {"ty');
    });

    it("handles CRLF line endings and skips malformed payloads", () => {
        const { events, rest } = parseSseChunk('data: not-json\r\n\r\ndata: {"type":"c"}\r\n\r\n');

        expect(events).toEqual([{ type: "c" }]);
        expect(rest).toBe("");
    });
});
