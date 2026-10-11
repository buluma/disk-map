import { describe, expect, it } from "vitest";
import { initialSessionState, sessionReducer } from "./scanSessions";
import type { ScanResult } from "./types";

const result: ScanResult = {
  root: { name: "root", path: "/root", size: 20, is_dir: true, children: [] },
  largestFiles: [], fileTypes: [], skippedPaths: [], nodes: 1, files: 0, dirs: 1,
  skipped: 0, permissionDenied: 0, errors: 0, elapsedMs: 1,
};
const start = (id: number, path = `/scan/${id}`) => ({ type: "start" as const, id, path });

describe("scan sessions", () => {
  it("keeps out-of-order completions attached to their own session and preserves selection", () => {
    let state = sessionReducer(sessionReducer(initialSessionState, start(1)), start(2));
    state = sessionReducer(state, { type: "complete", id: 2, result });
    state = sessionReducer(state, { type: "complete", id: 1, result: { ...result, files: 10 } });
    expect(state.selectedId).toBe(2);
    expect(state.sessions.find((session) => session.clientScanId === 2)?.result?.files).toBe(0);
    state = sessionReducer(state, { type: "select", id: 1 });
    expect(state.sessions.find((session) => session.clientScanId === state.selectedId)?.result?.files).toBe(10);
  });
  it("ignores late progress and completion after cancellation", () => {
    let state = sessionReducer(initialSessionState, start(1));
    state = sessionReducer(state, { type: "cancel" });
    state = sessionReducer(state, { type: "progress", progress: { ...state.sessions[0].progress, entriesScanned: 100 } });
    state = sessionReducer(state, { type: "complete", id: 1, result });
    expect(state.sessions[0].status).toBe("canceled");
    expect(state.sessions[0].result).toBeUndefined();
    expect(state.sessions[0].progress.entriesScanned).toBe(0);
  });
  it("marks completed and overlapping scans stale after cleanup, but fresh scans stay current", () => {
    let state = sessionReducer(initialSessionState, start(1));
    state = sessionReducer(state, { type: "complete", id: 1, result });
    state = sessionReducer(state, start(2));
    state = sessionReducer(state, { type: "cleanup" });
    state = sessionReducer(state, { type: "complete", id: 2, result });
    expect(state.sessions.every((session) => session.stale)).toBe(true);
    state = sessionReducer(state, start(3));
    state = sessionReducer(state, { type: "complete", id: 3, result });
    expect(state.sessions[0].stale).toBe(false);
  });
  it("retains all active scans while bounding completed history", () => {
    let state = initialSessionState;
    for (let id = 1; id <= 8; id++) state = sessionReducer(state, start(id));
    expect(state.sessions).toHaveLength(8);
    for (let id = 2; id <= 8; id++) state = sessionReducer(state, { type: "complete", id, result });
    state = sessionReducer(state, start(9));
    expect(state.sessions.filter((session) => session.status === "scanning").map((session) => session.clientScanId)).toEqual([9, 1]);
    expect(state.sessions.filter((session) => session.status !== "scanning")).toHaveLength(5);
  });
});
