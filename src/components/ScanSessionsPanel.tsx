import { formatBytes } from "../utils";
import type { ScanSession } from "../types";

export function ScanSessionsPanel({ sessions, selectedId, onSelect }: { sessions: ScanSession[]; selectedId: number | null; onSelect: (id: number) => void }) {
  if (!sessions.length) return null;

  return (
    <section className="scan-progress">
      <div className="progress-head">
        <strong>Scan Sessions</strong>
        <span>{sessions.length}</span>
      </div>
      <div className="session-list">
        {sessions.map((session) => (
          <div className="session-row" key={session.clientScanId}>
            <button className="summary-link" aria-pressed={session.clientScanId === selectedId} onClick={() => onSelect(session.clientScanId)} title={session.rootPath}>
              {session.rootPath}
            </button>
            <span>{session.status}</span>
            <span>{session.progress.entriesScanned} entries</span>
            <span>{formatBytes(session.progress.bytesAccumulated)}</span>
            <span>{session.progress.elapsedMs} ms</span>
          </div>
        ))}
      </div>
    </section>
  );
}
