import { useScanSessions } from "./hooks/useScanSessions";
import { useCollector } from "./hooks/useCollector";
import { clampDepth, formatBytes, removeCollectorItem, usedPercent } from "./utils";
import { NodeView } from "./components/NodeView";
import { TopLargest } from "./components/TopLargest";
import { GlobalLargestFiles } from "./components/GlobalLargestFiles";
import { FileTypeBreakdown } from "./components/FileTypeBreakdown";
import { HiddenSpacePanel } from "./components/HiddenSpacePanel";
import { CollectorPanel } from "./components/CollectorPanel";
import { CollectorDryRunModal } from "./components/CollectorDryRunModal";
import { SkippedPathsPanel } from "./components/SkippedPathsPanel";
import { ScanSessionsPanel } from "./components/ScanSessionsPanel";
import { SunburstMap } from "./components/SunburstMap";
import "./App.css";

export default function App() {
  let scan = useScanSessions();
  let collector = useCollector({
    homePath: scan.homePath,
    onCleanup: scan.invalidateAfterCleanup,
    setError: scan.setError,
  });
  let pending = collector.pendingCollectorAction;

  return (
    <main className="app">
      <h1>Disk Map</h1>
      <p className="subtitle">Find, preview, and clean up local storage.</p>

      <div className="toolbar">
        <select
          className="volume-select"
          value={scan.path}
          onChange={(e) => scan.setPath(e.target.value)}
          disabled={scan.loading || scan.volumes.length === 0}
          title="Mounted volumes"
        >
          <option value={scan.path}>Current path</option>
          {scan.volumes.map((volume) => (
            <option key={volume.path} value={volume.path}>
              {volume.name} ({volume.path})
            </option>
          ))}
        </select>
        <input
          value={scan.path}
          onChange={(e) => scan.setPath(e.target.value)}
          placeholder="/Users/yourname"
          spellCheck={false}
        />
        <input
          className="depth-input"
          type="number"
          min={1}
          max={12}
          value={scan.maxDisplayDepth}
          onChange={(e) => {
            let next = Number(e.target.value);
            if (!Number.isFinite(next)) return;
            scan.setMaxDisplayDepth(clampDepth(next));
          }}
          aria-label="Max display depth"
          title="Max display depth"
        />
        <button onClick={scan.chooseFolder} disabled={scan.loading}>
          Choose Folder
        </button>
        <button onClick={scan.toggleFavorite} disabled={!scan.path.trim()}>
          {scan.favorites.includes(scan.path.trim()) ? "Unstar" : "Star"}
        </button>
        <button onClick={scan.refreshVolumes} disabled={scan.loading}>
          Refresh Volumes
        </button>
        <button onClick={scan.cancelScan} disabled={!scan.loading}>
          Cancel All
        </button>
        <button onClick={() => scan.scan()}>
          Scan
        </button>
      </div>

      {(scan.pathSuggestions.length > 0 || scan.favorites.length > 0) && (
        <section className="favorites">
          {scan.pathSuggestions.map((suggestedPath) => (
            <button
              key={suggestedPath}
              className="favorite-chip"
              onClick={() => scan.setPath(suggestedPath)}
              title={suggestedPath}
            >
              {suggestedPath}
            </button>
          ))}
          {scan.favorites.map((favorite) => (
            <button key={favorite} className="favorite-chip" onClick={() => scan.scanFavorite(favorite)} title={favorite}>
              {favorite}
            </button>
          ))}
        </section>
      )}

      <p className="scan-status">
        Status:{" "}
        {scan.scanStatus === "idle" && "Idle"}
        {scan.scanStatus === "scanning" && "Scanning"}
        {scan.scanStatus === "success" && "Completed"}
        {scan.scanStatus === "canceled" && "Canceled"}
        {scan.scanStatus === "error" && "Error"}
      </p>

      <div className="toolbar">
        <input
          value={scan.filterQuery}
          onChange={(e) => scan.setFilterQuery(e.target.value)}
          placeholder="Filter by file/folder name or path"
          spellCheck={false}
          disabled={!scan.currentRoot}
        />
      </div>

      <div className="toolbar">
        <input
          value={scan.excludeInput}
          onChange={(e) => scan.setExcludeInput(e.target.value)}
          placeholder="Exclude patterns (comma-separated), e.g. .git,node_modules,Library"
          spellCheck={false}
        />
      </div>

      {scan.error && <p className="error">{scan.error}</p>}

      {scan.scanResult && (
        <section className="scan-metrics">
          <span>Logical size: {formatBytes(scan.scanResult.root.size)}</span>
          <span>Allocated: {scan.scanResult.allocatedBytes == null ? "Unavailable" : formatBytes(scan.scanResult.allocatedBytes)}</span>
          <span>Hard-link duplicates: {scan.scanResult.hardLinkDuplicates ?? 0}</span>
          <span>Nodes: {scan.scanResult.nodes}</span>
          <span>Files: {scan.scanResult.files}</span>
          <span>Dirs: {scan.scanResult.dirs}</span>
          <span>Skipped: {scan.scanResult.skipped}</span>
          <span>Permission denied: {scan.scanResult.permissionDenied}</span>
          <span>Errors: {scan.scanResult.errors}</span>
          <span>Elapsed: {scan.scanResult.elapsedMs} ms</span>
        </section>
      )}
      {scan.scanProgress && (
        <section className="scan-progress">
          <div className="progress-head">
            <strong>Live Scan Progress</strong>
            <span>{scan.scanProgress.elapsedMs} ms</span>
          </div>
          <div className="progress-grid">
            <span>Entries: {scan.scanProgress.entriesScanned}</span>
            <span>Dirs: {scan.scanProgress.dirsScanned}</span>
            <span>Bytes: {formatBytes(scan.scanProgress.bytesAccumulated)}</span>
          </div>
        </section>
      )}
      <ScanSessionsPanel sessions={scan.scanSessions} selectedId={scan.activeClientScanId} onSelect={scan.selectSession} />
      {scan.resultStale && <p role="status">These results predate cleanup. Rescan this folder to refresh sizes and analytics. <button onClick={() => scan.scan(scan.scanResult?.root.path)}>Rescan</button></p>}
      <CollectorPanel
        busy={collector.committing}
        items={collector.collectorItems}
        onRemove={(targetPath) => collector.setCollectorItems((prev) => removeCollectorItem(prev, targetPath))}
        onClear={() => collector.setCollectorItems([])}
        onMoveToTrash={() => collector.requestCollectorCommit("trash")}
        onPermanentDelete={() => collector.requestCollectorCommit("permanent")}
        homePath={scan.homePath}
      />
      {pending && (
        <CollectorDryRunModal
          busy={collector.committing}
          action={pending}
          items={collector.collectorItems}
          homePath={scan.homePath}
          deleteConfirmation={collector.deleteConfirmation}
          onDeleteConfirmationChange={collector.setDeleteConfirmation}
          onCancel={() => {
            collector.setPendingCollectorAction(null);
            collector.setDeleteConfirmation("");
          }}
          onConfirm={() => collector.commitCollector(pending)}
        />
      )}
      {scan.scanResult && (
        <HiddenSpacePanel result={scan.scanResult} reclaiming={scan.reclaiming} onReclaim={scan.reclaimPurgeable} />
      )}

      {scan.filteredTree && (
        <>
          {scan.focusChain && scan.focusChain.length > 0 && (
            <section className="breadcrumbs">
              {scan.focusChain.map((node, index) => (
                <button
                  key={node.path}
                  onClick={() => scan.setFocusedPath(node.path)}
                  className={index === scan.focusChain!.length - 1 ? "crumb active" : "crumb"}
                  title={node.path}
                >
                  {node.name || "/"}
                </button>
              ))}
            </section>
          )}
          <SunburstMap root={scan.filteredTree} onFocusDirectory={scan.onFocusDirectory} />
          {scan.fileTypeFilter && (
            <p className="scan-status">File type filter: {scan.fileTypeFilter}</p>
          )}
          <FileTypeBreakdown
            fileTypes={scan.scanResult?.fileTypes ?? []}
            selectedType={scan.fileTypeFilter}
            onSelect={scan.setFileTypeFilter}
          />
          <SkippedPathsPanel paths={scan.scanResult?.skippedPaths ?? []} />
          <TopLargest
            root={scan.filteredTree}
            onFocusDirectory={scan.onFocusDirectory}
            onReveal={scan.revealInFinder}
            onPreview={scan.previewPath}
            onOpen={scan.openPath}
            onCollect={collector.collectNode}
          />
          <section className="summary">
            <div className="summary-head">
              <h2>Tree Results</h2>
              <button className="collapse-btn" onClick={() => scan.setTreeOpen((v) => !v)}>
                {scan.treeOpen ? "Collapse" : "Expand"}
              </button>
            </div>
            {scan.treeOpen && (
              <section className="results">
                <NodeView
                  node={scan.filteredTree}
                  filterQuery={scan.filterQuery}
                  onFocusDirectory={scan.onFocusDirectory}
                  onReveal={scan.revealInFinder}
                  onPreview={scan.previewPath}
                  onOpen={scan.openPath}
                  onCollect={collector.collectNode}
                />
              </section>
            )}
          </section>
        </>
      )}

      {scan.currentRoot && !scan.filteredTree && (
        <p className="empty">No results for "{scan.filterQuery}".</p>
      )}

      <GlobalLargestFiles
        files={scan.scanResult?.largestFiles ?? []}
        onFocusDirectory={scan.onFocusDirectory}
        onReveal={scan.revealInFinder}
        onPreview={scan.previewPath}
        onOpen={scan.openPath}
        onCollect={collector.collectItem}
      />

      {scan.volumes.length > 0 && (
        <section className="summary">
          <div className="summary-head">
            <h2>Mounted Volumes</h2>
            <button className="collapse-btn" onClick={() => scan.setVolumesOpen((v) => !v)}>
              {scan.volumesOpen ? "Collapse" : `Expand (${scan.volumes.length})`}
            </button>
          </div>
          {scan.volumesOpen && (
            <div className="summary-list">
              {scan.volumes.map((volume) => (
                <div className="summary-row" key={volume.path}>
                  <span className="type-pill dir">VOL</span>
                  <button className="summary-link" onClick={() => scan.setPath(volume.path)} title={volume.path}>
                    {volume.name}
                  </button>
                  <span className="size">
                    Used: {usedPercent(volume.totalBytes, volume.usedBytes).toFixed(1)}%
                  </span>
                  <span className="size">
                    Free:{" "}
                    {formatBytes(volume.availableBytes)}
                  </span>
                  <span className="size">
                    Including purgeable: {formatBytes(volume.availableIncludingPurgeableBytes)}
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
