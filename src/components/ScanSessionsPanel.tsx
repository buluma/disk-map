import { formatBytes } from "../utils";
import type { ScanSession } from "../types";

export function ScanSessionsPanel({ sessions }: { sessions: ScanSession[] }) {
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
            <span className="summary-name" title={session.rootPath}>
              {session.rootPath}
            </span>
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
