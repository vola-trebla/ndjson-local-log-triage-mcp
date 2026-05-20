import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { queryLogPattern, detectErrorAnomalies, summarizeLogTimeline } from '../src/triage.js';

let logDir: string;
let logFile: string;
let multilineFile: string;

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
