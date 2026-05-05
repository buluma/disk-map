export type DiskNode = {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  children: DiskNode[];
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
