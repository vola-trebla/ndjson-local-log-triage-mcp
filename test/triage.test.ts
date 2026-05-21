import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  queryLogPattern,
  detectErrorAnomalies,
  summarizeLogTimeline,
  correlateRequest,
  discoverLogSchema,
  groupSemanticPatterns,
  startLiveTriage,
  queryExternalLogs,
  activeTriages,
  testNotifications,
} from '../src/triage.js';

let logDir: string;
let logFile: string;
let multilineFile: string;
let traceFile1: string;
let traceFile2: string;

function makeEntry(level: string, timestamp: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp, level, msg: 'test entry', ...extra });
}

beforeAll(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-mcp-test-'));
  logFile = path.join(logDir, 'app.log.ndjson');

  const lines: string[] = [
    // 03:00 window — 1 error
    makeEntry('info', '2025-01-15T03:00:10Z', { service: 'auth' }),
    makeEntry('info', '2025-01-15T03:00:20Z', { service: 'api' }),
    makeEntry('error', '2025-01-15T03:01:00Z', { service: 'auth' }),
    makeEntry('warn', '2025-01-15T03:02:00Z', { service: 'auth' }),
    // 03:05 window — 1 error
    makeEntry('info', '2025-01-15T03:05:30Z', { service: 'api' }),
    makeEntry('error', '2025-01-15T03:06:00Z', { service: 'db' }),
    // 03:10 window — 1 error
    makeEntry('info', '2025-01-15T03:10:00Z', { service: 'auth' }),
    makeEntry('error', '2025-01-15T03:11:00Z', { service: 'auth' }),
    makeEntry('warn', '2025-01-15T03:12:00Z', { service: 'api' }),
    // 03:15 window — 8 errors (spike)
    makeEntry('error', '2025-01-15T03:15:00Z', { service: 'auth' }),
    makeEntry('error', '2025-01-15T03:15:10Z', { service: 'auth' }),
    makeEntry('error', '2025-01-15T03:15:20Z', { service: 'auth' }),
    makeEntry('error', '2025-01-15T03:15:30Z', { service: 'auth' }),
    makeEntry('error', '2025-01-15T03:15:40Z', { service: 'db' }),
    makeEntry('error', '2025-01-15T03:15:50Z', { service: 'db' }),
    makeEntry('fatal', '2025-01-15T03:16:00Z', { service: 'auth' }),
    makeEntry('critical', '2025-01-15T03:16:10Z', { service: 'auth' }),
    // 03:20 window — 1 error
    makeEntry('info', '2025-01-15T03:20:00Z', { service: 'api' }),
    makeEntry('error', '2025-01-15T03:21:00Z', { service: 'api' }),
    // invalid line
    'not-valid-json',
    // entry without timestamp
    JSON.stringify({ level: 'error', msg: 'no timestamp' }),
  ];

  fs.writeFileSync(logFile, lines.join('\n') + '\n');

  multilineFile = path.join(logDir, 'multiline.ndjson');
  fs.writeFileSync(
    multilineFile,
    [
      JSON.stringify({ timestamp: '2025-01-15T03:00:00Z', level: 'error', msg: 'DB failed' }),
      'java.lang.RuntimeException: Connection refused',
      '  at com.example.DbPool.connect(DbPool.java:42)',
      '  at com.example.App.main(App.java:15)',
      JSON.stringify({ timestamp: '2025-01-15T03:01:00Z', level: 'info', msg: 'Reconnecting' }),
      JSON.stringify({ timestamp: '2025-01-15T03:02:00Z', level: 'error', msg: 'Failed again' }),
      'Caused by: timeout after 30s',
    ].join('\n') + '\n',
  );

  // Two service log files with interleaved events, some sharing trace_id "req-abc"
  traceFile1 = path.join(logDir, 'svc-auth.ndjson');
  fs.writeFileSync(
    traceFile1,
    [
      JSON.stringify({
        timestamp: '2025-01-15T03:15:00.100Z',
        level: 'info',
        service: 'auth',
        trace_id: 'req-abc',
        msg: 'validate token',
      }),
      JSON.stringify({
        timestamp: '2025-01-15T03:15:00.300Z',
        level: 'error',
        service: 'auth',
        trace_id: 'req-abc',
        msg: 'token expired',
      }),
      JSON.stringify({
        timestamp: '2025-01-15T03:15:00.050Z',
        level: 'info',
        service: 'auth',
        trace_id: 'req-other',
        msg: 'unrelated',
      }),
    ].join('\n') + '\n',
  );

  traceFile2 = path.join(logDir, 'svc-api.ndjson');
  fs.writeFileSync(
    traceFile2,
    [
      JSON.stringify({
        timestamp: '2025-01-15T03:15:00.000Z',
        level: 'info',
        service: 'api',
        trace_id: 'req-abc',
        msg: 'incoming request',
      }),
      JSON.stringify({
        timestamp: '2025-01-15T03:15:00.400Z',
        level: 'info',
        service: 'api',
        trace_id: 'req-abc',
        msg: 'returning 401',
      }),
    ].join('\n') + '\n',
  );
});

