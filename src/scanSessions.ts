import type { ScanProgress, ScanResult, ScanSession } from "./types";

export type SessionState = {
  sessions: ScanSession[];
  selectedId: number | null;
  generation: number;
};
export const initialSessionState: SessionState = { sessions: [], selectedId: null, generation: 0 };
export type SessionAction =
  | { type: "start"; id: number; path: string }
  | { type: "select"; id: number }
  | { type: "progress"; progress: ScanProgress }
  | { type: "complete"; id: number; result: ScanResult }
  | { type: "fail"; id: number; error: string }
  | { type: "cancel"; ids?: number[] }
  | { type: "cleanup" }
  | { type: "update"; id: number | null; updater: (result: ScanResult | null) => ScanResult | null };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === "select") {
    return state.sessions.some((session) => session.clientScanId === action.id)
      ? { ...state, selectedId: action.id } : state;
  }
  if (action.type === "start") {
    let session: ScanSession = {
      clientScanId: action.id, rootPath: action.path, status: "scanning", generation: state.generation,
      progress: { clientScanId: action.id, rootPath: action.path, entriesScanned: 0,
        dirsScanned: 0, bytesAccumulated: 0, elapsedMs: 0 },
    };
    // Keep all active work, and at most five completed sessions.
    let active = state.sessions.filter((item) => item.status === "scanning");
    let finished = state.sessions.filter((item) => item.status !== "scanning" && item.rootPath !== action.path).slice(0, 5);
    return { ...state, selectedId: action.id, sessions: [session, ...active, ...finished] };
  }
  if (action.type === "cleanup") {
    return { ...state, generation: state.generation + 1,
      sessions: state.sessions.map((session) => ({ ...session, stale: true })) };
  }
  return { ...state, sessions: state.sessions.map((session): ScanSession => {
    if (action.type === "cancel") return session.status === "scanning" && (!action.ids || action.ids.includes(session.clientScanId)) ? { ...session, status: "canceled" } : session;
    if (action.type === "progress") return session.clientScanId === action.progress.clientScanId && session.status === "scanning"
      ? { ...session, progress: action.progress } : session;
    if (session.clientScanId !== action.id) return session;
    if (action.type === "update") return { ...session, result: action.updater(session.result ?? null) ?? undefined };
    if (session.status !== "scanning") return session;
    if (action.type === "complete") return { ...session, result: action.result, status: "success", stale: session.generation !== state.generation };
    return { ...session, status: action.error.includes("Scan canceled") ? "canceled" : "error", error: action.error };
  }) };
}
