import { describe, expect, it } from "vitest";
import {
  addCollectorItem,
  availableIncludingPurgeable,
  clampDepth,
  clampPercent,
  collectorRisks,
  collectorSummary,
  filterTreeByFileType,
  filterTree,
  findPathToNode,
  hasPermanentDeleteBlocker,
  otherHiddenBytes,
  parseExcludePatterns,
  removeCollectorItem,
  usedPercent,
  type DiskNode,
} from "./utils";

function makeTree(): DiskNode {
  return {
    name: "Users",
    path: "/Users",
    size: 100,
    is_dir: true,
    children: [
      {
        name: "alice",
        path: "/Users/alice",
        size: 80,
        is_dir: true,
        children: [
          {
            name: "report.pdf",
            path: "/Users/alice/report.pdf",
            size: 30,
            is_dir: false,
            children: [],
          },
        ],
      },
      {
        name: "tmp.bin",
        path: "/Users/tmp.bin",
        size: 20,
        is_dir: false,
        children: [],
      },
    ],
  };
}

describe("clampDepth", () => {
  it("clamps lower bound", () => {
    expect(clampDepth(-1)).toBe(1);
  });

  it("clamps upper bound", () => {
    expect(clampDepth(99)).toBe(12);
  });

  it("floors decimal values", () => {
    expect(clampDepth(4.9)).toBe(4);
  });
});

describe("filterTree", () => {
  it("returns original tree on empty query", () => {
    let tree = makeTree();
    expect(filterTree(tree, "")).toEqual(tree);
  });

  it("preserves parent when descendant matches", () => {
    let result = filterTree(makeTree(), "report");
    expect(result).not.toBeNull();
    expect(result?.children).toHaveLength(1);
    expect(result?.children[0].name).toBe("alice");
    expect(result?.children[0].children[0].name).toBe("report.pdf");
  });

  it("returns null when nothing matches", () => {
    expect(filterTree(makeTree(), "does-not-exist")).toBeNull();
  });
});

describe("parseExcludePatterns", () => {
  it("splits comma-separated patterns and trims spaces", () => {
    expect(parseExcludePatterns(" .git, node_modules , ,Library ")).toEqual([
      ".git",
      "node_modules",
      "Library",
    ]);
  });
});

describe("findPathToNode", () => {
  it("returns full chain from root to matched node", () => {
    let chain = findPathToNode(makeTree(), "/Users/alice/report.pdf");
    expect(chain?.map((node) => node.name)).toEqual(["Users", "alice", "report.pdf"]);
  });

  it("returns null when target path is missing", () => {
    expect(findPathToNode(makeTree(), "/Users/missing")).toBeNull();
  });
});

describe("disk math helpers", () => {
  it("clamps percentages", () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("calculates used percentage safely", () => {
    expect(usedPercent(100, 40)).toBe(40);
    expect(usedPercent(0, 40)).toBe(0);
  });

  it("adds purgeable bytes to available space", () => {
    expect(availableIncludingPurgeable(100, 25)).toBe(125);
    expect(availableIncludingPurgeable(100, null)).toBe(100);
  });

  it("calculates other hidden space without going negative", () => {
    expect(otherHiddenBytes(100, 25)).toBe(75);
    expect(otherHiddenBytes(10, 25)).toBe(0);
    expect(otherHiddenBytes(null, 25)).toBeNull();
  });
});

describe("collector helpers", () => {
  it("deduplicates collector items by path", () => {
    let item = { name: "a", path: "/a", size: 1, isDir: false };
    expect(addCollectorItem(addCollectorItem([], item), item)).toEqual([item]);
  });

  it("removes collector items by path", () => {
    let items = [
      { name: "a", path: "/a", size: 1, isDir: false },
      { name: "b", path: "/b", size: 2, isDir: true },
    ];
    expect(removeCollectorItem(items, "/a")).toEqual([items[1]]);
  });

  it("summarizes collector items", () => {
    expect(
      collectorSummary([
        { name: "a", path: "/a", size: 1, isDir: false },
        { name: "b", path: "/b", size: 2, isDir: true },
      ]),
    ).toEqual({ files: 1, folders: 1, bytes: 3 });
  });

  it("warns when a child path is already covered by a selected parent", () => {
    let risks = collectorRisks([
      { name: "parent", path: "/Users/me/project", size: 10, isDir: true },
      { name: "child", path: "/Users/me/project/file.txt", size: 1, isDir: false },
    ]);

    expect(risks).toContainEqual({
      path: "/Users/me/project/file.txt",
      severity: "warning",
      message: "Already covered by selected parent /Users/me/project.",
    });
  });

  it("blocks critical and missing collector paths", () => {
    let risks = collectorRisks([
      { name: "root", path: "/", size: 1, isDir: true },
      { name: "missing", path: "/tmp/missing", size: 1, isDir: false, exists: false },
    ]);

    expect(hasPermanentDeleteBlocker(risks)).toBe(true);
  });
});

describe("filterTreeByFileType", () => {
  it("keeps matching files and their parents", () => {
    let result = filterTreeByFileType(makeTree(), "pdf");
    expect(result?.children).toHaveLength(1);
    expect(result?.children[0].children[0].name).toBe("report.pdf");
  });

  it("returns null when no files match", () => {
    expect(filterTreeByFileType(makeTree(), "zip")).toBeNull();
  });
});
