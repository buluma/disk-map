import { otherHiddenBytes, formatBytes } from "../utils";
import type { ScanResult } from "../types";

export function HiddenSpacePanel({
  result,
  reclaiming,
  onReclaim,
}: {
  result: ScanResult;
  reclaiming: boolean;
  onReclaim: () => Promise<void>;
}) {
  let otherHidden = otherHiddenBytes(result.hiddenBytes, result.purgeableBytes);

  if (result.hiddenBytes === undefined && result.purgeableBytes === undefined) return null;

  return (
    <section className="summary">
      <div className="summary-head">
        <h2>Volume Space Estimates</h2>
        <button
          className="collapse-btn"
          onClick={onReclaim}
          disabled={reclaiming || !result.purgeableBytes || result.purgeableBytes <= 0}
        >
          {reclaiming ? "Reclaiming..." : "Reclaim Purgeable"}
        </button>
      </div>
      <p className="scan-status">Purgeable space is volume-wide. Unattributed usage is estimated only for volume-root scans; snapshots, filesystem metadata, compression, and shared blocks can affect it.</p>
      <div className="summary-list">
        <div className="summary-row">
          <span className="type-pill dir">HID</span>
          <span className="summary-name">Unattributed volume usage (estimate)</span>
          <span className="size">
            {result.hiddenBytes === undefined || result.hiddenBytes === null
              ? "Unavailable"
              : formatBytes(result.hiddenBytes)}
          </span>
        </div>
        <div className="summary-row">
          <span className="type-pill file">PUR</span>
          <span className="summary-name">Purgeable space</span>
          <span className="size">
            {result.purgeableBytes === undefined || result.purgeableBytes === null
              ? "Unavailable"
              : formatBytes(result.purgeableBytes)}
          </span>
        </div>
        <div className="summary-row">
          <span className="type-pill file">OTH</span>
          <span className="summary-name">Other unattributed usage (estimate)</span>
          <span className="size">{otherHidden === null ? "Unavailable" : formatBytes(otherHidden)}</span>
        </div>
      </div>
    </section>
  );
}
