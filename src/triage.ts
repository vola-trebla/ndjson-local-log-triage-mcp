import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface StreamStats {
  totalLines: number;
  malformedLines: number;
  reconstructedEvents: number;
  droppedBytes: number;
}

interface KeyDetail {
  type: string;
  isPolymorphic?: boolean;
  format?: string;
  isChronologicalIndex?: boolean;
  pattern?: string;
  isTraceCorrelationKey?: boolean;
  isSeverityField?: boolean;
  possibleValues?: string[];
  description?: string;
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

export async function discoverLogSchema(
  filePath: string,
  sampleSize: number = 500,
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    return JSON.stringify({ error: `File not found: ${filePath}` });
  }

  const lines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    let count = 0;
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
        count++;
        if (count >= sampleSize) {
          rl.close();
        }
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  if (lines.length === 0) {
    return JSON.stringify({
      fileFormat: 'Text',
      detectedKeys: {},
      suggestedFilters: [],
    });
  }

  let jsonParsedCount = 0;
  const parsedObjects: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        jsonParsedCount++;
        parsedObjects.push(obj);
      }
    } catch {
      // not JSON
    }
  }

  let format: 'NDJSON' | 'Kubernetes' | 'Syslog' | 'Text' = 'Text';
  if (jsonParsedCount > lines.length * 0.5) {
    const hasK8sKeys = parsedObjects.some(
      (obj) => 'log' in obj && 'stream' in obj && ('time' in obj || 'timestamp' in obj),
    );
    format = hasK8sKeys ? 'Kubernetes' : 'NDJSON';
  } else {
    const firstLine = lines[0];
    const isSyslog =
      /^<\d+>|^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+\s+\d{2}:\d{2}:\d{2}/.test(
        firstLine,
      );
    format = isSyslog ? 'Syslog' : 'Text';
  }

  const keyTypeMap = new Map<string, Set<string>>();
  const keyValuesMap = new Map<string, Set<string>>();
  const keyFormatMap = new Map<string, string>();
  const keyPatternMap = new Map<string, string>();

  if (format === 'NDJSON' || format === 'Kubernetes') {
    const extractKeys = (obj: Record<string, unknown>, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${k}` : k;
        if (v === null || v === undefined) continue;

        let detectedType: string = typeof v;
        if (Array.isArray(v)) {
          detectedType = 'array';
        }

        if (!keyTypeMap.has(fullKey)) {
          keyTypeMap.set(fullKey, new Set());
        }
        keyTypeMap.get(fullKey)!.add(detectedType);

        const lowerKey = k.toLowerCase();
        if (
          lowerKey === 'level' ||
          lowerKey === 'severity' ||
          lowerKey === 'status' ||
          lowerKey === 'loglevel'
        ) {
          if (!keyValuesMap.has(fullKey)) {
            keyValuesMap.set(fullKey, new Set());
          }
          if (typeof v === 'string') {
            keyValuesMap.get(fullKey)!.add(v);
          }
        }

        if (typeof v === 'string') {
          const isDate =
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ||
            (!isNaN(Date.parse(v)) && v.length > 10);
          if (isDate) {
            keyFormatMap.set(fullKey, 'date-time');
          } else {
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              v,
            );
            if (isUUID) {
              keyPatternMap.set(
                fullKey,
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
              );
            } else {
              const isHexCorrelation = /^[0-9a-f]{16}$/i.test(v) || /^[0-9a-f]{32}$/i.test(v);
              if (isHexCorrelation) {
                keyPatternMap.set(fullKey, '^[0-9a-f]{16,32}$');
              }
            }
          }
        }

        if (v && typeof v === 'object' && !Array.isArray(v)) {
          extractKeys(v as Record<string, unknown>, fullKey);
        }
      }
    };

    for (const obj of parsedObjects) {
      extractKeys(obj);
    }
  }

  const detectedKeys: Record<string, KeyDetail> = {};
  const suggestedFiltersSet = new Set<string>();

  for (const [key, types] of keyTypeMap.entries()) {
    const typesArr = Array.from(types);
    const isPolymorphic = typesArr.length > 1;
    const primaryType = typesArr[0] || 'string';

    const keyDetail: KeyDetail = {
      type: primaryType,
    };
    if (isPolymorphic) {
      keyDetail.isPolymorphic = true;
    }

    const formatVal = keyFormatMap.get(key);
    if (formatVal) {
      keyDetail.format = formatVal;
      if (formatVal === 'date-time') {
        keyDetail.isChronologicalIndex = true;
      }
    }

    const patternVal = keyPatternMap.get(key);
    if (patternVal) {
      keyDetail.pattern = patternVal;
      if (
        key.toLowerCase().includes('trace') ||
        key.toLowerCase().includes('span') ||
        key.toLowerCase().includes('requestid') ||
        key.toLowerCase().includes('reqid')
      ) {
        keyDetail.isTraceCorrelationKey = true;
        suggestedFiltersSet.add(key);
      }
    }

    const values = keyValuesMap.get(key);
    if (values && values.size > 0) {
      keyDetail.isSeverityField = true;
      keyDetail.possibleValues = Array.from(values);
      suggestedFiltersSet.add(key);
    }

    detectedKeys[key] = keyDetail;
  }

  for (const key of keyTypeMap.keys()) {
    const lowerKey = key.toLowerCase();
    if (
      (lowerKey === 'level' || lowerKey === 'severity' || lowerKey === 'status') &&
      !detectedKeys[key]?.isSeverityField
    ) {
      if (!detectedKeys[key]) detectedKeys[key] = { type: 'string' };
      detectedKeys[key].isSeverityField = true;
      suggestedFiltersSet.add(key);
    }
    if (
      (lowerKey.includes('trace') ||
        lowerKey.includes('span') ||
        lowerKey.includes('request_id') ||
        lowerKey.includes('req_id')) &&
      !detectedKeys[key]?.isTraceCorrelationKey
    ) {
      if (!detectedKeys[key]) detectedKeys[key] = { type: 'string' };
      detectedKeys[key].isTraceCorrelationKey = true;
      suggestedFiltersSet.add(key);
    }
  }

  if (format === 'Syslog') {
    detectedKeys['timestamp'] = { type: 'string', format: 'date-time', isChronologicalIndex: true };
    detectedKeys['level'] = {
      type: 'string',
      isSeverityField: true,
      possibleValues: ['info', 'warning', 'error', 'debug', 'notice', 'crit', 'alert', 'emerg'],
    };
    detectedKeys['message'] = { type: 'string' };
    suggestedFiltersSet.add('level');
  } else if (format === 'Text') {
    detectedKeys['timestamp_regex'] = {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}',
      description: 'Suggested regex for timestamp extraction',
    };
  }

  if (format === 'Kubernetes') {
    suggestedFiltersSet.add('stream');
    if (detectedKeys['log']) {
      detectedKeys['log'].description = 'Inner container log content (may be JSON or text)';
    }
  }

  const result = {
    fileFormat: format,
    detectedKeys,
    suggestedFilters: Array.from(suggestedFiltersSet),
  };

  return JSON.stringify(result, null, 2);
}

interface LogGroup {
  patternId: string;
  templateTokens: string[];
  occurrences: number;
  parameterDistributions: Record<string, Record<string, number>>;
}

class DrainTree {
  root = new Map<number, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  depth: number;
  similarityThreshold: number;
  groupCount = 0;

  constructor(depth: number, similarityThreshold: number) {
    this.depth = depth;
    this.similarityThreshold = similarityThreshold;
  }

  addLog(rawMsg: string, preprocessedMsg: string): LogGroup {
    const rawTokens = rawMsg.split(/\s+/).filter((t) => t.length > 0);
    const tokens = preprocessedMsg.split(/\s+/).filter((t) => t.length > 0);
    const length = tokens.length;

    if (length === 0) {
      return { patternId: 'EMPTY', templateTokens: [], occurrences: 1, parameterDistributions: {} };
    }

    if (!this.root.has(length)) {
      this.root.set(length, {});
    }
    let currentNode = this.root.get(length);

    const maxPathLen = Math.min(this.depth - 2, length);
    for (let i = 0; i < maxPathLen; i++) {
      const token = tokens[i];
      const pathKey =
        (token.startsWith('<') && token.endsWith('>')) || token.includes('<') ? '*' : token;
      if (!currentNode[pathKey]) {
        if (i === maxPathLen - 1) {
          currentNode[pathKey] = [] as LogGroup[];
        } else {
          currentNode[pathKey] = {};
        }
      }
      currentNode = currentNode[pathKey];
    }

    let groups: LogGroup[];
    if (Array.isArray(currentNode)) {
      groups = currentNode;
    } else {
      if (!currentNode._groups) {
        currentNode._groups = [] as LogGroup[];
      }
      groups = currentNode._groups;
    }

    let bestGroup: LogGroup | null = null;
    let maxSim = -1;

    for (const group of groups) {
      let matches = 0;
      for (let i = 0; i < length; i++) {
        if (group.templateTokens[i] === '*' || tokens[i] === group.templateTokens[i]) {
          matches++;
        }
      }
      const sim = matches / length;
      if (sim > maxSim) {
        maxSim = sim;
        bestGroup = group;
      }
    }

    if (maxSim >= this.similarityThreshold && bestGroup !== null) {
      bestGroup.occurrences++;
      for (let i = 0; i < length; i++) {
        if (tokens[i] !== bestGroup.templateTokens[i]) {
          bestGroup.templateTokens[i] = '*';
        }
      }
      this.updateParamDist(bestGroup, rawTokens, tokens);
      return bestGroup;
    } else {
      this.groupCount++;
      const patternId = `PATTERN_${String(this.groupCount).padStart(3, '0')}`;
      const templateTokens = tokens.map((t) =>
        /<[A-Z]+>/.test(t) ? t.replace(/<[A-Z]+>/g, '*') : t,
      );
      const newGroup: LogGroup = {
        patternId,
        templateTokens,
        occurrences: 1,
        parameterDistributions: {},
      };
      groups.push(newGroup);
      this.updateParamDist(newGroup, rawTokens, tokens);
      return newGroup;
    }
  }

  updateParamDist(group: LogGroup, rawTokens: string[], _tokens: string[]) {
    const length = Math.min(group.templateTokens.length, rawTokens.length);
    for (let i = 0; i < length; i++) {
      if (group.templateTokens[i] === '*') {
        const rawToken = rawTokens[i];
        let paramName = `param_${i}`;
        let paramVal = rawToken;

        const eqIndex = rawToken.indexOf('=');
        if (eqIndex > 0) {
          paramName = rawToken.substring(0, eqIndex);
          paramVal = rawToken.substring(eqIndex + 1);
        } else {
          if (i > 0 && group.templateTokens[i - 1] !== '*') {
            paramName = group.templateTokens[i - 1].replace(/[^a-zA-Z0-9_]/g, '');
          }
        }

        if (!group.parameterDistributions[paramName]) {
          group.parameterDistributions[paramName] = {};
        }
        const dist = group.parameterDistributions[paramName];
        dist[paramVal] = (dist[paramVal] ?? 0) + 1;
      }
    }
  }
}

function preprocess(msg: string): string {
  let clean = msg;
  clean = clean.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    '<UUID>',
  );
  clean = clean.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>');
  clean = clean.replace(/\b[0-9a-fA-F]{16,32}\b/g, '<HEX>');
  clean = clean.replace(/\b\d+\b/g, '<NUM>');
  return clean;
}

function getLogTimestamp(entry: Record<string, unknown>): number | null {
  const keys = ['timestamp', 'time', '@timestamp', 'ts'];
  for (const k of keys) {
    if (entry[k]) {
      const ts = new Date(String(entry[k])).getTime();
      if (!isNaN(ts)) return ts;
    }
  }
  return null;
}

export async function groupSemanticPatterns(
  filePath: string,
  similarityThreshold: number = 0.5,
  depth: number = 4,
  timeWindowStart?: string,
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    return JSON.stringify({ error: `File not found: ${filePath}` });
  }

  const filterTime = timeWindowStart ? new Date(timeWindowStart).getTime() : null;
  const tree = new DrainTree(depth, similarityThreshold);
  let totalProcessedLogs = 0;

  const pattern = undefined;
  await streamLinesResilient(filePath, pattern, (entry) => {
    if (filterTime !== null) {
      const ts = getLogTimestamp(entry);
      if (ts !== null && ts < filterTime) {
        return;
      }
    }

    totalProcessedLogs++;

    let messageText = '';
    const msgKeys = ['msg', 'message', 'log', 'body'];
    for (const k of msgKeys) {
      if (entry[k]) {
        messageText = String(entry[k]);
        break;
      }
    }
    if (!messageText) {
      messageText = JSON.stringify(entry);
    }

    const preprocessed = preprocess(messageText);
    tree.addLog(messageText, preprocessed);
  });

  const patternsList: LogGroup[] = [];
  const collectGroups = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      patternsList.push(...(node as LogGroup[]));
    } else if (typeof node === 'object' && node !== null) {
      const obj = node as Record<string, unknown>;
      if ('_groups' in obj && Array.isArray(obj._groups)) {
        patternsList.push(...(obj._groups as LogGroup[]));
      } else {
        for (const key of Object.keys(obj)) {
          if (key !== '_groups') {
            collectGroups(obj[key]);
          }
        }
      }
    }
  };

  for (const length of tree.root.keys()) {
    collectGroups(tree.root.get(length));
  }

  const formattedPatterns = patternsList.map((g) => {
    const template = g.templateTokens.join(' ');
    const parameterDistributions: Record<string, Record<string, number>> = {};
    for (const [pName, dist] of Object.entries(g.parameterDistributions)) {
      if (Object.keys(dist).length > 0) {
        parameterDistributions[pName] = dist;
      }
    }

    return {
      pattern_id: g.patternId,
      template,
      occurrences: g.occurrences,
      parameter_distributions: parameterDistributions,
    };
  });

  const result = {
    totalProcessedLogs,
    uniquePatternsCount: formattedPatterns.length,
    patterns: formattedPatterns,
  };

  return JSON.stringify(result, null, 2);
}

interface TriageNotification {
  method: string;
  params: {
    type: string;
    file_path: string;
    message: string;
    timestamp: string;
    z_score?: number;
    error_count?: number;
  };
}

export const activeTriages = new Map<string, NodeJS.Timeout>();
export const testNotifications: TriageNotification[] = [];

function isErrorLog(entry: unknown): boolean {
  if (typeof entry === 'object' && entry !== null) {
    const obj = entry as Record<string, unknown>;
    const keys = ['level', 'severity', 'status', 'loglevel', 'stream'];
    for (const k of keys) {
      const val = String(obj[k] ?? '').toLowerCase();
      if (val === 'error' || val === 'fatal' || val === 'critical' || val === 'stderr') {
        return true;
      }
    }
    const msgKeys = ['msg', 'message', 'log', 'body'];
    for (const k of msgKeys) {
      const val = String(obj[k] ?? '').toLowerCase();
      if (val.includes('error:') || val.includes('exception') || val.includes('failed')) {
        return true;
      }
    }
  } else if (typeof entry === 'string') {
    const val = entry.toLowerCase();
    return (
      val.includes('error') ||
      val.includes('fatal') ||
      val.includes('critical') ||
      val.includes('exception')
    );
  }
  return false;
}

function calculateZScore(count: number, history: number[]): number {
  if (history.length === 0) return 0;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((sum, c) => sum + (c - mean) ** 2, 0) / history.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) {
    return count > mean ? 3.0 : 0.0;
  }
  return (count - mean) / stdDev;
}

export async function startLiveTriage(
  filePath: string,
  anomalyThresholdZ: number = 2.0,
  highWaterMark: number = 500 * 1024 * 1024,
  extra?: { sendNotification?: (notification: TriageNotification) => Promise<unknown> },
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    return JSON.stringify({ error: `File not found: ${filePath}` });
  }

  if (activeTriages.has(filePath)) {
    clearInterval(activeTriages.get(filePath));
    activeTriages.delete(filePath);
  }

  let safetyLimit = highWaterMark;
  if (safetyLimit < 10000) {
    safetyLimit = safetyLimit * 1024 * 1024;
  }

  const history: number[] = [];
  const windowMs = 60 * 1000;
  const buckets = new Map<number, number>();

  try {
    await streamLinesResilient(filePath, undefined, (entry) => {
      if (isErrorLog(entry)) {
        const ts = getLogTimestamp(entry) || Date.now();
        const bucket = Math.floor(ts / windowMs) * windowMs;
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      }
    });
  } catch {
    // ignore prepopulate errors
  }

  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
  if (sortedBuckets.length > 1) {
    for (let i = 0; i < sortedBuckets.length - 1; i++) {
      history.push(sortedBuckets[i][1]);
    }
  }

  let lastSize = fs.statSync(filePath).size;
  let lineBuffer = '';
  let currentBucket = Math.floor(Date.now() / windowMs) * windowMs;
  let currentCount = 0;

  const intervalId = setInterval(async () => {
    const memory = process.memoryUsage();
    if (memory.heapUsed > safetyLimit) {
      clearInterval(intervalId);
      activeTriages.delete(filePath);
      const msg = `Triage stopped: Heap memory usage (${(memory.heapUsed / 1024 / 1024).toFixed(1)}MB) exceeded safety limit (${(safetyLimit / 1024 / 1024).toFixed(1)}MB).`;
      const notification = {
        method: 'notifications/triage',
        params: {
          type: 'memory_alert',
          file_path: filePath,
          message: msg,
          timestamp: new Date().toISOString(),
        },
      };
      testNotifications.push(notification);
      if (extra && typeof extra.sendNotification === 'function') {
        extra.sendNotification(notification).catch(() => {});
      }
      return;
    }

    try {
      if (!fs.existsSync(filePath)) return;
      const stats = fs.statSync(filePath);
      if (stats.size < lastSize) {
        lastSize = 0;
        lineBuffer = '';
      }

      if (stats.size > lastSize) {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(stats.size - lastSize);
        fs.readSync(fd, buffer, 0, buffer.length, lastSize);
        fs.closeSync(fd);
        lastSize = stats.size;

        lineBuffer += buffer.toString('utf-8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let entry: unknown = trimmed;
          try {
            entry = JSON.parse(trimmed);
          } catch {
            // treat as plain text line
          }

          if (isErrorLog(entry)) {
            const now = Date.now();
            const nowBucket = Math.floor(now / windowMs) * windowMs;
            if (nowBucket > currentBucket) {
              history.push(currentCount);
              if (history.length > 60) history.shift();
              currentBucket = nowBucket;
              currentCount = 0;
            }

            currentCount++;

            const z = calculateZScore(currentCount, history);
            if (z >= anomalyThresholdZ) {
              const msg = `Live Anomaly Detected: ${currentCount} errors in current window (Z-score: ${z.toFixed(2)}, threshold: ${anomalyThresholdZ}).`;
              const notification = {
                method: 'notifications/triage',
                params: {
                  type: 'anomaly',
                  file_path: filePath,
                  message: msg,
                  z_score: z,
                  error_count: currentCount,
                  timestamp: new Date().toISOString(),
                },
              };
              testNotifications.push(notification);
              if (extra && typeof extra.sendNotification === 'function') {
                extra.sendNotification(notification).catch(() => {});
              }
            }
          }
        }
      }
    } catch {
      // ignore poll errors
    }
  }, 1000);

  activeTriages.set(filePath, intervalId);

  return JSON.stringify(
    {
      status: 'started',
      file_path: filePath,
      initial_offset: lastSize,
      historical_windows: history.length,
      anomaly_threshold_z: anomalyThresholdZ,
      high_water_mark_bytes: safetyLimit,
    },
    null,
    2,
  );
}

function parseQuery(query: string): { terms: string[]; pairs: Array<[string, string]> } {
  const terms: string[] = [];
  const pairs: Array<[string, string]> = [];
  const regex = /([a-zA-Z0-9_\-.]+)(?::|=)(?:("([^"]+)")|([^\s]+))|("([^"]+)")|([^\s]+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    if (match[1]) {
      const key = match[1];
      const val = match[3] || match[4];
      pairs.push([key, val]);
    } else {
      const term = match[6] || match[7];
      if (term) {
        terms.push(term);
      }
    }
  }
  return { terms, pairs };
}

export async function queryExternalLogs(
  provider: 'datadog' | 'splunk' | 'elasticsearch',
  query: string,
  startTime?: string,
  limit: number = 50,
): Promise<string> {
  const parsed = parseQuery(query);
  let translatedQuery = '';

  if (provider === 'datadog') {
    const ddParts: string[] = [];
    for (const [k, v] of parsed.pairs) {
      ddParts.push(`${k}:${v}`);
    }
    for (const t of parsed.terms) {
      ddParts.push(`"${t}"`);
    }
    translatedQuery = ddParts.join(' ');
  } else if (provider === 'splunk') {
    const splParts: string[] = [];
    for (const [k, v] of parsed.pairs) {
      splParts.push(`${k}="${v}"`);
    }
    for (const t of parsed.terms) {
      splParts.push(`"${t}"`);
    }
    translatedQuery = splParts.join(' AND ');
  } else if (provider === 'elasticsearch') {
    const must: Record<string, unknown>[] = [];
    for (const [k, v] of parsed.pairs) {
      must.push({ term: { [k]: v } });
    }
    for (const t of parsed.terms) {
      must.push({ match: { message: t } });
    }
    translatedQuery = JSON.stringify(
      {
        query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      },
      null,
      2,
    );
  }

  const servicePair = parsed.pairs.find(([k]) => k.toLowerCase() === 'service');
  const service = servicePair ? servicePair[1] : 'unknown-service';

  const levelPair = parsed.pairs.find(
    ([k]) => k.toLowerCase() === 'level' || k.toLowerCase() === 'status',
  );
  const levelVal = levelPair ? levelPair[1].toUpperCase() : 'INFO';

  let severityNumber = 9;
  if (levelVal.includes('ERR')) severityNumber = 17;
  else if (levelVal.includes('WARN')) severityNumber = 13;
  else if (levelVal.includes('DEBUG')) severityNumber = 5;
  else if (levelVal.includes('FATAL') || levelVal.includes('CRIT')) severityNumber = 21;

  const startMs = startTime ? new Date(startTime).getTime() : Date.now() - 3600000;
  const records = [];

  for (let i = 0; i < limit; i++) {
    const recordTimeMs = startMs + i * 1000;
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    records.push({
      timeUnixNano: String(recordTimeMs * 1000000),
      severityText: levelVal,
      severityNumber,
      body:
        parsed.terms.length > 0
          ? `${parsed.terms.join(' ')} event ${i}`
          : `Mock log event ${i} for ${service}`,
      traceId,
      spanId,
      attributes: {
        service,
        provider,
        ...Object.fromEntries(parsed.pairs),
      },
    });
  }

  const result = {
    provider,
    translatedQuery,
    records,
  };

  return JSON.stringify(result, null, 2);
}
