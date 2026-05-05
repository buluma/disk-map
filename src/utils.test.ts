import { describe, expect, it } from "vitest";
import {
  clampDepth,
  filterTree,
  findPathToNode,
  parseExcludePatterns,
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