afterAll(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('queryLogPattern', () => {
  it('returns matching entries by field value', async () => {
    const result = await queryLogPattern(logFile, 'service', 'auth', 100);
    expect(result).toContain('service');
    // auth entries: 03:00:10, 03:01:00, 03:02:00, 03:10:00, 03:11:00, 03:15:00-03:16:10
    const matches = result.match(/"service":"auth"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(5);
  });

  it('respects limit', async () => {
    const result = await queryLogPattern(logFile, 'level', 'info', 2);
    expect(result).toContain('limit 2 reached');
    const parsed = result
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l));
    expect(parsed.length).toBe(2);
  });

  it('returns no matches message when nothing found', async () => {
    const result = await queryLogPattern(logFile, 'service', 'nonexistent-xyz', 50);
    expect(result).toContain('No matching entries found');
  });

  it('handles missing file gracefully', async () => {
    const result = await queryLogPattern('/tmp/does-not-exist.ndjson', 'level', 'error', 10);
    expect(result).toContain('Error: file not found');
  });
});

describe('detectErrorAnomalies', () => {
  it('detects the spike window at 03:15', async () => {
    const result = await detectErrorAnomalies(
      logFile,
      'timestamp',
      'level',
      ['error', 'fatal', 'critical'],
      5,
      1.5,
    );
    expect(result).toContain('2025-01-15T03:15');
    expect(result).toContain('8 errors');
  });

  it('reports baseline stats', async () => {
    const result = await detectErrorAnomalies(
      logFile,
      'timestamp',
      'level',
      ['error', 'fatal', 'critical'],
      5,
      2.0,
    );
    expect(result).toContain('mean=');
    expect(result).toContain('stdDev=');
  });

  it('returns no anomalies message with very high threshold', async () => {
    const result = await detectErrorAnomalies(
      logFile,
      'timestamp',
      'level',
      ['error', 'fatal', 'critical'],
      5,
      99.0,
    );
    expect(result).toContain('No anomalous windows detected');
  });

  it('handles missing file gracefully', async () => {
    const result = await detectErrorAnomalies(
      '/tmp/does-not-exist.ndjson',
      'timestamp',
      'level',
      ['error'],
      5,
      2.0,
    );
    expect(result).toContain('Error: file not found');
  });

  it('handles no parseable timestamps', async () => {
    const noTsFile = path.join(logDir, 'no-ts.ndjson');
    fs.writeFileSync(
      noTsFile,
      [
        JSON.stringify({ level: 'error', msg: 'a' }),
        JSON.stringify({ level: 'error', msg: 'b' }),
      ].join('\n'),
    );
    const result = await detectErrorAnomalies(noTsFile, 'timestamp', 'level', ['error'], 5, 2.0);
    expect(result).toContain('No error entries with parseable timestamps found');
  });
});

