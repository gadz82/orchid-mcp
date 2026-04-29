/**
 * Minimal Server-Sent Events parser per the WHATWG HTML spec.
 *
 * Takes a ``ReadableStream<Uint8Array>`` (the ``body`` of an ``undici``
 * response) and yields parsed events. Enough of the spec to consume
 * ``orchid-api``'s streaming chat endpoint — doesn't handle ``retry``,
 * BOM stripping, or the last-event-id reconnection protocol.
 */

export interface SSEEvent {
    /** Always present — defaults to ``"message"`` per the spec. */
    event: string;
    /** ``data:`` lines joined with ``\n``. Empty when no data field saw any payload. */
    data: string;
    /** Last ``id:`` field seen in this event (or prior events — id is sticky). */
    id?: string;
}

/**
 * Consume an SSE stream, yielding one event per spec-compliant dispatch.
 * Returns (the async generator completes) when the underlying stream
 * ends.
 */
export async function* parseSSE(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let eventType = "message";
    let dataLines: string[] = [];
    let lastId: string | undefined;
    const LINE_RE = /\r\n|\r|\n/;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (value !== undefined) {
                buffer += decoder.decode(value, { stream: true });
            }
            if (done) {
                buffer += decoder.decode();
            }

            // Drain all complete lines from the buffer.
            let match: RegExpExecArray | null;
            while ((match = LINE_RE.exec(buffer)) !== null) {
                const line = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);

                if (line.length === 0) {
                    // Blank line → dispatch the current event (if any data).
                    if (dataLines.length > 0) {
                        const ev: SSEEvent = {
                            event: eventType,
                            data: dataLines.join("\n"),
                        };
                        if (lastId !== undefined) ev.id = lastId;
                        yield ev;
                    }
                    eventType = "message";
                    dataLines = [];
                    continue;
                }

                if (line.startsWith(":")) {
                    // Comment.
                    continue;
                }

                const colonIdx = line.indexOf(":");
                const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
                let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
                if (value.startsWith(" ")) {
                    value = value.slice(1);
                }

                if (field === "event") {
                    eventType = value;
                } else if (field === "data") {
                    dataLines.push(value);
                } else if (field === "id" && !value.includes("\u0000")) {
                    lastId = value;
                }
                // Unknown fields (retry, …) are ignored.
            }

            if (done) break;
        }

        // Spec: no final dispatch on EOF unless a blank line came before.
        // We intentionally match that — the caller sees clean termination.
    } finally {
        reader.releaseLock();
    }
}
