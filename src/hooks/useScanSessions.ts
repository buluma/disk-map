import { useEffect, useMemo, useReducer, useRef, useState } from "react";
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
  ScanProgress,
  VolumeInfo,
} from "../types";

import { initialSessionState, sessionReducer } from "../scanSessions";

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
  let [focusedPath, setFocusedPath] = useState<string | null>(null);
  let [error, setError] = useState("");
  let [sessionState, dispatch] = useReducer(sessionReducer, initialSessionState);
  let scanSessions = sessionState.sessions;
  let activeClientScanId = sessionState.selectedId;
  let nextScanId = useRef(Date.now());
  let selectedSession = scanSessions.find((session) => session.clientScanId === activeClientScanId);
  let scanResult = selectedSession?.result ?? null;
  let scanStatus = selectedSession?.status ?? "idle";
  let scanProgress = selectedSession?.status === "scanning" ? selectedSession.progress : null;
  let loading = scanSessions.some((session) => session.status === "scanning");
  function setScanResult(updater: (result: ScanResult | null) => ScanResult | null) {
    dispatch({ type: "update", id: activeClientScanId, updater });
  }
  function selectSession(id: number) {
    dispatch({ type: "select", id });
    setFocusedPath(null);
    setFileTypeFilter(null);
  }
  async function invalidateAfterCleanup() {
    dispatch({ type: "cleanup" });
    await refreshVolumes();
  }
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
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen<ScanProgress>("scan-progress", (event) => {
      dispatch({ type: "progress", progress: event.payload });
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; })
      .catch((err) => { if (!disposed) setError(String(err)); });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  async function scan(targetOverride?: string) {
    let targetPath = (targetOverride ?? path).trim();
    if (!targetPath) return;
    if (scanSessions.some((session) => session.rootPath === targetPath && session.status === "scanning")) {
      setError(`A scan is already running for ${targetPath}`);
      return;
    }

    let clientScanId = ++nextScanId.current;
    setError("");
    setFocusedPath(null);
    setFileTypeFilter(null);
    dispatch({ type: "start", id: clientScanId, path: targetPath });

    try {
      let result = await invoke<ScanResult>("scan_directory", {
        path: targetPath,
        maxDisplayDepth,
        excludes: parseExcludePatterns(excludeInput),
        clientScanId,
      });
      dispatch({ type: "complete", id: clientScanId, result });
    } catch (err) {
      dispatch({ type: "fail", id: clientScanId, error: String(err) });
    }
  }

  async function cancelScan() {
    if (!loading) return;
    let ids = scanSessions.filter((session) => session.status === "scanning").map((session) => session.clientScanId);
    try {
      await invoke("cancel_scan");
      dispatch({ type: "cancel", ids });
    } catch (err) { setError(String(err)); }
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
      await invalidateAfterCleanup();
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
    error: error || selectedSession?.error || "",
    setError,
    scanStatus,
    scanProgress,
    scanSessions,
    activeClientScanId,
    selectSession,
    invalidateAfterCleanup,
    resultStale: Boolean(selectedSession?.result && selectedSession.stale),
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
