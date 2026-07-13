import { useState } from "react";
import { formatBytes, type DiskNode } from "../utils";

export function TopLargest({
  root,
  limit = 8,
  onFocusDirectory,
  onReveal,
  onPreview,
  onOpen,
  onCollect,
}: {
  root: DiskNode;
  limit?: number;
  onFocusDirectory: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
  onPreview: (path: string) => Promise<void>;
  onOpen: (path: string) => Promise<void>;
  onCollect: (node: DiskNode) => void;
}) {
  let largest = [...root.children].sort((a, b) => b.size - a.size).slice(0, limit);
  let [open, setOpen] = useState(true);

  if (largest.length === 0) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Largest items in {root.name}</h2>
        <button className="collapse-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Collapse" : `Expand (${largest.length})`}
        </button>
      </div>
      {open && (
        <div className="summary-list">
          {largest.map((item) => (
            <div className="summary-row" key={item.path}>
              <span className={`type-pill ${item.is_dir ? "dir" : "file"}`}>
                {item.is_dir ? "DIR" : "FILE"}
              </span>
              {item.is_dir ? (
                <button
                  className="summary-link"
                  onClick={() => onFocusDirectory(item.path)}
                  title={item.path}
                >
                  {item.name}
                </button>
              ) : (
                <span className="summary-name" title={item.path}>
                  {item.name}
                </span>
              )}
              <span className="size">{formatBytes(item.size)}</span>
              <button className="action-btn" onClick={() => onReveal(item.path)} title={`Reveal ${item.path}`}>
                Reveal
              </button>
              <button className="action-btn" onClick={() => onPreview(item.path)} title={`Preview ${item.path}`}>
                Preview
              </button>
              <button className="action-btn" onClick={() => onOpen(item.path)} title={`Open ${item.path}`}>
                Open
              </button>
              <button className="action-btn danger" onClick={() => onCollect(item)} title={`Collect ${item.path}`}>
                Collect
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