describe('summarizeLogTimeline', () => {
  it('produces a timeline with correct bucket headers', async () => {
    const result = await summarizeLogTimeline(logFile, 'timestamp', 'level', 5);
    expect(result).toContain('Log Timeline Summary');
    expect(result).toContain('Errors');
    expect(result).toContain('Warnings');
  });

  it('marks the spike window with !', async () => {
    const result = await summarizeLogTimeline(logFile, 'timestamp', 'level', 5);
    const spikeLines = result.split('\n').filter((l) => l.includes('03:15') && l.includes('!'));
    expect(spikeLines.length).toBeGreaterThan(0);
  });

  it('counts all 5 error buckets', async () => {
    const result = await summarizeLogTimeline(logFile, 'timestamp', 'level', 5);
    // buckets: 03:00(1), 03:05(1), 03:10(1), 03:15(8), 03:20(1)
    const dataLines = result.split('\n').filter((l) => l.includes('2025-01-15'));
    expect(dataLines.length).toBe(5);
  });

  it('handles missing file gracefully', async () => {
    const result = await summarizeLogTimeline(
      '/tmp/does-not-exist.ndjson',
      'timestamp',
      'level',
      5,
    );
    expect(result).toContain('Error: file not found');
  });
});

describe('resilient multiline parsing', () => {
  it('without lineStartPattern: counts stack trace lines as malformed, emits parse_error_rate', async () => {
    const result = await queryLogPattern(multilineFile, 'level', 'error', 50);
    expect(result).toContain('Parse error rate:');
  });

  it('with lineStartPattern: reconstructs stack traces and emits reconstructed_events', async () => {
    const result = await queryLogPattern(multilineFile, 'level', 'error', 50, '^{');
    expect(result).toContain('Reconstructed events:');
    const entryLines = result.split('\n').filter((l) => l.startsWith('{'));
    const withStackTrace = entryLines.filter((l) => l.includes('stack_trace'));
    expect(withStackTrace.length).toBeGreaterThan(0);
  });

  it('with lineStartPattern: no parse_error_rate when all lines are accounted for', async () => {
    const result = await queryLogPattern(multilineFile, 'level', 'error', 50, '^{');
    expect(result).not.toContain('Parse error rate:');
  });

  it('with lineStartPattern: summarizeLogTimeline still counts reconstructed events correctly', async () => {
    const result = await summarizeLogTimeline(multilineFile, 'timestamp', 'level', 5, '^{');
    expect(result).toContain('Reconstructed events:');
    expect(result).toContain('2025-01-15');
  });
});

