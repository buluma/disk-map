import { type ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import {
  clampDepth,
  findPathToNode,
  filterTree,
  formatBytes,
  parseExcludePatterns,
  type DiskNode,
} from "./utils";

type ScanResult = {
  root: DiskNode;
  nodes: number;
  files: number;
  dirs: number;
  skipped: number;
  permissionDenied: number;
  errors: number;
  elapsedMs: number;
};

type ScanStatus = "idle" | "scanning" | "success" | "canceled" | "error";

type ScanProgress = {
  clientScanId: number;
  entriesScanned: number;
  dirsScanned: number;
  bytesAccumulated: number;
  elapsedMs: number;
};

const STORAGE_KEYS = {
  path: "disk-map:path",
  maxDepth: "disk-map:max-depth",
  filterQuery: "disk-map:filter-query",
  excludes: "disk-map:excludes",
} as const;

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

function NodeView({
  node,
  level = 0,
  filterQuery,
  onFocusDirectory,
}: {
  node: DiskNode;
  level?: number;
  filterQuery: string;
  onFocusDirectory: (path: string) => void;
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
      </div>

      {open &&
        node.children.map((child) => (
          <NodeView
            key={child.path}
            node={child}
            level={level + 1}
            filterQuery={filterQuery}
            onFocusDirectory={onFocusDirectory}
          />
        ))}
    </div>
  );
}

function TopLargest({
  root,
  limit = 8,
  onFocusDirectory,
}: {
  root: DiskNode;
  limit?: number;
  onFocusDirectory: (path: string) => void;
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
          </div>
        ))}
      </div>
    </section>
  );
}

type SunburstSegment = {
  node: DiskNode;
  depth: number;
  startAngle: number;
  endAngle: number;
  parentSize: number;
};

