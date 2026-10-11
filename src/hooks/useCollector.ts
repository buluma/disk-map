import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  addCollectorItem,
  collectorRisks,
  collectorRoots,
  hasPermanentDeleteBlocker,
  type CollectorItem,
  type DiskNode,
} from "../utils";
import type { CollectorAction, PathInspection } from "../types";

type UseCollectorArgs = {
  homePath: string;
  onCleanup: () => Promise<void>;
  setError: (value: string) => void;
};

export function useCollector({ homePath, onCleanup, setError }: UseCollectorArgs) {
  let committingRef = useRef(false);
  let [committing, setCommitting] = useState(false);
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
      return { ...item, exists: false };
    }
  }

  async function collectNode(node: DiskNode) {
    if (committingRef.current) return;
    let item = await inspectCollectorItem({
      name: node.name,
      path: node.path,
      size: node.size,
      isDir: node.is_dir,
    });
    if (!committingRef.current) setCollectorItems((prev) => addCollectorItem(prev, item));
  }

  async function collectItem(item: CollectorItem) {
    if (committingRef.current) return;
    let inspected = await inspectCollectorItem(item);
    if (!committingRef.current) setCollectorItems((prev) => addCollectorItem(prev, inspected));
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
    if (committingRef.current) return;
    let permanent = action === "permanent";
    if (permanent && deleteConfirmation !== "DELETE") return;
    committingRef.current = true;
    setCommitting(true);
    let inspected = await Promise.all(collectorItems.map(inspectCollectorItem));
    setCollectorItems(inspected);
    let risks = collectorRisks(inspected, homePath);
    if (permanent && hasPermanentDeleteBlocker(risks)) {
      setError("Permanent delete is blocked until critical or missing Collector items are removed.");
      committingRef.current = false;
      setCommitting(false);
      return;
    }
    let commandName = permanent ? "permanently_delete_path" : "move_to_trash";

    let failed: string[] = [];
    let succeeded: string[] = [];
    for (let item of collectorRoots(inspected)) {
      try {
        await invoke(commandName, { path: item.path });
        succeeded.push(item.path);
      } catch (err) {
        failed.push(`${item.path}: ${String(err)}`);
      }
    }

    if (succeeded.length > 0) {
      await onCleanup();
      setCollectorItems((prev) => prev.filter((item) => !succeeded.some((path) => item.path === path || item.path.startsWith(`${path.replace(/\/+$/, "")}/`))));
    }

    if (failed.length > 0) {
      let actionLabel = permanent ? "permanently deleted" : "moved to Trash";
      setError(`Some items could not be ${actionLabel}:\n${failed.join("\n")}`);
    }
    committingRef.current = false;
    setCommitting(false);
    setPendingCollectorAction(null);
    setDeleteConfirmation("");
  }

  return {
    committing,
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