describe('correlateRequest', () => {
  it('collects all events matching trace_id across two files', async () => {
    const result = await correlateRequest({
      logFiles: [traceFile1, traceFile2],
      traceId: 'req-abc',
      idField: 'trace_id',
      serviceField: 'service',
      timestampField: 'timestamp',
    });
    expect(result).toContain('Events found:      4');
    expect(result).toContain('Files scanned:     2');
  });

  it('sorts events chronologically across files', async () => {
    const result = await correlateRequest({
      logFiles: [traceFile1, traceFile2],
      traceId: 'req-abc',
      idField: 'trace_id',
      serviceField: 'service',
      timestampField: 'timestamp',
    });
    const eventLines = result.split('\n').filter((l) => l.startsWith('['));
    expect(eventLines.length).toBe(4);
    // First event is api at 03:15:00.000Z (earliest)
    expect(eventLines[0]).toContain('incoming request');
    // Last event is api at 03:15:00.400Z
    expect(eventLines[3]).toContain('returning 401');
  });

  it('reports correct services_involved', async () => {
    const result = await correlateRequest({
      logFiles: [traceFile1, traceFile2],
      traceId: 'req-abc',
      idField: 'trace_id',
      serviceField: 'service',
      timestampField: 'timestamp',
    });
    expect(result).toContain('Services involved: api, auth');
  });

  it('reports duration_ms between first and last event', async () => {
    const result = await correlateRequest({
      logFiles: [traceFile1, traceFile2],
      traceId: 'req-abc',
      idField: 'trace_id',
      serviceField: 'service',
      timestampField: 'timestamp',
    });
    expect(result).toContain('Duration:          400ms');
  });

  it('returns no matching events for unknown trace_id', async () => {
    const result = await correlateRequest({
      logFiles: [traceFile1, traceFile2],
      traceId: 'req-unknown',
      idField: 'trace_id',
      serviceField: 'service',
      timestampField: 'timestamp',
    });
    expect(result).toContain('Events found:      0');
    expect(result).toContain('No matching events found.');
  });

  it('reports warning for non-existent file and scans remaining files', async () => {
    const result = await correlateRequest({
      logFiles: ['/tmp/does-not-exist.ndjson', traceFile2],
      traceId: 'req-abc',
      idField: 'trace_id',
      serviceField: 'service',
      timestampField: 'timestamp',
    });
    expect(result).toContain('Warning:');
    expect(result).toContain('Files scanned:     1');
    expect(result).toContain('Events found:      2');
  });
});

describe('summarizeLogTimeline adaptive granularity', () => {
  let highDensityFile: string;

  beforeAll(() => {
    // 500 events in 1 second at ~2ms intervals → high density → should pick 'ms' or 's'
    highDensityFile = path.join(logDir, 'high-density.ndjson');
    const base = new Date('2025-01-15T03:00:00.000Z').getTime();
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        JSON.stringify({
          timestamp: new Date(base + i * 2).toISOString(),
          level: i % 50 === 0 ? 'error' : 'info',
          msg: 'event',
        }),
      );
    }
    fs.writeFileSync(highDensityFile, lines.join('\n') + '\n');
  });

  it('adaptive: false preserves original behavior (no Granularity line)', async () => {
    const result = await summarizeLogTimeline(logFile, 'timestamp', 'level', 5, undefined, false);
    expect(result).not.toContain('Granularity:');
    expect(result).toContain('Window:      5min');
  });

  it('adaptive: true on high-density data picks ms or s granularity', async () => {
    const result = await summarizeLogTimeline(
      highDensityFile,
      'timestamp',
      'level',
      5,
      undefined,
      true,
    );
    expect(result).toContain('Granularity:');
    const hasMsOrS = result.includes('Granularity: ms') || result.includes('Granularity: s');
    expect(hasMsOrS).toBe(true);
  });

  it('adaptive: true on high-density data emits Density in events/sec', async () => {
    const result = await summarizeLogTimeline(
      highDensityFile,
      'timestamp',
      'level',
      5,
      undefined,
      true,
    );
    expect(result).toContain('Density:');
  });

  it('adaptive: true on normal-density data picks min granularity', async () => {
    const result = await summarizeLogTimeline(logFile, 'timestamp', 'level', 5, undefined, true);
    expect(result).toContain('Granularity: min');
  });

  it('adaptive: true with errors emits Zoomed burst section', async () => {
    const result = await summarizeLogTimeline(
      highDensityFile,
      'timestamp',
      'level',
      5,
      undefined,
      true,
    );
    expect(result).toContain('Zoomed burst');
  });
});

