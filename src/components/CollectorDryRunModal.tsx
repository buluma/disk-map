import { collectorSummary, collectorRisks, formatBytes, type CollectorItem } from "../utils";
import type { CollectorAction } from "../types";

export function CollectorDryRunModal({
  action,
  items,
  homePath,
  deleteConfirmation,
  onDeleteConfirmationChange,
  onCancel,
  onConfirm,
}: {
  action: CollectorAction;
  items: CollectorItem[];
  homePath: string;
  deleteConfirmation: string;
  onDeleteConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  let summary = collectorSummary(items);
  let risks = collectorRisks(items, homePath);
  let blockers = risks.filter((risk) => risk.severity === "blocker");
  let permanent = action === "permanent";
  let disabled = permanent && (deleteConfirmation !== "DELETE" || blockers.length > 0);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Collector dry run summary">
        <div className="summary-head">
          <h2>{permanent ? "Delete Permanently" : "Move to Trash"}</h2>
          <button className="collapse-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="dry-run-body">
          <div className="dry-run-grid">
            <span>Files: {summary.files}</span>
            <span>Folders: {summary.folders}</span>
            <span>Total: {formatBytes(summary.bytes)}</span>
            <span>Warnings: {risks.length}</span>
          </div>
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
          <div className="dry-run-paths">
            {items.map((item) => (
              <div key={item.path} title={item.path}>
                {item.path}
              </div>
            ))}
          </div>
          {permanent && (
            <input
              value={deleteConfirmation}
              onChange={(event) => onDeleteConfirmationChange(event.target.value)}
              placeholder="Type DELETE"
              spellCheck={false}
            />
          )}
          <button className={permanent ? "danger-action" : "primary-action"} onClick={onConfirm} disabled={disabled}>
            {permanent ? "Delete Permanently" : "Move to Trash"}
          </button>
        </div>
      </section>
    </div>
  );
}
