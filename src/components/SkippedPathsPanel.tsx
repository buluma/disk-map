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
      {open && (
        <div className="summary-list">
          {paths.map((entry) => (
            <div className="summary-row" key={`${entry.reason}-${entry.path}`}>
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