function polarToCartesian(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function ringSegmentPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
) {
  let startOuter = polarToCartesian(cx, cy, outerRadius, startAngle);
  let endOuter = polarToCartesian(cx, cy, outerRadius, endAngle);
  let startInner = polarToCartesian(cx, cy, innerRadius, endAngle);
  let endInner = polarToCartesian(cx, cy, innerRadius, startAngle);
  let largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${endInner.x} ${endInner.y}`,
    "Z",
  ].join(" ");
}

function buildSunburstSegments(
  root: DiskNode,
  maxDepth: number,
  minSize: number,
): SunburstSegment[] {
  let segments: SunburstSegment[] = [];

  function walk(node: DiskNode, depth: number, startAngle: number, endAngle: number, parentSize: number) {
    if (depth > maxDepth || !node.children.length || node.size <= 0) {
      return;
    }

    let currentAngle = startAngle;
    for (let child of node.children) {
      if (child.size < minSize) continue;
      let angleSpan = (endAngle - startAngle) * (child.size / node.size);
      let childStart = currentAngle;
      let childEnd = currentAngle + angleSpan;
      currentAngle = childEnd;

      if (childEnd - childStart < 0.002) continue;

      segments.push({
        node: child,
        depth,
        startAngle: childStart,
        endAngle: childEnd,
        parentSize,
      });

      walk(child, depth + 1, childStart, childEnd, child.size);
    }
  }

  walk(root, 1, -Math.PI / 2, Math.PI * 1.5, root.size);
  return segments;
}

function segmentColor(depth: number, index: number) {
  let hue = (index * 37 + depth * 29) % 360;
  let saturation = 60 - Math.min(depth * 4, 20);
  let lightness = 50 - Math.min(depth * 3, 14);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function SunburstMap({
  root,
  onFocusDirectory,
}: {
  root: DiskNode;
  onFocusDirectory: (path: string) => void;
}) {
  let [hovered, setHovered] = useState<SunburstSegment | null>(null);
  let size = 560;
  let cx = size / 2;
  let cy = size / 2;
  let ring = 38;
  let core = 56;
  let segments = buildSunburstSegments(root, 7, Math.max(root.size * 0.001, 1));

  return (
    <section className="sunburst-card">
      <div className="summary-head">
        <h2>Disk Map</h2>
        <span>Click a directory segment to focus</span>
      </div>
      <div className="sunburst-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} className="sunburst" role="img" aria-label="Disk usage sunburst">
          <circle cx={cx} cy={cy} r={core - 10} fill="#0f1626" stroke="#243253" strokeWidth="1" />
          <text x={cx} y={cy - 6} textAnchor="middle" className="sunburst-label-main">
            {root.name || "/"}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="sunburst-label-sub">
            {formatBytes(root.size)}
          </text>
          {segments.map((segment, index) => {
            let inner = core + (segment.depth - 1) * ring;
            let outer = inner + ring - 2;
            let path = ringSegmentPath(
              cx,
              cy,
              inner,
              outer,
              segment.startAngle,
              segment.endAngle,
            );
            let clickable = segment.node.is_dir;
            return (
              <path
                key={`${segment.node.path}-${index}`}
                d={path}
                fill={segmentColor(segment.depth, index)}
                className={`sunburst-segment ${clickable ? "clickable" : ""}`}
                onMouseEnter={() => setHovered(segment)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  if (clickable) onFocusDirectory(segment.node.path);
                }}
              />
            );
          })}
        </svg>
        <div className="sunburst-tooltip">
          {hovered ? (
            <>
              <div className="tooltip-title">{hovered.node.name}</div>
              <div>{formatBytes(hovered.node.size)}</div>
              <div>{((hovered.node.size / root.size) * 100).toFixed(2)}% of total</div>
              <div>{((hovered.node.size / hovered.parentSize) * 100).toFixed(2)}% of parent</div>
            </>
          ) : (
            <div>Hover segments for details</div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  let [path, setPath] = useState("/Users");
  let [filterQuery, setFilterQuery] = useState("");
  let [maxDisplayDepth, setMaxDisplayDepth] = useState(4);
  let [excludeInput, setExcludeInput] = useState(".git,node_modules");
  let [scanResult, setScanResult] = useState<ScanResult | null>(null);
  let [focusedPath, setFocusedPath] = useState<string | null>(null);
  let [loading, setLoading] = useState(false);
  let [error, setError] = useState("");
  let [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  let [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  let [activeClientScanId, setActiveClientScanId] = useState<number | null>(null);
  let fullTree = scanResult?.root ?? null;
  let focusChain = fullTree
    ? focusedPath
      ? findPathToNode(fullTree, focusedPath) ?? [fullTree]
      : [fullTree]
    : null;
  let currentRoot = focusChain?.[focusChain.length - 1] ?? fullTree;
  let filteredTree = currentRoot ? filterTree(currentRoot, filterQuery) : null;

  useEffect(() => {
    let storedPath = localStorage.getItem(STORAGE_KEYS.path);
    if (storedPath && storedPath.trim()) {
      setPath(storedPath);
    }

    let storedMaxDisplayDepth = localStorage.getItem(STORAGE_KEYS.maxDepth);
    if (storedMaxDisplayDepth) {
      let parsed = Number(storedMaxDisplayDepth);
      if (!Number.isNaN(parsed)) {
        setMaxDisplayDepth(clampDepth(parsed));
      }
    }

    let storedFilterQuery = localStorage.getItem(STORAGE_KEYS.filterQuery);
    if (storedFilterQuery) {
      setFilterQuery(storedFilterQuery);
    }

    let storedExcludes = localStorage.getItem(STORAGE_KEYS.excludes);
    if (storedExcludes !== null) {
      setExcludeInput(storedExcludes);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.path, path);
  }, [path]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.maxDepth, String(maxDisplayDepth));
  }, [maxDisplayDepth]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.filterQuery, filterQuery);
  }, [filterQuery]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.excludes, excludeInput);
  }, [excludeInput]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ScanProgress>("scan-progress", (event) => {
      let progress = event.payload;
      setScanProgress((prev) => {
        if (activeClientScanId === null) return prev;
        if (progress.clientScanId !== activeClientScanId) return prev;
        return progress;
      });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        setError(String(err));
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [activeClientScanId]);

  async function scan() {
    if (loading) return;

    let clientScanId = Date.now();
    setLoading(true);
    setError("");
    setFocusedPath(null);
    setScanStatus("scanning");
    setActiveClientScanId(clientScanId);
    setScanProgress({
      clientScanId,
      entriesScanned: 0,
      dirsScanned: 0,
      bytesAccumulated: 0,
      elapsedMs: 0,
    });

    try {
      let result = await invoke<ScanResult>("scan_directory", {
        path,
        maxDisplayDepth,
        excludes: parseExcludePatterns(excludeInput),
        clientScanId,
      });
      setScanResult(result);
      setScanStatus("success");
    } catch (err) {
      let message = String(err);
      if (message.includes("Scan canceled")) {
        setScanStatus("canceled");
      } else {
        setError(message);
        setScanStatus("error");
      }
    }

    setActiveClientScanId(null);
    setLoading(false);
  }

  async function cancelScan() {
    if (!loading) return;
    await invoke("cancel_scan");
    setScanStatus("canceled");
  }

  async function chooseFolder() {
    let selected = await invoke<string | string[] | null>("plugin:dialog|open", {
      options: {
        directory: true,
        multiple: false,
        defaultPath: path,
      },
    });

    if (typeof selected === "string") {
      setPath(selected);
    }
  }

  function onFocusDirectory(targetPath: string) {
    setFocusedPath(targetPath);
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
          value={maxDisplayDepth}
          onChange={(e) => {
            let next = Number(e.target.value);
            if (Number.isNaN(next)) return;
            setMaxDisplayDepth(clampDepth(next));
          }}
          aria-label="Max display depth"
          title="Max display depth"
        />
        <button onClick={chooseFolder} disabled={loading}>
          Choose Folder
        </button>
        <button onClick={cancelScan} disabled={!loading}>
          Cancel
        </button>
        <button onClick={scan} disabled={loading}>
          {loading ? "Scanning..." : "Scan"}
        </button>
      </div>

      <p className="scan-status">
        Status:{" "}
        {scanStatus === "idle" && "Idle"}
        {scanStatus === "scanning" && "Scanning"}
        {scanStatus === "success" && "Completed"}
        {scanStatus === "canceled" && "Canceled"}
        {scanStatus === "error" && "Error"}
      </p>

      <div className="toolbar">
        <input
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter by file/folder name or path"
          spellCheck={false}
          disabled={!currentRoot}
        />
      </div>

      <div className="toolbar">
        <input
          value={excludeInput}
          onChange={(e) => setExcludeInput(e.target.value)}
          placeholder="Exclude patterns (comma-separated), e.g. .git,node_modules,Library"
          spellCheck={false}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {focusChain && focusChain.length > 0 && (
        <section className="breadcrumbs">
          {focusChain.map((node, index) => (
            <button
              key={node.path}
              onClick={() => setFocusedPath(node.path)}
              className={index === focusChain.length - 1 ? "crumb active" : "crumb"}
              title={node.path}
            >
              {node.name || "/"}
            </button>
          ))}
        </section>
      )}

      {scanResult && (
        <section className="scan-metrics">
          <span>Total size: {formatBytes(scanResult.root.size)}</span>
          <span>Nodes: {scanResult.nodes}</span>
          <span>Files: {scanResult.files}</span>
          <span>Dirs: {scanResult.dirs}</span>
          <span>Skipped: {scanResult.skipped}</span>
          <span>Permission denied: {scanResult.permissionDenied}</span>
          <span>Errors: {scanResult.errors}</span>
          <span>Elapsed: {scanResult.elapsedMs} ms</span>
        </section>
      )}
      {scanProgress && (
        <section className="scan-progress">
          <div className="progress-head">
            <strong>Live Scan Progress</strong>
            <span>{scanProgress.elapsedMs} ms</span>
          </div>
          <div className="progress-grid">
            <span>Entries: {scanProgress.entriesScanned}</span>
            <span>Dirs: {scanProgress.dirsScanned}</span>
            <span>Bytes: {formatBytes(scanProgress.bytesAccumulated)}</span>
          </div>
        </section>
      )}

      {filteredTree && (
        <>
          <SunburstMap root={filteredTree} onFocusDirectory={onFocusDirectory} />
          <TopLargest root={filteredTree} onFocusDirectory={onFocusDirectory} />
          <section className="results">
            <NodeView
              node={filteredTree}
              filterQuery={filterQuery}
              onFocusDirectory={onFocusDirectory}
            />
          </section>
        </>
      )}

      {currentRoot && !filteredTree && (
        <p className="empty">No results for "{filterQuery}".</p>
      )}
    </main>
  );
}
