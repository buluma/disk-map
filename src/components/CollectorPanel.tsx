import { collectorRisks, hasPermanentDeleteBlocker, formatBytes, type CollectorItem } from "../utils";

export function CollectorPanel({
  items,
  onRemove,
  onClear,
  onMoveToTrash,
  onPermanentDelete,
  homePath,
}: {
  items: CollectorItem[];
  onRemove: (path: string) => void;
  onClear: () => void;
  onMoveToTrash: () => void;
  onPermanentDelete: () => void;
  homePath?: string;
}) {
  let total = items.reduce((sum, item) => sum + item.size, 0);
  let risks = collectorRisks(items, homePath);
  let permanentDeleteBlocked = hasPermanentDeleteBlocker(risks);

  if (!items.length) return null;

  return (
    <section className="summary collector">
      <div className="summary-head">
        <h2>Collector ({items.length})</h2>
        <div className="button-row">
          <button className="collapse-btn" onClick={onClear}>
            Clear
          </button>
          <button className="collapse-btn" onClick={onMoveToTrash}>
            Move to Trash
          </button>
          <button className="collapse-btn danger" onClick={onPermanentDelete} disabled={permanentDeleteBlocked}>
            Delete Permanently
          </button>
        </div>
      </div>
      <div className="summary-list">
        {risks.length > 0 && (
          <div className="collector-risks">
            {risks.map((risk, index) => (
              <div className={`collector-risk ${risk.severity}`} key={`${risk.path}-${index}`}>
                <strong>{risk.severity === "blocker" ? "Blocked" : "Warning"}</strong>
                <span title={risk.path}>{risk.message}</span>
              </div>
            ))}
          </div>
        )}
        {items.map((item) => (
          <div className="summary-row" key={item.path}>
            <span className={`type-pill ${item.isDir ? "dir" : "file"}`}>
              {item.isDir ? "DIR" : "FILE"}
            </span>
            <span className="summary-name" title={item.path}>
              {item.name}
            </span>
            <span className="size">{formatBytes(item.size)}</span>
            <button className="action-btn" onClick={() => onRemove(item.path)}>
              Remove
            </button>
          </div>
        ))}
        <div className="summary-row total-row">
          <span className="summary-name">Total selected</span>
          <span className="size">{formatBytes(total)}</span>
        </div>
      </div>
    </section>
  );
}
