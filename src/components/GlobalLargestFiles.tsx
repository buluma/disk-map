import { useState } from "react";
import { formatBytes, type CollectorItem } from "../utils";
import type { LargestFile } from "../types";

export function GlobalLargestFiles({
  files,
  onFocusDirectory,
  onReveal,
  onPreview,
  onOpen,
  onCollect,
  limit = 20,
}: {
  files: LargestFile[];
  onFocusDirectory: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
  onPreview: (path: string) => Promise<void>;
  onOpen: (path: string) => Promise<void>;
  onCollect: (item: CollectorItem) => void;
  limit?: number;
}) {
  let topFiles = files.slice(0, limit);
  let [open, setOpen] = useState(false);
  if (!topFiles.length) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Largest Files (Global)</h2>
        <button className="collapse-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Collapse" : `Expand (${topFiles.length})`}
        </button>
      </div>
      {open && (
        <div className="summary-list">
          {topFiles.map((file) => (
            <div className="summary-row" key={file.path}>
              <span className="type-pill file">FILE</span>
              <span className="summary-name" title={file.path}>
                {file.name}
              </span>
              <button
                className="summary-folder-link"
                onClick={() => onFocusDirectory(file.parentPath)}
                title={file.parentPath}
                disabled={!file.parentPath}
              >
                Open folder
              </button>
              <span className="size">{formatBytes(file.size)}</span>
              <button className="action-btn" onClick={() => onReveal(file.path)} title={`Reveal ${file.path}`}>
                Reveal
              </button>
              <button className="action-btn" onClick={() => onPreview(file.path)} title={`Preview ${file.path}`}>
                Preview
              </button>
              <button className="action-btn" onClick={() => onOpen(file.path)} title={`Open ${file.path}`}>
                Open
              </button>
              <button
                className="action-btn danger"
                onClick={() => onCollect({ name: file.name, path: file.path, size: file.size, isDir: false })}
                title={`Collect ${file.path}`}
              >
                Collect
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
