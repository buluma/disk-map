import { type ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type DiskNode = {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  children: DiskNode[];
};

const STORAGE_KEYS = {
  path: "disk-map:path",
  maxDepth: "disk-map:max-depth",
  filterQuery: "disk-map:filter-query",
} as const;

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";

  let units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = bytes;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size = size / 1024;
    index++;
  }

  let formatted = size >= 10 ? size.toFixed(1) : size.toFixed(2);
  return `${formatted} ${units[index]}`;
}

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

function filterTree(node: DiskNode, query: string): DiskNode | null {
  let q = query.trim().toLowerCase();
  if (!q) return node;

  let selfMatch = node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);
  let filteredChildren = node.children
    .map((child) => filterTree(child, q))
    .filter((child): child is DiskNode => child !== null);

  if (!selfMatch && filteredChildren.length === 0) {
    return null;
  }

  return {
    ...node,
    children: filteredChildren,
  };
}

function NodeView({
  node,
  level = 0,
  filterQuery,
}: {
  node: DiskNode;
  level?: number;
  filterQuery: string;
}) {
  let [open, setOpen] = useState(level < 1);
  let hasChildren = node.children.length > 0;

  return (
    <div className="node">
      <div className="node-row" style={{ paddingLeft: level * 18 }}>
        <button
          className="toggle"
          onClick={() => setOpen(!open)}
          disabled={!hasChildren}
          aria-label={open ? "Collapse node" : "Expand node"}
        >
          {hasChildren ? (open ? "−" : "+") : "•"}
        </button>

        <span className={`type-pill ${node.is_dir ? "dir" : "file"}`}>
          {node.is_dir ? "DIR" : "FILE"}
        </span>
        <span className="name" title={node.path}>
          {highlightMatch(node.name, filterQuery)}
        </span>
        <span className="size">{formatBytes(node.size)}</span>
      </div>

      {open &&
        node.children.map((child) => (
          <NodeView
            key={child.path}
            node={child}
            level={level + 1}
            filterQuery={filterQuery}
          />
        ))}
    </div>
  );
}

function TopLargest({
  root,
  limit = 8,
}: {
  root: DiskNode;
  limit?: number;
}) {
  let largest = [...root.children].sort((a, b) => b.size - a.size).slice(0, limit);

  if (largest.length === 0) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Largest items in {root.name}</h2>
        <span>Top {largest.length}</span>
      </div>
      <div className="summary-list">
        {largest.map((item) => (
          <div className="summary-row" key={item.path}>
            <span className={`type-pill ${item.is_dir ? "dir" : "file"}`}>
              {item.is_dir ? "DIR" : "FILE"}
            </span>
            <span className="summary-name" title={item.path}>
              {item.name}
            </span>
            <span className="size">{formatBytes(item.size)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  let [path, setPath] = useState("/Users");
  let [filterQuery, setFilterQuery] = useState("");
  let [maxDepth, setMaxDepth] = useState(4);
  let [tree, setTree] = useState<DiskNode | null>(null);
  let [loading, setLoading] = useState(false);
  let [error, setError] = useState("");
  let filteredTree = tree ? filterTree(tree, filterQuery) : null;

  useEffect(() => {
    let storedPath = localStorage.getItem(STORAGE_KEYS.path);
    if (storedPath && storedPath.trim()) {
      setPath(storedPath);
    }

    let storedMaxDepth = localStorage.getItem(STORAGE_KEYS.maxDepth);
    if (storedMaxDepth) {
      let parsed = Number(storedMaxDepth);
      if (!Number.isNaN(parsed)) {
        setMaxDepth(Math.min(12, Math.max(1, Math.floor(parsed))));
      }
    }

    let storedFilterQuery = localStorage.getItem(STORAGE_KEYS.filterQuery);
    if (storedFilterQuery) {
      setFilterQuery(storedFilterQuery);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.path, path);
  }, [path]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.maxDepth, String(maxDepth));
  }, [maxDepth]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.filterQuery, filterQuery);
  }, [filterQuery]);

  async function scan() {
    setLoading(true);
    setError("");
    setTree(null);

    try {
      let result = await invoke<DiskNode>("scan_directory", { path, maxDepth });
      setTree(result);
    } catch (err) {
      setError(String(err));
    }

    setLoading(false);
  }

  return (
    <main className="app">
      <h1>disk-map</h1>
      <p className="subtitle">Recursive scanner with expandable tree view</p>

      <div className="toolbar">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/yourname"
          spellCheck={false}
        />
        <input
          className="depth-input"
          type="number"
          min={1}
          max={12}
          value={maxDepth}
          onChange={(e) => {
            let next = Number(e.target.value);
            if (Number.isNaN(next)) return;
            setMaxDepth(Math.min(12, Math.max(1, Math.floor(next))));
          }}
          aria-label="Max scan depth"
          title="Max scan depth"
        />
        <button onClick={scan} disabled={loading}>
          {loading ? "Scanning..." : "Scan"}
        </button>
      </div>

      <div className="toolbar">
        <input
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter by file/folder name or path"
          spellCheck={false}
          disabled={!tree}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {filteredTree && (
        <>
          <TopLargest root={filteredTree} />
          <section className="results">
            <NodeView node={filteredTree} filterQuery={filterQuery} />
          </section>
        </>
      )}

      {tree && !filteredTree && (
        <p className="empty">No results for "{filterQuery}".</p>
      )}
    </main>
  );
}
