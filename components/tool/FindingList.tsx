"use client";

import type { Report } from "@/lib/metadata/types";

const ORDER = ["location", "identity", "device", "remnant", "time", "history", "software"] as const;

export default function FindingList({ report }: { report: Report }) {
  if (report.findings.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">
          <h2>Nothing found</h2>
          <span className="meta">{report.formatLabel}</span>
        </div>
        <p className="note" style={{ marginTop: 0 }}>
          This scan found nothing. That is not the same as the file being clean — see what was
          not inspected, below.
        </p>
      </div>
    );
  }

  const sorted = [...report.findings].sort(
    (a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group),
  );
  const critical = report.findings.filter((f) => f.severity === "critical").length;

  return (
    <div className="panel">
      <div className="panel-title">
        <h2>What this file discloses</h2>
        <span className="meta">
          {report.findings.length} findings · {critical} critical · Tier {report.tier}
        </span>
      </div>
      {sorted.map((f) => (
        <div className="row" key={f.id}>
          <span className={`dot ${f.severity}`} aria-hidden />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row-label">{f.label}</div>
            <div className="row-value">{f.value}</div>
            {f.range && f.range.end > f.range.start && (
              <div className="row-range">
                bytes {f.range.start.toLocaleString()}–{f.range.end.toLocaleString()}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
