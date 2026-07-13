import { useState } from "react";
import { formatBytes } from "../utils";
import type { FileTypeStat } from "../types";

export function FileTypeBreakdown({
  fileTypes,
  selectedType,
  onSelect,
  limit = 12,
}: {
  fileTypes: FileTypeStat[];
  selectedType: string | null;
  onSelect: (kind: string | null) => void;
  limit?: number;
}) {
  let top = fileTypes.slice(0, limit);
  let [open, setOpen] = useState(true);
  if (!top.length) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Top File Types</h2>
        <button className="collapse-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Collapse" : `Expand (${top.length})`}
        </button>
      </div>
      {open && (
        <div className="summary-list">
          {top.map((entry) => (
            <div className="summary-row" key={entry.kind}>
              <span className="type-pill file">{entry.kind}</span>
              <button
                className="summary-link"
                onClick={() => onSelect(selectedType === entry.kind ? null : entry.kind)}
              >
                {entry.files} files
              </button>
              <span className="size">{formatBytes(entry.bytes)}</span>
            </div>
          ))}
          {selectedType && (
            <div className="summary-row total-row">
              <span className="summary-name">Filtering by .{selectedType}</span>
              <button className="action-btn" onClick={() => onSelect(null)}>
                Clear filter
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
