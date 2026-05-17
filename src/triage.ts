import * as fs from "fs";
import * as readline from "readline";

export async function queryLogPattern(
  logFile: string,
  field: string,
  value: string,
  limit: number,
): Promise<string> {
  if (!fs.existsSync(logFile)) {
    return `Error: file not found: ${logFile}`;
  }

  const needle = value.toLowerCase();
  const matches: object[] = [];
  let totalLines = 0;
  let parseErrors = 0;

  await streamLines(logFile, (line) => {
    totalLines++;
    if (matches.length >= limit) return;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const fieldValue = String(entry[field] ?? "").toLowerCase();
      if (fieldValue.includes(needle)) {
        matches.push(entry);
      }
    } catch {
      parseErrors++;
    }
  });

  const lines = [
    `Log Query Results`,
    `  File:        ${logFile}`,
    `  Filter:      ${field} contains "${value}"`,
    `  Lines read:  ${totalLines}`,
    `  Matches:     ${matches.length}${matches.length >= limit ? ` (limit ${limit} reached)` : ""}`,
    parseErrors > 0 ? `  Parse errors: ${parseErrors}` : "",
    "",
  ].filter((l) => l !== "");

  if (matches.length === 0) {
    lines.push("  No matching entries found.");
  } else {
    lines.push("");
    for (const entry of matches) {
      lines.push(JSON.stringify(entry));
    }
  }

  return lines.join("\n");
}

export async function detectErrorAnomalies(
  logFile: string,
  timestampField: string,
  levelField: string,
  errorValues: string[],
  windowMinutes: number,
  zScoreThreshold: number,
): Promise<string> {
  if (!fs.existsSync(logFile)) {
    return `Error: file not found: ${logFile}`;
  }

  const errorSet = new Set(errorValues.map((v) => v.toLowerCase()));
  const windowMs = windowMinutes * 60 * 1000;
  const buckets = new Map<number, number>();
  let totalLines = 0;
  let skipped = 0;

  await streamLines(logFile, (line) => {
    totalLines++;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const level = String(entry[levelField] ?? "").toLowerCase();
      if (!errorSet.has(level)) return;
      const ts = parseTimestamp(entry[timestampField]);
      if (ts === null) {
        skipped++;
        return;
      }
      const bucket = Math.floor(ts / windowMs) * windowMs;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    } catch {
      skipped++;
    }
  });

  if (buckets.size === 0) {
    return [
      `Error Anomaly Detection`,
      `  File:       ${logFile}`,
      `  Lines read: ${totalLines}`,
      ``,
      `  No error entries with parseable timestamps found.`,
    ].join("\n");
  }

  const counts = Array.from(buckets.values());
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);

  const anomalies: Array<{ time: string; count: number; zScore: number }> = [];
  for (const [bucket, count] of buckets.entries()) {
    const zScore = stdDev > 0 ? (count - mean) / stdDev : 0;
    if (zScore >= zScoreThreshold) {
      anomalies.push({ time: new Date(bucket).toISOString(), count, zScore });
    }
  }

  anomalies.sort((a, b) => b.zScore - a.zScore);

  const lines = [
    `Error Anomaly Detection`,
    `  File:            ${logFile}`,
    `  Lines read:      ${totalLines}`,
    skipped > 0 ? `  Skipped:         ${skipped} (no timestamp / parse error)` : "",
    `  Window:          ${windowMinutes}min`,
    `  Z-score cutoff:  ${zScoreThreshold}`,
    `  Baseline:        mean=${mean.toFixed(1)} errors/window, stdDev=${stdDev.toFixed(1)}`,
    `  Anomalies found: ${anomalies.length}`,
    ``,
  ];

  if (anomalies.length === 0) {
    lines.push(`  No anomalous windows detected.`);
  } else {
    lines.push(`  Anomalous windows (z >= ${zScoreThreshold}):`);
    for (const a of anomalies) {
      lines.push(`  [z=${a.zScore.toFixed(2)}] ${a.time}  ${a.count} errors`);
    }
  }

  return lines.join("\n");
}

export async function summarizeLogTimeline(
  logFile: string,
  timestampField: string,
  levelField: string,
  windowMinutes: number,
): Promise<string> {
  if (!fs.existsSync(logFile)) {
    return `Error: file not found: ${logFile}`;
  }

  const windowMs = windowMinutes * 60 * 1000;

  type Bucket = { errors: number; warnings: number; info: number; other: number };
  const buckets = new Map<number, Bucket>();
  let totalLines = 0;
  let skipped = 0;

  await streamLines(logFile, (line) => {
    totalLines++;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const level = String(entry[levelField] ?? "").toLowerCase();
      const ts = parseTimestamp(entry[timestampField]);
      if (ts === null) {
        skipped++;
        return;
      }
      const key = Math.floor(ts / windowMs) * windowMs;
      if (!buckets.has(key)) {
        buckets.set(key, { errors: 0, warnings: 0, info: 0, other: 0 });
      }
      const b = buckets.get(key)!;
      if (level === "error" || level === "fatal" || level === "critical") b.errors++;
      else if (level === "warn" || level === "warning") b.warnings++;
      else if (level === "info") b.info++;
      else b.other++;
    } catch {
      skipped++;
    }
  });

  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

  const errorCounts = Array.from(buckets.values()).map((b) => b.errors);
  const meanErrors =
    errorCounts.length > 0 ? errorCounts.reduce((a, c) => a + c, 0) / errorCounts.length : 0;
  const errorVariance =
    errorCounts.length > 0
      ? errorCounts.reduce((sum, c) => sum + (c - meanErrors) ** 2, 0) / errorCounts.length
      : 0;
  const errorStdDev = Math.sqrt(errorVariance);
  const spikeThreshold = meanErrors + errorStdDev;

  const lines = [
    `Log Timeline Summary`,
    `  File:        ${logFile}`,
    `  Lines read:  ${totalLines}`,
    `  Window:      ${windowMinutes}min`,
    skipped > 0 ? `  Skipped:     ${skipped} (no timestamp / parse error)` : "",
    `  Buckets:     ${buckets.size}`,
    ``,
    `  Time (UTC)                 Errors  Warnings  Info  Other`,
    `  ─────────────────────────────────────────────────────────`,
  ].filter((l) => l !== "");

  for (const key of sortedKeys) {
    const b = buckets.get(key)!;
    const time = new Date(key).toISOString().replace("T", " ").replace(".000Z", "Z");
    const errorMark = b.errors > spikeThreshold ? " !" : "  ";
    lines.push(
      `${errorMark} ${time.padEnd(24)} ${String(b.errors).padStart(6)}  ${String(b.warnings).padStart(8)}  ${String(b.info).padStart(4)}  ${String(b.other).padStart(5)}`,
    );
  }

  return lines.join("\n");
}

async function streamLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

function parseTimestamp(value: unknown): number | null {
  if (!value) return null;
  const ts = new Date(String(value)).getTime();
  return isNaN(ts) ? null : ts;
}
