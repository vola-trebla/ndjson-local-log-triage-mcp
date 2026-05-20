#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const server = new McpServer({
  name: 'ndjson-local-log-triage-mcp',
  version: '0.1.0',
});

server.tool(
  'query_log_pattern',
  'Filter NDJSON log file by field/value pattern, return top N matching entries.',
  {
    logFile: z.string().describe('Absolute path to the NDJSON log file'),
    field: z.string().describe("JSON field name to filter on (e.g. 'level', 'service')"),
    value: z.string().describe('Value to match (case-insensitive substring)'),
    limit: z.number().int().min(1).max(1000).default(50).describe('Max entries to return'),
    lineStartPattern: z
      .string()
      .optional()
      .describe(
        'Regex that marks new log line start (e.g. "^{") — enables multiline stack trace reconstruction',
      ),
  },
  async ({ logFile, field, value, limit, lineStartPattern }) => {
    const text = await import('./triage.js').then((m) =>
      m.queryLogPattern(logFile, field, value, limit, lineStartPattern),
    );
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'detect_error_anomalies',
  'Z-score frequency analysis to find sudden error spikes by time window.',
  {
    logFile: z.string().describe('Absolute path to the NDJSON log file'),
    timestampField: z.string().default('timestamp').describe('Field containing ISO timestamp'),
    levelField: z.string().default('level').describe('Field containing log level'),
    errorValues: z
      .array(z.string())
      .default(['error', 'fatal', 'critical'])
      .describe('Level values to treat as errors'),
    windowMinutes: z
      .number()
      .int()
      .min(1)
      .default(5)
      .describe('Aggregation window size in minutes'),
    zScoreThreshold: z
      .number()
      .default(2.0)
      .describe('Z-score threshold above which a window is flagged as anomalous'),
    lineStartPattern: z
      .string()
      .optional()
      .describe('Regex that marks new log line start — enables multiline stack trace buffering'),
  },
  async ({
    logFile,
    timestampField,
    levelField,
    errorValues,
    windowMinutes,
    zScoreThreshold,
    lineStartPattern,
  }) => {
    const text = await import('./triage.js').then((m) =>
      m.detectErrorAnomalies(
        logFile,
        timestampField,
        levelField,
        errorValues,
        windowMinutes,
        zScoreThreshold,
        lineStartPattern,
      ),
    );
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'summarize_log_timeline',
  'Chronological severity aggregation — errors, warnings, and info counts per time window.',
  {
    logFile: z.string().describe('Absolute path to the NDJSON log file'),
    timestampField: z.string().default('timestamp').describe('Field containing ISO timestamp'),
    levelField: z.string().default('level').describe('Field containing log level'),
    windowMinutes: z
      .number()
      .int()
      .min(1)
      .default(5)
      .describe('Aggregation window size in minutes'),
    lineStartPattern: z
      .string()
      .optional()
      .describe('Regex that marks new log line start — enables multiline stack trace buffering'),
    adaptive: z
      .boolean()
      .default(false)
      .describe(
        'Auto-scale bucket size to actual event density — samples first 1000 events to choose ms/s/min granularity and zooms in on the peak error window',
      ),
  },
  async ({ logFile, timestampField, levelField, windowMinutes, lineStartPattern, adaptive }) => {
    const text = await import('./triage.js').then((m) =>
      m.summarizeLogTimeline(
        logFile,
        timestampField,
        levelField,
        windowMinutes,
        lineStartPattern,
        adaptive,
      ),
    );
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'correlate_request',
  'Reconstruct a distributed trace by collecting all log events matching a trace/request ID across multiple NDJSON files, sorted chronologically.',
  {
    logFiles: z.array(z.string()).min(1).describe('Array of absolute paths to NDJSON log files'),
    traceId: z.string().describe('Trace/request ID value to search for'),
    idField: z.string().default('trace_id').describe('Field name containing the trace/request ID'),
    serviceField: z.string().default('service').describe('Field name for service/component name'),
    timestampField: z.string().default('timestamp').describe('Field name for ISO timestamp'),
    lineStartPattern: z
      .string()
      .optional()
      .describe('Regex that marks new log line start — enables multiline stack trace buffering'),
  },
  async ({ logFiles, traceId, idField, serviceField, timestampField, lineStartPattern }) => {
    const text = await import('./triage.js').then((m) =>
      m.correlateRequest({
        logFiles,
        traceId,
        idField,
        serviceField,
        timestampField,
        lineStartPattern,
      }),
    );
    return { content: [{ type: 'text', text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
