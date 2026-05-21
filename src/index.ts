#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const server = new McpServer({
  name: 'ndjson-local-log-triage-mcp',
  version: '0.3.0',
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

server.tool(
  'discover_log_schema',
  'Analyze a log file to infer format and type schemas, including key type polymorphism and regex patterns for timestamps.',
  {
    file_path: z.string().describe('Absolute path to the log file'),
    sample_size: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(500)
      .describe('Number of lines to sample for schema detection'),
  },
  async ({ file_path, sample_size }) => {
    const text = await import('./triage.js').then((m) =>
      m.discoverLogSchema(file_path, sample_size),
    );
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'group_semantic_patterns',
  'Cluster similar log messages using Drain algorithm to isolate core events and parameter distributions.',
  {
    file_path: z.string().describe('Absolute path to the log file'),
    similarity_threshold: z
      .number()
      .min(0.1)
      .max(1.0)
      .default(0.5)
      .describe('Similarity threshold for clustering (0.1 to 1.0)'),
    depth: z.number().int().min(2).max(10).default(4).describe('Depth of the Drain parse tree'),
    time_window_start: z
      .string()
      .optional()
      .describe('ISO timestamp to filter logs generated after this time'),
  },
  async ({ file_path, similarity_threshold, depth, time_window_start }) => {
    const text = await import('./triage.js').then((m) =>
      m.groupSemanticPatterns(file_path, similarity_threshold, depth, time_window_start),
    );
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'start_live_triage',
  'Start background log tailing with real-time Z-score anomaly alerting and heap memory safety limits.',
  {
    file_path: z.string().describe('Absolute path to the log file'),
    anomaly_threshold_z: z
      .number()
      .default(2.0)
      .describe('Z-score threshold above which log volume spikes trigger notifications'),
    high_water_mark: z
      .number()
      .default(500 * 1024 * 1024)
      .describe(
        'Heap memory safety threshold in bytes (automatically shuts down tailing loop if exceeded)',
      ),
  },
  async ({ file_path, anomaly_threshold_z, high_water_mark }, extra) => {
    const text = await import('./triage.js').then((m) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      m.startLiveTriage(file_path, anomaly_threshold_z, high_water_mark, extra as any),
    );
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'query_external_logs',
  'Query external log providers (Datadog, Splunk, Elasticsearch) translating search patterns and mapping to OpenTelemetry format.',
  {
    provider: z
      .enum(['datadog', 'splunk', 'elasticsearch'])
      .describe('Vendor log service to search'),
    query: z.string().describe('Search query string'),
    start_time: z.string().optional().describe('ISO timestamp for search window start'),
    limit: z.number().int().min(1).max(1000).default(50).describe('Max entries to return'),
  },
  async ({ provider, query, start_time, limit }) => {
    const text = await import('./triage.js').then((m) =>
      m.queryExternalLogs(provider, query, start_time, limit),
    );
    return { content: [{ type: 'text', text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
