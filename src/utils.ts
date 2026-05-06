export type DiskNode = {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  children: DiskNode[];
};

export type CollectorItem = {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  exists?: boolean | null;
  isSymlink?: boolean | null;
};

export type CollectorRisk = {
  path: string;
  severity: "warning" | "blocker";
  message: string;
};

export type CollectorSummary = {
  files: number;
  folders: number;
  bytes: number;
};

export function formatBytes(bytes: number): string {
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

export function clampDepth(depth: number): number {
  return Math.min(12, Math.max(1, Math.floor(depth)));
}

export function filterTree(node: DiskNode, query: string): DiskNode | null {
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

export function parseExcludePatterns(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function findPathToNode(root: DiskNode, targetPath: string): DiskNode[] | null {
  if (root.path === targetPath) {
    return [root];
  }

  for (let child of root.children) {
    let childPath = findPathToNode(child, targetPath);
    if (childPath) {
      return [root, ...childPath];
    }
  }

  return null;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function usedPercent(totalBytes: number, usedBytes: number): number {
  if (totalBytes <= 0) return 0;
  return clampPercent((usedBytes / totalBytes) * 100);
}

export function availableIncludingPurgeable(availableBytes: number, purgeableBytes?: number | null): number {
  return availableBytes + Math.max(0, purgeableBytes ?? 0);
}

export function otherHiddenBytes(hiddenBytes?: number | null, purgeableBytes?: number | null): number | null {
  if (hiddenBytes === undefined || hiddenBytes === null) return null;
  return Math.max(0, hiddenBytes - Math.max(0, purgeableBytes ?? 0));
}

export function addCollectorItem(items: CollectorItem[], item: CollectorItem): CollectorItem[] {
  if (items.some((existing) => existing.path === item.path)) {
    return items;
  }
  return [...items, item];
}

export function removeCollectorItem(items: CollectorItem[], path: string): CollectorItem[] {
  return items.filter((item) => item.path !== path);
}

export function collectorSummary(items: CollectorItem[]): CollectorSummary {
  return items.reduce(
    (summary, item) => ({
      files: summary.files + (item.isDir ? 0 : 1),
      folders: summary.folders + (item.isDir ? 1 : 0),
      bytes: summary.bytes + item.size,
    }),
    { files: 0, folders: 0, bytes: 0 },
  );
}

function normalizePath(path: string): string {
  let normalized = path.trim().replace(/\/+$/, "");
  return normalized || "/";
}

function isPathDescendant(childPath: string, parentPath: string): boolean {
  let child = normalizePath(childPath);
  let parent = normalizePath(parentPath);
  return child !== parent && child.startsWith(`${parent}/`);
}

export function collectorRisks(items: CollectorItem[], homePath?: string): CollectorRisk[] {
  let risks: CollectorRisk[] = [];
  let normalizedHome = homePath ? normalizePath(homePath) : null;

  for (let item of items) {
    let itemPath = normalizePath(item.path);
    if (item.exists === false) {
      risks.push({
        path: item.path,
        severity: "blocker",
        message: "Path no longer exists.",
      });
    }
    if (item.isSymlink) {
      risks.push({
        path: item.path,
        severity: "warning",
        message: "This item is a symlink; only the link should be removed.",
      });
    }
    if (itemPath === "/" || itemPath === "/Users" || itemPath === normalizedHome) {
      risks.push({
        path: item.path,
        severity: "blocker",
        message: "Critical path selected.",
      });
    }
  }

  for (let item of items) {
    let parent = items.find((candidate) => isPathDescendant(item.path, candidate.path));
    if (parent) {
      risks.push({
        path: item.path,
        severity: "warning",
        message: `Already covered by selected parent ${parent.path}.`,
      });
    }
  }

  return risks;
}

export function hasPermanentDeleteBlocker(risks: CollectorRisk[]): boolean {
  return risks.some((risk) => risk.severity === "blocker");
}

export function fileMatchesType(path: string, kind: string): boolean {
  if (!kind) return true;
  if (kind === "(no extension)") {
    let name = path.split("/").pop() ?? path;
    return !name.includes(".");
  }
  return path.toLowerCase().endsWith(`.${kind.toLowerCase()}`);
}

export function filterTreeByFileType(node: DiskNode, kind: string | null): DiskNode | null {
  if (!kind) return node;
  if (!node.is_dir) {
    return fileMatchesType(node.path, kind) ? node : null;
  }

  let children = node.children
    .map((child) => filterTreeByFileType(child, kind))
    .filter((child): child is DiskNode => child !== null);

  if (children.length === 0) return null;
  return {
    ...node,
    children,
    size: children.reduce((sum, child) => sum + child.size, 0),
  };
}
