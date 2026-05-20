import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface StreamStats {
  totalLines: number;
  malformedLines: number;
  reconstructedEvents: number;
  droppedBytes: number;
}

async function streamLinesResilient(
  filePath: string,
  lineStartPattern: RegExp | undefined,
  onEntry: (entry: Record<string, unknown>) => void,
): Promise<StreamStats> {
  const stats: StreamStats = {
    totalLines: 0,
    malformedLines: 0,
    reconstructedEvents: 0,
    droppedBytes: 0,
  };
  let pendingEntry: Record<string, unknown> | null = null;
  const pendingContinuations: string[] = [];

  function flushPending() {
    if (pendingEntry === null) return;
    if (pendingContinuations.length > 0) {
      pendingEntry['stack_trace'] = pendingContinuations.join('\n');
      stats.reconstructedEvents++;
      pendingContinuations.length = 0;
    }
    onEntry(pendingEntry);
    pendingEntry = null;
  }

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on('line', (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      stats.totalLines++;

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (parsed !== null) {
        flushPending();
        pendingEntry = parsed;
      } else if (lineStartPattern !== undefined) {
        if (lineStartPattern.test(line)) {
          // Matches start pattern but invalid JSON — genuinely malformed event start
          flushPending();
          stats.malformedLines++;
        } else {
          // Continuation line (stack trace, log continuation)
          if (pendingEntry !== null) {
            pendingContinuations.push(line);
          } else {
            stats.droppedBytes += line.length;
            stats.malformedLines++;
          }
        }
      } else {
        stats.malformedLines++;
      }
    });
    rl.on('close', () => {
      flushPending();
      resolve();
    });
    rl.on('error', reject);
  });

  return stats;
}

function formatParseStats(stats: StreamStats): string[] {
  const lines: string[] = [];
  if (stats.malformedLines > 0) {
    const rate =
      stats.totalLines > 0 ? ((stats.malformedLines / stats.totalLines) * 100).toFixed(1) : '0.0';
    lines.push(`  Parse error rate: ${rate}% (${stats.malformedLines} malformed lines)`);
  }
  if (stats.reconstructedEvents > 0) {
    lines.push(`  Reconstructed events: ${stats.reconstructedEvents}`);
  }
  if (stats.droppedBytes > 0) {
    lines.push(`  Dropped bytes: ${stats.droppedBytes}`);
  }
  return lines;
}

export async function queryLogPattern(
  logFile: string,
  field: string,
  value: string,
  limit: number,
  lineStartPattern?: string,
): Promise<string> {
  if (!fs.existsSync(logFile)) {
    return `Error: file not found: ${logFile}`;
  }

  const pattern = lineStartPattern ? new RegExp(lineStartPattern) : undefined;
  const needle = value.toLowerCase();
  const matches: Record<string, unknown>[] = [];

  const stats = await streamLinesResilient(logFile, pattern, (entry) => {
    if (matches.length >= limit) return;
    const fieldValue = String(entry[field] ?? '').toLowerCase();
    if (fieldValue.includes(needle)) {
      matches.push(entry);
    }
  });

  const lines = [
    `Log Query Results`,
    `  File:        ${logFile}`,
    `  Filter:      ${field} contains "${value}"`,
    `  Lines read:  ${stats.totalLines}`,
    `  Matches:     ${matches.length}${matches.length >= limit ? ` (limit ${limit} reached)` : ''}`,
    ...formatParseStats(stats),
  ].filter((l) => l !== '');

  if (matches.length === 0) {
    lines.push('  No matching entries found.');
  } else {
    lines.push('');
    for (const entry of matches) {
      lines.push(JSON.stringify(entry));
    }
  }

  return lines.join('\n');
}

