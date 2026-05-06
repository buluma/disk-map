import { type ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import {
  addCollectorItem,
  availableIncludingPurgeable,
  clampDepth,
  collectorRisks,
  collectorSummary,
  filterTreeByFileType,
  hasPermanentDeleteBlocker,
  otherHiddenBytes,
  findPathToNode,
  filterTree,
  formatBytes,
  parseExcludePatterns,
  removeCollectorItem,
  usedPercent,
  type CollectorItem,
  type DiskNode,
} from "./utils";

type ScanResult = {
  root: DiskNode;
  largestFiles: LargestFile[];
  fileTypes: FileTypeStat[];
  skippedPaths: SkippedPath[];
  hiddenBytes?: number | null;
  purgeableBytes?: number | null;
  nodes: number;
  files: number;
  dirs: number;
  skipped: number;
  permissionDenied: number;
  errors: number;
  elapsedMs: number;
};

type LargestFile = {
  name: string;
  path: string;
  size: number;
  parentPath: string;
};

type FileTypeStat = {
  kind: string;
  bytes: number;
  files: number;
};

type SkippedPath = {
  path: string;
  reason: string;
};

type VolumeInfo = {
  name: string;
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  availableIncludingPurgeableBytes: number;
  purgeableBytes?: number | null;
};

type ScanStatus = "idle" | "scanning" | "success" | "canceled" | "error";

type ScanProgress = {
  clientScanId: number;
  rootPath: string;
  entriesScanned: number;
  dirsScanned: number;
  bytesAccumulated: number;
  elapsedMs: number;
};

type ScanSession = {
  clientScanId: number;
  rootPath: string;
  status: ScanStatus;
  progress: ScanProgress;
};

type PathInspection = {
  exists: boolean;
  isSymlink: boolean;
  isDir: boolean;
};

type CollectorAction = "trash" | "permanent";

const STORAGE_KEYS = {
  path: "disk-map:path",
  maxDepth: "disk-map:max-depth",
  filterQuery: "disk-map:filter-query",
  excludes: "disk-map:excludes",
  favorites: "disk-map:favorites",
} as const;

const PATH_SUGGESTIONS = ["/Users/shadowwalker/Documents/GitHub"] as const;

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

function TopLargest({
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

function GlobalLargestFiles({
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

function FileTypeBreakdown({
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

function HiddenSpacePanel({
  result,
  reclaiming,
  onReclaim,
}: {
  result: ScanResult;
  reclaiming: boolean;
  onReclaim: () => Promise<void>;
}) {
  let otherHidden = otherHiddenBytes(result.hiddenBytes, result.purgeableBytes);

  if (result.hiddenBytes === undefined && result.purgeableBytes === undefined) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Hidden Space</h2>
        <button
          className="collapse-btn"
          onClick={onReclaim}
          disabled={reclaiming || !result.purgeableBytes || result.purgeableBytes <= 0}
        >
          {reclaiming ? "Reclaiming..." : "Reclaim Purgeable"}
        </button>
      </div>
      <div className="summary-list">
        <div className="summary-row">
          <span className="type-pill dir">HID</span>
          <span className="summary-name">Total hidden/restricted</span>
          <span className="size">
            {result.hiddenBytes === undefined || result.hiddenBytes === null
              ? "Unavailable"
              : formatBytes(result.hiddenBytes)}
          </span>
        </div>
        <div className="summary-row">
          <span className="type-pill file">PUR</span>
          <span className="summary-name">Purgeable space</span>
          <span className="size">
            {result.purgeableBytes === undefined || result.purgeableBytes === null
              ? "Unavailable"
              : formatBytes(result.purgeableBytes)}
          </span>
        </div>
        <div className="summary-row">
          <span className="type-pill file">OTH</span>
          <span className="summary-name">Other hidden/restricted</span>
          <span className="size">{otherHidden === null ? "Unavailable" : formatBytes(otherHidden)}</span>
        </div>
      </div>
    </section>
  );
}

function CollectorPanel({
  items,
  onRemove,
  onClear,
  onMoveToTrash,
  onPermanentDelete,
  homePath,
}: {
  items: CollectorItem[];
  onRemove: (path: string) => void;
  onClear: () => void;
  onMoveToTrash: () => void;
  onPermanentDelete: () => void;
  homePath?: string;
}) {
  let total = items.reduce((sum, item) => sum + item.size, 0);
  let risks = collectorRisks(items, homePath);
  let permanentDeleteBlocked = hasPermanentDeleteBlocker(risks);

  if (!items.length) return null;

  return (
    <section className="summary collector">
      <div className="summary-head">
        <h2>Collector ({items.length})</h2>
        <div className="button-row">
          <button className="collapse-btn" onClick={onClear}>
            Clear
          </button>
          <button className="collapse-btn" onClick={onMoveToTrash}>
            Move to Trash
          </button>
          <button className="collapse-btn danger" onClick={onPermanentDelete} disabled={permanentDeleteBlocked}>
            Delete Permanently
          </button>
        </div>
      </div>
      <div className="summary-list">
        {risks.length > 0 && (
          <div className="collector-risks">
            {risks.map((risk, index) => (
              <div className={`collector-risk ${risk.severity}`} key={`${risk.path}-${index}`}>
                <strong>{risk.severity === "blocker" ? "Blocked" : "Warning"}</strong>
                <span title={risk.path}>{risk.message}</span>
              </div>
            ))}
          </div>
        )}
        {items.map((item) => (
          <div className="summary-row" key={item.path}>
            <span className={`type-pill ${item.isDir ? "dir" : "file"}`}>
              {item.isDir ? "DIR" : "FILE"}
            </span>
            <span className="summary-name" title={item.path}>
              {item.name}
            </span>
            <span className="size">{formatBytes(item.size)}</span>
            <button className="action-btn" onClick={() => onRemove(item.path)}>
              Remove
            </button>
          </div>
        ))}
        <div className="summary-row total-row">
          <span className="summary-name">Total selected</span>
          <span className="size">{formatBytes(total)}</span>
        </div>
      </div>
    </section>
  );
}

function CollectorDryRunModal({
  action,
  items,
  homePath,
  deleteConfirmation,
  onDeleteConfirmationChange,
  onCancel,
  onConfirm,
}: {
  action: CollectorAction;
  items: CollectorItem[];
  homePath: string;
  deleteConfirmation: string;
  onDeleteConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  let summary = collectorSummary(items);
  let risks = collectorRisks(items, homePath);
  let blockers = risks.filter((risk) => risk.severity === "blocker");
  let permanent = action === "permanent";
  let disabled = permanent && (deleteConfirmation !== "DELETE" || blockers.length > 0);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Collector dry run summary">
        <div className="summary-head">
          <h2>{permanent ? "Delete Permanently" : "Move to Trash"}</h2>
          <button className="collapse-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="dry-run-body">
          <div className="dry-run-grid">
            <span>Files: {summary.files}</span>
            <span>Folders: {summary.folders}</span>
            <span>Total: {formatBytes(summary.bytes)}</span>
            <span>Warnings: {risks.length}</span>
          </div>
          {risks.length > 0 && (
            <div className="collector-risks">
              {risks.map((risk, index) => (
                <div className={`collector-risk ${risk.severity}`} key={`${risk.path}-${index}`}>
                  <strong>{risk.severity === "blocker" ? "Blocked" : "Warning"}</strong>
                  <span title={risk.path}>{risk.message}</span>
                </div>
              ))}
            </div>
          )}
          <div className="dry-run-paths">
            {items.map((item) => (
              <div key={item.path} title={item.path}>
                {item.path}
              </div>
            ))}
          </div>
          {permanent && (
            <input
              value={deleteConfirmation}
              onChange={(event) => onDeleteConfirmationChange(event.target.value)}
              placeholder="Type DELETE"
              spellCheck={false}
            />
          )}
          <button className={permanent ? "danger-action" : "primary-action"} onClick={onConfirm} disabled={disabled}>
            {permanent ? "Delete Permanently" : "Move to Trash"}
          </button>
        </div>
      </section>
    </div>
  );
}

function SkippedPathsPanel({ paths }: { paths: SkippedPath[] }) {
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

function ScanSessionsPanel({ sessions }: { sessions: ScanSession[] }) {
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

function removeNodeByPath(node: DiskNode, targetPath: string): DiskNode {
  let nextChildren = node.children
    .filter((child) => child.path !== targetPath)
    .map((child) => removeNodeByPath(child, targetPath));
  let nextSize = node.is_dir ? nextChildren.reduce((sum, child) => sum + child.size, 0) : node.size;
  return {
    ...node,
    size: nextSize,
    children: nextChildren,
  };
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
  let [scanSessions, setScanSessions] = useState<ScanSession[]>([]);
  let [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  let [volumesOpen, setVolumesOpen] = useState(false);
  let [treeOpen, setTreeOpen] = useState(true);
  let [collectorItems, setCollectorItems] = useState<CollectorItem[]>([]);
  let [favorites, setFavorites] = useState<string[]>([]);
  let [reclaiming, setReclaiming] = useState(false);
  let [fileTypeFilter, setFileTypeFilter] = useState<string | null>(null);
  let [pendingCollectorAction, setPendingCollectorAction] = useState<CollectorAction | null>(null);
  let [deleteConfirmation, setDeleteConfirmation] = useState("");
  let fullTree = scanResult?.root ?? null;
  let focusChain = fullTree
    ? focusedPath
      ? findPathToNode(fullTree, focusedPath) ?? [fullTree]
      : [fullTree]
    : null;
  let currentRoot = focusChain?.[focusChain.length - 1] ?? fullTree;
  let typeFilteredTree = currentRoot ? filterTreeByFileType(currentRoot, fileTypeFilter) : null;
  let filteredTree = typeFilteredTree ? filterTree(typeFilteredTree, filterQuery) : null;

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

    let storedFavorites = localStorage.getItem(STORAGE_KEYS.favorites);
    if (storedFavorites) {
      try {
        let parsed = JSON.parse(storedFavorites);
        if (Array.isArray(parsed)) {
          setFavorites(parsed.filter((value): value is string => typeof value === "string"));
        }
      } catch {
        setFavorites([]);
      }
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    invoke<VolumeInfo[]>("list_volumes")
      .then((result) => {
        if (mounted) {
          setVolumes(result);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(String(err));
        }
      });
    return () => {
      mounted = false;
    };
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
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    setLoading(scanSessions.some((session) => session.status === "scanning"));
  }, [scanSessions]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ScanProgress>("scan-progress", (event) => {
      let progress = event.payload;
      setScanProgress((prev) => {
        if (activeClientScanId === null) return prev;
        if (progress.clientScanId !== activeClientScanId) return prev;
        return progress;
      });
      setScanSessions((prev) =>
        prev.map((session) =>
          session.clientScanId === progress.clientScanId
            ? { ...session, progress, status: "scanning" }
            : session,
        ),
      );
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

  async function scan(targetOverride?: string) {
    let targetPath = (targetOverride ?? path).trim();
    if (!targetPath) return;
    if (scanSessions.some((session) => session.rootPath === targetPath && session.status === "scanning")) {
      setError(`A scan is already running for ${targetPath}`);
      return;
    }

    let clientScanId = Date.now();
    setLoading(true);
    setError("");
    setFocusedPath(null);
    setScanStatus("scanning");
    setActiveClientScanId(clientScanId);
    setScanProgress({
      clientScanId,
      rootPath: targetPath,
      entriesScanned: 0,
      dirsScanned: 0,
      bytesAccumulated: 0,
      elapsedMs: 0,
    });
    setScanSessions((prev) => [
      {
        clientScanId,
        rootPath: targetPath,
        status: "scanning",
        progress: {
          clientScanId,
          rootPath: targetPath,
          entriesScanned: 0,
          dirsScanned: 0,
          bytesAccumulated: 0,
          elapsedMs: 0,
        },
      },
      ...prev.filter((session) => session.rootPath !== targetPath).slice(0, 4),
    ]);

    try {
      let result = await invoke<ScanResult>("scan_directory", {
        path: targetPath,
        maxDisplayDepth,
        excludes: parseExcludePatterns(excludeInput),
        clientScanId,
      });
      setScanResult(result);
      setScanStatus("success");
      setScanSessions((prev) =>
        prev.map((session) =>
          session.clientScanId === clientScanId ? { ...session, status: "success" } : session,
        ),
      );
    } catch (err) {
      let message = String(err);
      if (message.includes("Scan canceled")) {
        setScanStatus("canceled");
        setScanSessions((prev) =>
          prev.map((session) =>
            session.clientScanId === clientScanId ? { ...session, status: "canceled" } : session,
          ),
        );
      } else {
        setError(message);
        setScanStatus("error");
        setScanSessions((prev) =>
          prev.map((session) =>
            session.clientScanId === clientScanId ? { ...session, status: "error" } : session,
          ),
        );
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

  async function refreshVolumes() {
    try {
      let result = await invoke<VolumeInfo[]>("list_volumes");
      setVolumes(result);
    } catch (err) {
      setError(String(err));
    }
  }

  function onFocusDirectory(targetPath: string) {
    setFocusedPath(targetPath);
  }

  async function revealInFinder(targetPath: string) {
    try {
      await invoke("reveal_in_finder", { path: targetPath });
    } catch (err) {
      setError(String(err));
    }
  }

  async function openPath(targetPath: string) {
    try {
      await invoke("open_path", { path: targetPath });
    } catch (err) {
      setError(String(err));
    }
  }

  async function previewPath(targetPath: string) {
    try {
      await invoke("preview_path", { path: targetPath });
    } catch (err) {
      setError(String(err));
    }
  }

  async function inspectCollectorItem(item: CollectorItem): Promise<CollectorItem> {
    try {
      let inspection = await invoke<PathInspection>("inspect_path", { path: item.path });
      return {
        ...item,
        exists: inspection.exists,
        isSymlink: inspection.isSymlink,
        isDir: inspection.isDir,
      };
    } catch {
      return item;
    }
  }

  async function collectNode(node: DiskNode) {
    let item = await inspectCollectorItem({
      name: node.name,
      path: node.path,
      size: node.size,
      isDir: node.is_dir,
    });
    setCollectorItems((prev) =>
      addCollectorItem(prev, item),
    );
  }

  async function collectItem(item: CollectorItem) {
    let inspected = await inspectCollectorItem(item);
    setCollectorItems((prev) => addCollectorItem(prev, inspected));
  }

  function requestCollectorCommit(action: CollectorAction) {
    if (action === "permanent") {
      let risks = collectorRisks(collectorItems, "/Users/shadowwalker");
      if (hasPermanentDeleteBlocker(risks)) {
        setError("Permanent delete is blocked until critical or missing Collector items are removed.");
        return;
      }
    }
    setDeleteConfirmation("");
    setPendingCollectorAction(action);
  }

  async function commitCollector(action: CollectorAction) {
    let permanent = action === "permanent";
    let risks = collectorRisks(collectorItems, "/Users/shadowwalker");
    if (permanent && hasPermanentDeleteBlocker(risks)) {
      setError("Permanent delete is blocked until critical or missing Collector items are removed.");
      return;
    }
    let commandName = permanent ? "permanently_delete_path" : "move_to_trash";

    let failed: string[] = [];
    let succeeded: string[] = [];
    for (let item of collectorItems) {
      try {
        await invoke(commandName, { path: item.path });
        succeeded.push(item.path);
      } catch (err) {
        failed.push(`${item.path}: ${String(err)}`);
      }
    }

    if (succeeded.length > 0) {
      setScanResult((prev) => {
        if (!prev) return prev;
        let nextRoot = succeeded.reduce((root, targetPath) => removeNodeByPath(root, targetPath), prev.root);
        return {
          ...prev,
          root: nextRoot,
          largestFiles: prev.largestFiles.filter((item) => !succeeded.includes(item.path)),
        };
      });
      if (focusedPath && succeeded.includes(focusedPath)) {
        setFocusedPath(null);
      }
      setCollectorItems((prev) => prev.filter((item) => !succeeded.includes(item.path)));
    }

    if (failed.length > 0) {
      let action = permanent ? "permanently deleted" : "moved to Trash";
      setError(`Some items could not be ${action}:\n${failed.join("\n")}`);
    }
    setPendingCollectorAction(null);
    setDeleteConfirmation("");
  }

  async function reclaimPurgeable() {
    if (!scanResult) return;
    let ok = window.confirm(
      "Reclaim purgeable space for this volume?\n\nThis can take time, and macOS may not reclaim every byte immediately.",
    );
    if (!ok) return;
    setReclaiming(true);
    setError("");
    try {
      await invoke("reclaim_purgeable_space", { path: scanResult.root.path });
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        let purgeableBytes = await invoke<number | null>("get_purgeable_space", {
          path: scanResult.root.path,
        });
        setScanResult((prev) => (prev ? { ...prev, purgeableBytes } : prev));
      }
      await refreshVolumes();
    } catch (err) {
      setError(String(err));
    } finally {
      setReclaiming(false);
    }
  }

  function toggleFavorite() {
    let targetPath = path.trim();
    if (!targetPath) return;
    setFavorites((prev) =>
      prev.includes(targetPath)
        ? prev.filter((favorite) => favorite !== targetPath)
        : [...prev, targetPath],
    );
  }

  function scanFavorite(favorite: string) {
    setPath(favorite);
    void scan(favorite);
  }

  return (
    <main className="app">
      <h1>Disk Map</h1>
      <p className="subtitle">Find, preview, and clean up local storage.</p>

      <div className="toolbar">
        <select
          className="volume-select"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          disabled={loading || volumes.length === 0}
          title="Mounted volumes"
        >
          <option value={path}>Current path</option>
          {volumes.map((volume) => (
            <option key={volume.path} value={volume.path}>
              {volume.name} ({volume.path})
            </option>
          ))}
        </select>
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
        <button onClick={toggleFavorite} disabled={!path.trim()}>
          {favorites.includes(path.trim()) ? "Unstar" : "Star"}
        </button>
        <button onClick={refreshVolumes} disabled={loading}>
          Refresh Volumes
        </button>
        <button onClick={cancelScan} disabled={!loading}>
          Cancel
        </button>
        <button onClick={() => scan()}>
          Scan
        </button>
      </div>

      {(PATH_SUGGESTIONS.length > 0 || favorites.length > 0) && (
        <section className="favorites">
          {PATH_SUGGESTIONS.map((suggestedPath) => (
            <button
              key={suggestedPath}
              className="favorite-chip"
              onClick={() => setPath(suggestedPath)}
              title={suggestedPath}
            >
              {suggestedPath}
            </button>
          ))}
          {favorites.map((favorite) => (
            <button key={favorite} className="favorite-chip" onClick={() => scanFavorite(favorite)} title={favorite}>
              {favorite}
            </button>
          ))}
        </section>
      )}

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
      <ScanSessionsPanel sessions={scanSessions} />
      <CollectorPanel
        items={collectorItems}
        onRemove={(targetPath) => setCollectorItems((prev) => removeCollectorItem(prev, targetPath))}
        onClear={() => setCollectorItems([])}
        onMoveToTrash={() => requestCollectorCommit("trash")}
        onPermanentDelete={() => requestCollectorCommit("permanent")}
        homePath="/Users/shadowwalker"
      />
      {pendingCollectorAction && (
        <CollectorDryRunModal
          action={pendingCollectorAction}
          items={collectorItems}
          homePath="/Users/shadowwalker"
          deleteConfirmation={deleteConfirmation}
          onDeleteConfirmationChange={setDeleteConfirmation}
          onCancel={() => {
            setPendingCollectorAction(null);
            setDeleteConfirmation("");
          }}
          onConfirm={() => commitCollector(pendingCollectorAction)}
        />
      )}
      {scanResult && <HiddenSpacePanel result={scanResult} reclaiming={reclaiming} onReclaim={reclaimPurgeable} />}

      {filteredTree && (
        <>
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
          <SunburstMap root={filteredTree} onFocusDirectory={onFocusDirectory} />
          {fileTypeFilter && (
            <p className="scan-status">File type filter: {fileTypeFilter}</p>
          )}
          <FileTypeBreakdown
            fileTypes={scanResult?.fileTypes ?? []}
            selectedType={fileTypeFilter}
            onSelect={setFileTypeFilter}
          />
          <SkippedPathsPanel paths={scanResult?.skippedPaths ?? []} />
          <TopLargest
            root={filteredTree}
            onFocusDirectory={onFocusDirectory}
            onReveal={revealInFinder}
            onPreview={previewPath}
            onOpen={openPath}
            onCollect={collectNode}
          />
          <section className="summary">
            <div className="summary-head">
              <h2>Tree Results</h2>
              <button className="collapse-btn" onClick={() => setTreeOpen((v) => !v)}>
                {treeOpen ? "Collapse" : "Expand"}
              </button>
            </div>
            {treeOpen && (
              <section className="results">
                <NodeView
                  node={filteredTree}
                  filterQuery={filterQuery}
                  onFocusDirectory={onFocusDirectory}
                  onReveal={revealInFinder}
                  onPreview={previewPath}
                  onOpen={openPath}
                  onCollect={collectNode}
                />
              </section>
            )}
          </section>
        </>
      )}

      {currentRoot && !filteredTree && (
        <p className="empty">No results for "{filterQuery}".</p>
      )}

      <GlobalLargestFiles
        files={scanResult?.largestFiles ?? []}
        onFocusDirectory={onFocusDirectory}
        onReveal={revealInFinder}
        onPreview={previewPath}
        onOpen={openPath}
        onCollect={collectItem}
      />

      {volumes.length > 0 && (
        <section className="summary">
          <div className="summary-head">
            <h2>Mounted Volumes</h2>
            <button className="collapse-btn" onClick={() => setVolumesOpen((v) => !v)}>
              {volumesOpen ? "Collapse" : `Expand (${volumes.length})`}
            </button>
          </div>
          {volumesOpen && (
            <div className="summary-list">
              {volumes.map((volume) => (
                <div className="summary-row" key={volume.path}>
                  <span className="type-pill dir">VOL</span>
                  <button className="summary-link" onClick={() => setPath(volume.path)} title={volume.path}>
                    {volume.name}
                  </button>
                  <span className="size">
                    Used: {usedPercent(volume.totalBytes, volume.usedBytes).toFixed(1)}%
                  </span>
                  <span className="size">
                    Free:{" "}
                    {formatBytes(
                      volume.availableIncludingPurgeableBytes ??
                        availableIncludingPurgeable(volume.availableBytes, volume.purgeableBytes),
                    )}
                  </span>
                  <span className="size">
                    Purgeable:{" "}
                    {volume.purgeableBytes === undefined || volume.purgeableBytes === null
                      ? "Unavailable"
                      : formatBytes(volume.purgeableBytes)}
                  </span>
                  <span className="size">Total: {formatBytes(volume.totalBytes)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