describe('discoverLogSchema', () => {
  it('detects NDJSON schema and flags standard fields', async () => {
    const resultJson = await discoverLogSchema(logFile, 50);
    const result = JSON.parse(resultJson);

    expect(result.fileFormat).toBe('NDJSON');
    expect(result.detectedKeys.timestamp).toBeDefined();
    expect(result.detectedKeys.timestamp.isChronologicalIndex).toBe(true);
    expect(result.detectedKeys.level.isSeverityField).toBe(true);
    expect(result.detectedKeys.level.possibleValues).toContain('info');
    expect(result.detectedKeys.level.possibleValues).toContain('error');
  });

  it('detects Kubernetes container log wrapper format', async () => {
    const k8sLogFile = path.join(logDir, 'k8s.log');
    fs.writeFileSync(
      k8sLogFile,
      [
        JSON.stringify({ time: '2025-01-15T03:15:00Z', stream: 'stdout', log: 'app started' }),
        JSON.stringify({ time: '2025-01-15T03:15:01Z', stream: 'stderr', log: 'some warning' }),
      ].join('\n'),
    );

    const resultJson = await discoverLogSchema(k8sLogFile, 10);
    const result = JSON.parse(resultJson);

    expect(result.fileFormat).toBe('Kubernetes');
    expect(result.detectedKeys.log).toBeDefined();
    expect(result.detectedKeys.stream.type).toBe('string');
  });

  it('detects Syslog format based on RFC pattern', async () => {
    const syslogFile = path.join(logDir, 'syslog.log');
    fs.writeFileSync(
      syslogFile,
      [
        '<13>1 2025-01-15T03:15:00Z myhost myapp 1234 - - app started',
        'Jan 15 03:15:00 myhost myapp[1234]: another event',
      ].join('\n'),
    );

    const resultJson = await discoverLogSchema(syslogFile, 10);
    const result = JSON.parse(resultJson);

    expect(result.fileFormat).toBe('Syslog');
    expect(result.detectedKeys.level).toBeDefined();
  });

  it('handles missing file gracefully', async () => {
    const resultJson = await discoverLogSchema('/tmp/does-not-exist-xxx.log');
    const result = JSON.parse(resultJson);
    expect(result.error).toContain('File not found');
  });
});

describe('groupSemanticPatterns', () => {
  it('groups similar logs and extracts wildcard parameters', async () => {
    const patternFile = path.join(logDir, 'patterns.ndjson');
    fs.writeFileSync(
      patternFile,
      [
        JSON.stringify({
          timestamp: '2025-01-15T03:00:00Z',
          msg: 'connection failed from 192.168.1.1 port 5000',
        }),
        JSON.stringify({
          timestamp: '2025-01-15T03:00:01Z',
          msg: 'connection failed from 10.0.0.2 port 80',
        }),
        JSON.stringify({
          timestamp: '2025-01-15T03:00:02Z',
          msg: 'connection failed from 172.16.0.1 port 8080',
        }),
        JSON.stringify({ timestamp: '2025-01-15T03:00:03Z', msg: 'user 1 logged in successfully' }),
        JSON.stringify({ timestamp: '2025-01-15T03:00:04Z', msg: 'user 2 logged in successfully' }),
      ].join('\n') + '\n',
    );

    const resultJson = await groupSemanticPatterns(patternFile, 0.5, 4);
    const result = JSON.parse(resultJson);

    expect(result.totalProcessedLogs).toBe(5);
    expect(result.uniquePatternsCount).toBe(2);

    const connectionPattern = result.patterns.find((p: any) =>
      p.template.includes('connection failed'),
    );
    expect(connectionPattern).toBeDefined();
    expect(connectionPattern.occurrences).toBe(3);

    const loginPattern = result.patterns.find((p: any) => p.template.includes('logged in'));
    expect(loginPattern).toBeDefined();
    expect(loginPattern.occurrences).toBe(2);
  });

  it('respects timeWindowStart filter', async () => {
    const patternFile = path.join(logDir, 'patterns.ndjson');
    const resultJson = await groupSemanticPatterns(patternFile, 0.5, 4, '2025-01-15T03:00:03Z');
    const result = JSON.parse(resultJson);
    expect(result.totalProcessedLogs).toBe(2); // Only the last 2 entries
  });

  it('handles missing file gracefully', async () => {
    const resultJson = await groupSemanticPatterns('/tmp/does-not-exist-xxx.log');
    const result = JSON.parse(resultJson);
    expect(result.error).toContain('File not found');
  });
});