export async function detectErrorAnomalies(
  logFile: string,
  timestampField: string,
  levelField: string,
  errorValues: string[],
  windowMinutes: number,
  zScoreThreshold: number,
  lineStartPattern?: string,
): Promise<string> {
  if (!fs.existsSync(logFile)) {
    return `Error: file not found: ${logFile}`;
  }

  const pattern = lineStartPattern ? new RegExp(lineStartPattern) : undefined;
  const errorSet = new Set(errorValues.map((v) => v.toLowerCase()));
  const windowMs = windowMinutes * 60 * 1000;
  const buckets = new Map<number, number>();
  let skipped = 0;

  const stats = await streamLinesResilient(logFile, pattern, (entry) => {
    const level = String(entry[levelField] ?? '').toLowerCase();
    if (!errorSet.has(level)) return;
    const ts = parseTimestamp(entry[timestampField]);
    if (ts === null) {
      skipped++;
      return;
    }
    const bucket = Math.floor(ts / windowMs) * windowMs;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  });

  if (buckets.size === 0) {
    return [
      `Error Anomaly Detection`,
      `  File:       ${logFile}`,
      `  Lines read: ${stats.totalLines}`,
      ...formatParseStats(stats),
      ``,
      `  No error entries with parseable timestamps found.`,
    ].join('\n');
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
    `  Lines read:      ${stats.totalLines}`,
    skipped > 0 ? `  Skipped:         ${skipped} (no timestamp)` : '',
    ...formatParseStats(stats),
    `  Window:          ${windowMinutes}min`,
    `  Z-score cutoff:  ${zScoreThreshold}`,
    `  Baseline:        mean=${mean.toFixed(1)} errors/window, stdDev=${stdDev.toFixed(1)}`,
    `  Anomalies found: ${anomalies.length}`,
    ``,
  ].filter((l) => l !== '');

  if (anomalies.length === 0) {
    lines.push(`  No anomalous windows detected.`);
  } else {
    lines.push(`  Anomalous windows (z >= ${zScoreThreshold}):`);
    for (const a of anomalies) {
      lines.push(`  [z=${a.zScore.toFixed(2)}] ${a.time}  ${a.count} errors`);
    }
  }

  return lines.join('\n');
}

export async function summarizeLogTimeline(
  logFile: string,
  timestampField: string,
  levelField: string,
  windowMinutes: number,
  lineStartPattern?: string,
  adaptive?: boolean,
): Promise<string> {
  if (!fs.existsSync(logFile)) {
    return `Error: file not found: ${logFile}`;
  }

  const pattern = lineStartPattern ? new RegExp(lineStartPattern) : undefined;

  type Bucket = { errors: number; warnings: number; info: number; other: number };

  async function buildBuckets(
    bucketMs: number,
    timeFilter?: { start: number; end: number },
  ): Promise<{ buckets: Map<number, Bucket>; skipped: number; stats: StreamStats }> {
    const buckets = new Map<number, Bucket>();
    let skipped = 0;
    const stats = await streamLinesResilient(logFile, pattern, (entry) => {
      const level = String(entry[levelField] ?? '').toLowerCase();
      const ts = parseTimestamp(entry[timestampField]);
      if (ts === null) {
        skipped++;
        return;
      }
      if (timeFilter && (ts < timeFilter.start || ts >= timeFilter.end)) return;
      const key = Math.floor(ts / bucketMs) * bucketMs;
      if (!buckets.has(key)) buckets.set(key, { errors: 0, warnings: 0, info: 0, other: 0 });
      const b = buckets.get(key)!;
      if (level === 'error' || level === 'fatal' || level === 'critical') b.errors++;
      else if (level === 'warn' || level === 'warning') b.warnings++;
      else if (level === 'info') b.info++;
      else b.other++;
    });
    return { buckets, skipped, stats };
  }

  // Determine bucket size
  let bucketMs = windowMinutes * 60 * 1000;
  let granularityChosen: 'ms' | 's' | 'min' = 'min';
  let densityEventsPerSec = 0;

  if (adaptive) {
    const sampleTs: number[] = [];
    await streamLinesResilient(logFile, pattern, (entry) => {
      if (sampleTs.length >= 1000) return;
      const ts = parseTimestamp(entry[timestampField]);
      if (ts !== null) sampleTs.push(ts);
    });

    if (sampleTs.length >= 2) {
      sampleTs.sort((a, b) => a - b);
      const range = sampleTs[sampleTs.length - 1] - sampleTs[0];
      const meanIat = range / (sampleTs.length - 1);
      densityEventsPerSec = meanIat > 0 ? Math.round(1000 / meanIat) : 0;
      if (meanIat < 10) {
        granularityChosen = 'ms';
        bucketMs = 100;
      } else if (meanIat < 1000) {
        granularityChosen = 's';
        bucketMs = 1000;
      }
    }
  }

  const { buckets, skipped, stats } = await buildBuckets(bucketMs);
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

  const windowLabel = adaptive
    ? `${bucketMs}ms (auto: ${granularityChosen})`
    : `${windowMinutes}min`;

  const lines = [
    `Log Timeline Summary`,
    `  File:        ${logFile}`,
    `  Lines read:  ${stats.totalLines}`,
    `  Window:      ${windowLabel}`,
    adaptive ? `  Granularity: ${granularityChosen}` : '',
    adaptive && densityEventsPerSec > 0 ? `  Density:     ${densityEventsPerSec} events/sec` : '',
    skipped > 0 ? `  Skipped:     ${skipped} (no timestamp)` : '',
    ...formatParseStats(stats),
    `  Buckets:     ${buckets.size}`,
    ``,
    `  Time (UTC)                 Errors  Warnings  Info  Other`,
    `  ─────────────────────────────────────────────────────────`,
  ].filter((l) => l !== '');

  for (const key of sortedKeys) {
    const b = buckets.get(key)!;
    const time = new Date(key).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    const errorMark = b.errors > spikeThreshold ? ' !' : '  ';
    lines.push(
      `${errorMark} ${time.padEnd(24)} ${String(b.errors).padStart(6)}  ${String(b.warnings).padStart(8)}  ${String(b.info).padStart(4)}  ${String(b.other).padStart(5)}`,
    );
  }

  // Zoom pass: re-scan peak error bucket at 10x finer resolution
  if (adaptive && sortedKeys.length > 0) {
    const peakKey = sortedKeys.reduce(
      (pk, k) => (buckets.get(k)!.errors > buckets.get(pk)!.errors ? k : pk),
      sortedKeys[0],
    );
    if (buckets.get(peakKey)!.errors > 0) {
      const zoomBucketMs = Math.max(1, Math.floor(bucketMs / 10));
      const { buckets: zoomBuckets } = await buildBuckets(zoomBucketMs, {
        start: peakKey,
        end: peakKey + bucketMs,
      });
      const zoomKeys = Array.from(zoomBuckets.keys()).sort((a, b) => a - b);
      if (zoomKeys.length > 0) {
        lines.push('');
        lines.push(
          `  Zoomed burst (${new Date(peakKey).toISOString()} window, ${zoomBucketMs}ms buckets):`,
        );
        lines.push(`  ${'─'.repeat(57)}`);
        for (const key of zoomKeys) {
          const b = zoomBuckets.get(key)!;
          const time = new Date(key).toISOString().replace('T', ' ').replace('.000Z', 'Z');
          lines.push(
            `   ${time.padEnd(24)} ${String(b.errors).padStart(6)}  ${String(b.warnings).padStart(8)}  ${String(b.info).padStart(4)}  ${String(b.other).padStart(5)}`,
          );
        }
      }
    }
  }

  return lines.join('\n');
}

