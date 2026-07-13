import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import {
  clampDepth,
  findPathToNode,
  filterTree,
  filterTreeByFileType,
  parseExcludePatterns,
} from "../utils";
import type {
  ScanResult,
  ScanStatus,
  ScanProgress,
  ScanSession,
  VolumeInfo,
} from "../types";

const STORAGE_KEYS = {
  path: "disk-map:path",
  maxDepth: "disk-map:max-depth",
  filterQuery: "disk-map:filter-query",
  excludes: "disk-map:excludes",
  favorites: "disk-map:favorites",
} as const;

export function useScanSessions() {
  let [path, setPath] = useState("");
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
  let [reclaiming, setReclaiming] = useState(false);
  let [homePath, setHomePath] = useState("");
  let [pathSuggestions, setPathSuggestions] = useState<string[]>([]);
  let [favorites, setFavorites] = useState<string[]>([]);
  let [fileTypeFilter, setFileTypeFilter] = useState<string | null>(null);

  let fullTree = scanResult?.root ?? null;
  let focusChain = useMemo(
    () =>
      fullTree
        ? focusedPath
          ? findPathToNode(fullTree, focusedPath) ?? [fullTree]
          : [fullTree]
        : null,
    [fullTree, focusedPath],
  );
  let currentRoot = focusChain?.[focusChain.length - 1] ?? fullTree;
  let typeFilteredTree = useMemo(
    () => (currentRoot ? filterTreeByFileType(currentRoot, fileTypeFilter) : null),
    [currentRoot, fileTypeFilter],
  );
  let filteredTree = useMemo(
    () => (typeFilteredTree ? filterTree(typeFilteredTree, filterQuery) : null),
    [typeFilteredTree, filterQuery],
  );

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
    homeDir()
      .then((home) => {
        let clean = home.replace(/\/+$/, "");
        setHomePath(clean);
        setPathSuggestions([`${clean}/Documents/GitHub`]);
        setPath((prev) => (prev.trim() ? prev : clean));
      })
      .catch(() => {});
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
    let selected = await open({
      directory: true,
      multiple: false,
      defaultPath: path,
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

  return {
    path,
    setPath,
    filterQuery,
    setFilterQuery,
    maxDisplayDepth,
    setMaxDisplayDepth,
    excludeInput,
    setExcludeInput,
    scanResult,
    setScanResult,
    focusedPath,
    setFocusedPath,
    loading,
    error,
    setError,
    scanStatus,
    scanProgress,
    scanSessions,
    volumes,
    volumesOpen,
    setVolumesOpen,
    reclaiming,
    homePath,
    pathSuggestions,
    favorites,
    setFavorites,
    treeOpen,
    setTreeOpen,
    fileTypeFilter,
    setFileTypeFilter,
    currentRoot,
    filteredTree,
    focusChain,
    scan,
    cancelScan,
    chooseFolder,
    refreshVolumes,
    onFocusDirectory,
    revealInFinder,
    openPath,
    previewPath,
    toggleFavorite,
    scanFavorite,
    reclaimPurgeable,
  };
}