describe('queryExternalLogs', () => {
  it('translates query and returns OTel-mapped records for Datadog', async () => {
    const resultJson = await queryExternalLogs(
      'datadog',
      'service:auth status:error "login failed"',
      '2025-01-15T03:00:00Z',
      2,
    );
    const result = JSON.parse(resultJson);

    expect(result.provider).toBe('datadog');
    expect(result.translatedQuery).toBe('service:auth status:error "login failed"');
    expect(result.records.length).toBe(2);
    expect(result.records[0].severityText).toBe('ERROR');
    expect(result.records[0].severityNumber).toBe(17);
    expect(result.records[0].body).toContain('login failed');
    expect(result.records[0].attributes.service).toBe('auth');
    expect(result.records[0].timeUnixNano).toBeDefined();
  });

  it('translates query for Splunk', async () => {
    const resultJson = await queryExternalLogs(
      'splunk',
      'service:auth status:error "login failed"',
      '2025-01-15T03:00:00Z',
      1,
    );
    const result = JSON.parse(resultJson);
    expect(result.translatedQuery).toBe('service="auth" AND status="error" AND "login failed"');
  });

  it('translates query for Elasticsearch', async () => {
    const resultJson = await queryExternalLogs(
      'elasticsearch',
      'service:auth "login failed"',
      '2025-01-15T03:00:00Z',
      1,
    );
    const result = JSON.parse(resultJson);
    const queryObj = JSON.parse(result.translatedQuery);
    expect(queryObj.query.bool.must).toContainEqual({ term: { service: 'auth' } });
    expect(queryObj.query.bool.must).toContainEqual({ match: { message: 'login failed' } });
  });
});

describe('startLiveTriage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [file, interval] of activeTriages) {
      clearInterval(interval);
    }
    activeTriages.clear();
    testNotifications.length = 0;
  });

  it('starts live triage and generates notifications on error spike', async () => {
    const liveFile = path.join(logDir, 'live.log');
    const nowMs = Date.now();
    const initialLines = [];
    for (let i = 0; i < 5; i++) {
      const ts = new Date(nowMs - (10 - i) * 60 * 1000).toISOString();
      initialLines.push(JSON.stringify({ timestamp: ts, level: 'error', msg: 'minor error' }));
    }
    fs.writeFileSync(liveFile, initialLines.join('\n') + '\n');

    const res = await startLiveTriage(liveFile, 1.5, 500 * 1024 * 1024);
    expect(res).toContain('started');

    fs.appendFileSync(
      liveFile,
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', msg: 'db error' }) +
        '\n',
    );
    fs.appendFileSync(
      liveFile,
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', msg: 'redis error' }) +
        '\n',
    );
    fs.appendFileSync(
      liveFile,
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', msg: 'auth error' }) +
        '\n',
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(testNotifications.length).toBeGreaterThan(0);
    const alerts = testNotifications.filter((n) => n.params.type === 'anomaly');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[alerts.length - 1].params.error_count).toBe(3);
  });

  it('stops triage and alerts on memory safety bounds', async () => {
    const liveFile = path.join(logDir, 'live.log');
    fs.writeFileSync(
      liveFile,
      JSON.stringify({ timestamp: '2025-01-15T03:00:00Z', level: 'info', msg: 'start' }) + '\n',
    );

    const res = await startLiveTriage(liveFile, 2.0, 1);
    expect(res).toContain('started');

    await vi.advanceTimersByTimeAsync(1000);

    const alert = testNotifications.find((n) => n.params.type === 'memory_alert');
    expect(alert).toBeDefined();
    expect(alert.params.message).toContain('Heap memory usage');
    expect(activeTriages.has(liveFile)).toBe(false);
  });
});
