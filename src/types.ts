import type { DiskNode } from "./utils";

export type ScanResult = {
  root: DiskNode;
  allocatedBytes?: number | null;
  hardLinkDuplicates?: number;
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

export type LargestFile = {
  name: string;
  path: string;
  size: number;
  parentPath: string;
};

export type FileTypeStat = {
  kind: string;
  bytes: number;
  files: number;
};

export type SkippedPath = {
  path: string;
  reason: string;
};

export type VolumeInfo = {
  name: string;
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  availableIncludingPurgeableBytes: number;
  purgeableBytes?: number | null;
};

export type ScanStatus = "idle" | "scanning" | "success" | "canceled" | "error";

export type ScanProgress = {
  clientScanId: number;
  rootPath: string;
  entriesScanned: number;
  dirsScanned: number;
  bytesAccumulated: number;
  elapsedMs: number;
};

export type ScanSession = {
  clientScanId: number;
  rootPath: string;
  status: ScanStatus;
  progress: ScanProgress;
  result?: ScanResult;
  error?: string;
  stale?: boolean;
  generation?: number;
};

export type PathInspection = {
  exists: boolean;
  isSymlink: boolean;
  isDir: boolean;
};

export type CollectorAction = "trash" | "permanent";
