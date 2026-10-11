import { useState } from "react";
import type { SkippedPath } from "../types";

export function SkippedPathsPanel({ paths }: { paths: SkippedPath[] }) {
  let [open, setOpen] = useState(false);
  if (!paths.length) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Skipped Paths</h2>
        <button className="collapse-btn" onClick={() => setOpen((value) => !value)}>
          {open ? "Collapse" : `Expand (${paths.length})`}
        </button>
      </div>
      <p className="scan-status">Showing up to 100 skipped entries: {paths.filter((entry) => entry.reason === "Excluded").length} excluded by your patterns, {paths.filter((entry) => entry.reason !== "Excluded").length} unreadable or failed.</p>
      {open && (
        <div className="summary-list">
          {paths.map((entry, index) => (
            <div className="summary-row" key={`${entry.reason}-${entry.path}-${index}`}>
              <span className="type-pill file">SKIP</span>
              <span className="summary-name" title={entry.path}>
                {entry.path}
              </span>
              <span className="size">{entry.reason}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
