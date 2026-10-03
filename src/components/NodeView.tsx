import { type ReactNode, useState } from "react";
import { formatBytes, type DiskNode } from "../utils";

function highlightMatch(text: string, query: string): ReactNode {
  let q = query.trim();
  if (!q) return text;

  let lowerText = text.toLowerCase();
  let lowerQuery = q.toLowerCase();
  let index = lowerText.indexOf(lowerQuery);

  if (index < 0) return text;

  let before = text.slice(0, index);
  let match = text.slice(index, index + q.length);
  let after = text.slice(index + q.length);

  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

export function NodeView({
  node,
  level = 0,
  filterQuery,
  onFocusDirectory,
  onReveal,
  onPreview,
  onOpen,
  onCollect,
}: {
  node: DiskNode;
  level?: number;
  filterQuery: string;
  onFocusDirectory: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
  onPreview: (path: string) => Promise<void>;
  onOpen: (path: string) => Promise<void>;
  onCollect: (node: DiskNode) => void;
}) {
  let [open, setOpen] = useState(level < 1);
  let hasChildren = node.children.length > 0;

  return (
    <div className="node">
      <div className="node-row" style={{ paddingLeft: level * 18 }}>
        <button
          className="toggle"
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              setOpen(event.key === "ArrowRight");
            }
          }}
          disabled={!hasChildren}
          aria-expanded={hasChildren ? open : undefined}
          aria-label={open ? "Collapse node" : "Expand node"}
        >
          {hasChildren ? (open ? "−" : "+") : "•"}
        </button>

        <span className={`type-pill ${node.is_dir ? "dir" : "file"}`}>
          {node.is_dir ? "DIR" : "FILE"}
        </span>
        {node.is_dir ? (
          <button className="dir-link" onClick={() => onFocusDirectory(node.path)} title={node.path}>
            {highlightMatch(node.name, filterQuery)}
          </button>
        ) : (
          <span className="name" title={node.path}>
            {highlightMatch(node.name, filterQuery)}
          </span>
        )}
        <span className="size">{formatBytes(node.size)}</span>
        <button className="action-btn" onClick={() => onReveal(node.path)} title={`Reveal ${node.path}`}>
          Reveal
        </button>
        <button className="action-btn" onClick={() => onPreview(node.path)} title={`Preview ${node.path}`}>
          Preview
        </button>
        <button className="action-btn" onClick={() => onOpen(node.path)} title={`Open ${node.path}`}>
          Open
        </button>
        <button className="action-btn danger" onClick={() => onCollect(node)} title={`Collect ${node.path}`}>
          Collect
        </button>
      </div>

      {open &&
        node.children.map((child) => (
          <NodeView
            key={child.path}
            node={child}
            level={level + 1}
            filterQuery={filterQuery}
            onFocusDirectory={onFocusDirectory}
            onReveal={onReveal}
            onPreview={onPreview}
            onOpen={onOpen}
            onCollect={onCollect}
          />
        ))}
    </div>
  );
}
