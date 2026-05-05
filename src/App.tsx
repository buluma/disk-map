import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type DiskNode = {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  children: DiskNode[];
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";

  let units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size = size / 1024;
    index++;
  }

  return Math.round(size) + " " + units[index];
}

function NodeView({ node, level = 0 }: { node: DiskNode; level?: number }) {
  let [open, setOpen] = useState(level < 1);

  return (
    <div className="node">
      <div className="node-row" style={{ paddingLeft: level * 18 }}>
        <button onClick={() => setOpen(!open)} disabled={!node.children.length}>
          {node.children.length ? (open ? "−" : "+") : " "}
        </button>

        <span className="name">{node.name}</span>
        <span className="size">{formatBytes(node.size)}</span>
      </div>

      {open &&
        node.children.map((child) => (
          <NodeView key={child.path} node={child} level={level + 1} />
        ))}
    </div>
  );
}

export default function App() {
  let [path, setPath] = useState("/Users");
  let [tree, setTree] = useState<DiskNode | null>(null);
  let [loading, setLoading] = useState(false);
  let [error, setError] = useState("");

  async function scan() {
    setLoading(true);
    setError("");
    setTree(null);

    try {
      let result = await invoke<DiskNode>("scan_directory", { path });
      setTree(result);
    } catch (err) {
      setError(String(err));
    }

    setLoading(false);
  }

  return (
    <main className="app">
      <h1>Disk Map</h1>

      <div className="toolbar">
        <input value={path} onChange={(e) => setPath(e.target.value)} />
        <button onClick={scan} disabled={loading}>
          {loading ? "Scanning..." : "Scan"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {tree && (
        <section className="results">
          <NodeView node={tree} />
        </section>
      )}
    </main>
  );
}
