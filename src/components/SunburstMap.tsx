import { useState, useMemo } from "react";
import { formatBytes, type DiskNode } from "../utils";

type SunburstSegment = {
  node: DiskNode;
  depth: number;
  startAngle: number;
  endAngle: number;
  parentSize: number;
};

function polarToCartesian(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function ringSegmentPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
) {
  let startOuter = polarToCartesian(cx, cy, outerRadius, startAngle);
  let endOuter = polarToCartesian(cx, cy, outerRadius, endAngle);
  let startInner = polarToCartesian(cx, cy, innerRadius, endAngle);
  let endInner = polarToCartesian(cx, cy, innerRadius, startAngle);
  let largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${endInner.x} ${endInner.y}`,
    "Z",
  ].join(" ");
}

function buildSunburstSegments(
  root: DiskNode,
  maxDepth: number,
  minSize: number,
): SunburstSegment[] {
  let segments: SunburstSegment[] = [];

  function walk(node: DiskNode, depth: number, startAngle: number, endAngle: number) {
    if (depth > maxDepth || !node.children.length || node.size <= 0) {
      return;
    }

    let currentAngle = startAngle;
    for (let child of node.children) {
      let angleSpan = (endAngle - startAngle) * (child.size / node.size);
      let childStart = currentAngle;
      let childEnd = currentAngle + angleSpan;
      currentAngle = childEnd;

      if (child.size < minSize || childEnd - childStart < 0.002) continue;

      segments.push({
        node: child,
        depth,
        startAngle: childStart,
        endAngle: childEnd,
        parentSize: node.size,
      });

      walk(child, depth + 1, childStart, childEnd);
    }
  }

  walk(root, 1, -Math.PI / 2, Math.PI * 1.5);
  return segments;
}

function segmentColor(depth: number, index: number) {
  let hue = (index * 37 + depth * 29) % 360;
  let saturation = 60 - Math.min(depth * 4, 20);
  let lightness = 50 - Math.min(depth * 3, 14);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function SunburstMap({
  root,
  onFocusDirectory,
}: {
  root: DiskNode;
  onFocusDirectory: (path: string) => void;
}) {
  let [hovered, setHovered] = useState<SunburstSegment | null>(null);
  let size = 560;
  let cx = size / 2;
  let cy = size / 2;
  let core = 56;
  let ring = (size / 2 - core - 12) / 7;
  let segments = useMemo(
    () => buildSunburstSegments(root, 7, Math.max(root.size * 0.001, 1)),
    [root],
  );

  return (
    <section className="sunburst-card">
      <div className="summary-head">
        <h2>Disk Map</h2>
        <span>Click a directory segment to focus</span>
      </div>
      <div className="sunburst-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} className="sunburst" role="group" aria-label="Disk usage sunburst">
          <circle cx={cx} cy={cy} r={core - 10} fill="#0f1626" stroke="#243253" strokeWidth="1" />
          <text x={cx} y={cy - 6} textAnchor="middle" className="sunburst-label-main">
            {root.name || "/"}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="sunburst-label-sub">
            {formatBytes(root.size)}
          </text>
          {segments.map((segment, index) => {
            let inner = core + (segment.depth - 1) * ring;
            let outer = inner + ring - 2;
            let path = ringSegmentPath(
              cx,
              cy,
              inner,
              outer,
              segment.startAngle,
              segment.endAngle,
            );
            let clickable = segment.node.is_dir;
            return (
              <path
                key={`${segment.node.path}-${index}`}
                d={path}
                fill={segmentColor(segment.depth, index)}
                className={`sunburst-segment ${clickable ? "clickable" : ""}`}
                tabIndex={0}
                role={clickable ? "button" : "img"}
                aria-label={`${segment.node.path}: ${formatBytes(segment.node.size)}${clickable ? ", focus directory" : ""}`}
                onFocus={() => setHovered(segment)}
                onBlur={() => setHovered(null)}
                onKeyDown={(event) => {
                  if (clickable && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onFocusDirectory(segment.node.path);
                  }
                }}
                onMouseEnter={() => setHovered(segment)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  if (clickable) onFocusDirectory(segment.node.path);
                }}
              />
            );
          })}
        </svg>
        <div className="sunburst-tooltip">
          {hovered ? (
            <>
              <div className="tooltip-title">{hovered.node.path}</div>
              <div>{formatBytes(hovered.node.size)}</div>
              <div>{((hovered.node.size / root.size) * 100).toFixed(2)}% of total</div>
              <div>{((hovered.node.size / hovered.parentSize) * 100).toFixed(2)}% of parent</div>
            </>
          ) : (
            <div>Hover segments for details</div>
          )}
        </div>
      </div>
    </section>
  );
}
