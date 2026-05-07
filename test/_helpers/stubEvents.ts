/**
 * Drop-in events-method stubs for the existing :class:`StubClient`s.
 *
 * Phase-7 added :class:`OrchidEventsClient` to :class:`OrchidAPIClient`;
 * every test stub now needs the four extra methods.  Rather than
 * duplicating no-op ``async () => { throw … }`` bodies in eight test
 * files, this helper exports a single object literal that each
 * stub spreads via ``Object.assign(this, eventsStubMethods)`` (or
 * the ``eventsNoop`` factory below for the simplest case).
 *
 * Tests that actually exercise the events surface live in
 * ``test/eventsTools.test.ts`` and use a dedicated
 * :class:`FakeEventsClient`; this helper exists only to keep the
 * unrelated stubs compiling without a flood of boilerplate.
 */

import type {
    BloomRun,
    BloomRunListResponse,
    CallOptions,
    EmitSignalParams,
    ListRunsFilter,
    SignalEmitResponse,
} from "../../src/http/orchidClient.js";

export interface EventsStubSurface {
    emitSignal(opts: CallOptions, params: EmitSignalParams): Promise<SignalEmitResponse>;
    getRun(opts: CallOptions, runId: string): Promise<BloomRun>;
    listRuns(opts: CallOptions, filter: ListRunsFilter): Promise<BloomRunListResponse>;
    listRunsForSignal(opts: CallOptions, signalId: string): Promise<BloomRunListResponse>;
}

/**
 * Returns a fresh object whose four event methods all throw
 * ``NotImplementedError`` — keeps the type checker happy without
 * suggesting tests can rely on these without patching.
 */
export function eventsNoop(): EventsStubSurface {
    const fail = (name: string) => async (): Promise<never> => {
        throw new Error(`stub.${name} not implemented for this test`);
    };
    return {
        emitSignal: fail("emitSignal") as EventsStubSurface["emitSignal"],
        getRun: fail("getRun") as EventsStubSurface["getRun"],
        listRuns: fail("listRuns") as EventsStubSurface["listRuns"],
        listRunsForSignal: fail("listRunsForSignal") as EventsStubSurface["listRunsForSignal"],
    };
}
