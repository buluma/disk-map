import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  addCollectorItem,
  collectorRisks,
  hasPermanentDeleteBlocker,
  pruneLargestFiles,
  removeNodeByPath,
  type CollectorItem,
  type DiskNode,
} from "../utils";
import type { CollectorAction, PathInspection, ScanResult } from "../types";

type UseCollectorArgs = {
  homePath: string;
  setScanResult: (updater: (prev: ScanResult | null) => ScanResult | null) => void;
  setFocusedPath: (updater: (prev: string | null) => string | null) => void;
  setError: (value: string) => void;
};

export function useCollector({ homePath, setScanResult, setFocusedPath, setError }: UseCollectorArgs) {
  let [collectorItems, setCollectorItems] = useState<CollectorItem[]>([]);
  let [pendingCollectorAction, setPendingCollectorAction] = useState<CollectorAction | null>(null);
  let [deleteConfirmation, setDeleteConfirmation] = useState("");

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
    setCollectorItems((prev) => addCollectorItem(prev, item));
  }

  async function collectItem(item: CollectorItem) {
    let inspected = await inspectCollectorItem(item);
    setCollectorItems((prev) => addCollectorItem(prev, inspected));
  }

  function requestCollectorCommit(action: CollectorAction) {
    if (action === "permanent") {
      let risks = collectorRisks(collectorItems, homePath);
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
    let risks = collectorRisks(collectorItems, homePath);
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
        let keptLargest = pruneLargestFiles(prev.largestFiles, collectorItems, succeeded);
        return {
          ...prev,
          root: nextRoot,
          largestFiles: keptLargest,
        };
      });
      setFocusedPath((prev) => (prev !== null && succeeded.includes(prev) ? null : prev));
      setCollectorItems((prev) => prev.filter((item) => !succeeded.includes(item.path)));
    }

    if (failed.length > 0) {
      let actionLabel = permanent ? "permanently deleted" : "moved to Trash";
      setError(`Some items could not be ${actionLabel}:\n${failed.join("\n")}`);
    }
    setPendingCollectorAction(null);
    setDeleteConfirmation("");
  }

  return {
    collectorItems,
    setCollectorItems,
    pendingCollectorAction,
    setPendingCollectorAction,
    deleteConfirmation,
    setDeleteConfirmation,
    collectNode,
    collectItem,
    requestCollectorCommit,
    commitCollector,
  };
}