export interface CorrelateRequestParams {
  logFiles: string[];
  traceId: string;
  idField: string;
  serviceField: string;
  timestampField: string;
  lineStartPattern?: string;
}

export async function correlateRequest(params: CorrelateRequestParams): Promise<string> {
  const { logFiles, traceId, idField, serviceField, timestampField, lineStartPattern } = params;
  const pattern = lineStartPattern ? new RegExp(lineStartPattern) : undefined;

  interface CorrelatedEvent {
    ts: number;
    time: string;
    service: string;
    raw: Record<string, unknown>;
  }

  const events: CorrelatedEvent[] = [];
  const services = new Set<string>();
  const warnings: string[] = [];
  let filesScanned = 0;

  for (const logFile of logFiles) {
    if (!fs.existsSync(logFile)) {
      warnings.push(`file not found: ${logFile}`);
      continue;
    }
    filesScanned++;
    const fileName = path.basename(logFile);

    await streamLinesResilient(logFile, pattern, (entry) => {
      if (String(entry[idField] ?? '') !== traceId) return;
      const ts = parseTimestamp(entry[timestampField]);
      const service = String(entry[serviceField] ?? '');
      if (service) services.add(service);
      events.push({
        ts: ts ?? 0,
        time: ts ? new Date(ts).toISOString() : '(no timestamp)',
        service,
        raw: { ...entry, _file: fileName },
      });
    });
  }

  events.sort((a, b) => a.ts - b.ts);

  const durationMs = events.length >= 2 ? events[events.length - 1].ts - events[0].ts : 0;

  const lines = [
    `Request Correlation`,
    `  Trace ID:          ${traceId}`,
    `  Files scanned:     ${filesScanned}`,
    `  Events found:      ${events.length}`,
  ];
  if (services.size > 0) {
    lines.push(`  Services involved: ${Array.from(services).sort().join(', ')}`);
  }
  if (events.length >= 2) {
    lines.push(`  Duration:          ${durationMs}ms`);
  }
  for (const w of warnings) {
    lines.push(`  Warning:           ${w}`);
  }

  if (events.length === 0) {
    lines.push('');
    lines.push('  No matching events found.');
  } else {
    lines.push('');
    for (const ev of events) {
      const svc = ev.service ? ev.service.padEnd(12) : '            ';
      lines.push(`[${ev.time}] ${svc}  ${JSON.stringify(ev.raw)}`);
    }
  }

  return lines.join('\n');
}

function parseTimestamp(value: unknown): number | null {
  if (!value) return null;
  const ts = new Date(String(value)).getTime();
  return isNaN(ts) ? null : ts;
}
