# 🪵 ndjson-local-log-triage-mcp

[![npm](https://img.shields.io/npm/v/ndjson-local-log-triage-mcp)](https://www.npmjs.com/package/ndjson-local-log-triage-mcp)
[![CI](https://github.com/vola-trebla/ndjson-local-log-triage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/ndjson-local-log-triage-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Your service just crashed. The log file is 2GB. Your AI agent can't help.**

MCP server that stream-parses NDJSON log files without loading them into memory — filter by pattern, detect error spikes via Z-score analysis, summarize severity timelines by time window.

---

## 🤔 The problem

A service crashes at 3am. The log file is `app.log.ndjson` and it's 2GB. You ask your agent to find what caused the spike in errors around 03:17. The agent can't read 2GB. It can't even try.

`ndjson-local-log-triage-mcp` streams the file line by line — never loading it into memory — and gives the agent exactly the slice it needs.

---

## 🛠️ Tools

### `query_log_pattern`

Filter log entries by a field/value match. Returns up to N matching entries, streaming the file without loading it entirely. Pass `lineStartPattern` (e.g. `"^{"`) to reconstruct multiline stack traces silently dropped by the default parser.

```
Log Query Results
  File:        /var/log/app.log.ndjson
  Filter:      service contains "auth"
  Lines read:  847,293
  Matches:     50 (limit 50 reached)

{"timestamp":"2025-01-15T03:17:02Z","level":"error","service":"auth","msg":"token validation failed","userId":"u_abc123"}
...
```

### `detect_error_anomalies`

Z-score frequency analysis. Buckets errors by time window, computes mean + stddev, flags windows where the error rate is anomalously high.

```
Error Anomaly Detection
  File:            /var/log/app.log.ndjson
  Window:          5min
  Z-score cutoff:  2.0
  Baseline:        mean=3.2 errors/window, stdDev=1.8
  Anomalies found: 2

  [z=4.71] 2025-01-15T03:15:00.000Z  23 errors
  [z=2.33] 2025-01-15T03:20:00.000Z  9 errors
```

### `summarize_log_timeline`

Chronological aggregation of errors, warnings, and info counts per time window. Quick visual of where the incident is.

Pass `adaptive: true` to auto-scale bucket size to actual event density and zoom in on the peak error window at 10× finer resolution.

```
Log Timeline Summary
  File:        /var/log/app.log.ndjson
  Window:      5min
  Buckets:     48

  Time (UTC)                 Errors  Warnings  Info  Other
  ─────────────────────────────────────────────────────────
    2025-01-15 03:00:00Z          2         8   142      0
    2025-01-15 03:05:00Z          1         5   138      0
    2025-01-15 03:10:00Z          3         9   141      0
  ! 2025-01-15 03:15:00Z         23        14   119      0
    2025-01-15 03:20:00Z          9        11   133      0
```

### `correlate_request`

Reconstructs a distributed trace from multiple NDJSON log files. Given a `trace_id`, collects all correlated events in chronological order across all files and surfaces the services involved and total duration.

```
Request Correlation
  Trace ID:          trace-8f7a9b2c
  Files scanned:     2
  Events found:      10
  Services involved: api, worker
  Duration:          890ms

[2025-01-15T14:00:00.001Z] api           {"level":"info","msg":"incoming request",...}
[2025-01-15T14:00:00.045Z] api           {"level":"info","msg":"auth token validated",...}
[2025-01-15T14:00:00.112Z] worker        {"level":"info","msg":"job queued",...}
...
```

### `discover_log_schema`

Analyze a log file to infer its wrapper format (NDJSON, Syslog, Kubernetes container logs) and extract type schemas, identifying polymorphic keys, timestamp patterns, and severity fields.

```json
{
  "fileFormat": "NDJSON",
  "detectedKeys": {
    "timestamp": { "type": "string", "format": "date-time", "isChronologicalIndex": true },
    "level": { "type": "string", "isSeverityField": true, "possibleValues": ["info", "error"] }
  }
}
```

### `group_semantic_patterns`

Cluster log messages dynamically using the fixed-depth tree-based **Drain parsing algorithm** to isolate distinct log templates and analyze their parameter distributions (wildcard variations).

```
Processed Logs: 1500
Unique Patterns: 2

- Template: "connection failed from * port *"
  Occurrences: 1200
  Parameters:
    - param_0 (client_ip): 192.168.1.1 (80%), 10.0.0.5 (20%)
```

### `start_live_triage`

Start background log tailing with real-time Z-score anomaly alerting on error frequency spikes and heap memory protection limits. Dispatches notifications directly over standard JSON-RPC channels.

```json
{
  "method": "notifications/triage",
  "params": {
    "type": "anomaly",
    "message": "Live Anomaly Detected: 45 errors in current window (Z-score: 3.52)",
    "z_score": 3.52,
    "error_count": 45
  }
}
```

### `query_external_logs`

A unified gateway to query central log providers (Datadog, Splunk, Elasticsearch), converting search patterns to vendor-specific dialects and mapping the output into the standardized **OpenTelemetry Log Data Model** structure.

---

## ⚡ Setup

```json
{
  "mcpServers": {
    "log-triage": {
      "command": "npx",
      "args": ["-y", "ndjson-local-log-triage-mcp"]
    }
  }
}
```

---

## 🚀 Usage

> "Analyze /var/log/app.log.ndjson — summarize the error timeline in 5-minute windows, detect any anomalous spikes, and show me the error entries around the spike."

Works great alongside:

- [release-readiness-triage-mcp](https://www.npmjs.com/package/release-readiness-triage-mcp) — CI failure triage before release
- [env-secret-exposure-analyzer-mcp](https://www.npmjs.com/package/env-secret-exposure-analyzer-mcp) — secret exposure scanning

---

## 📦 Links

- **npm:** [npmjs.com/package/ndjson-local-log-triage-mcp](https://www.npmjs.com/package/ndjson-local-log-triage-mcp)
- **GitHub:** [github.com/vola-trebla/ndjson-local-log-triage-mcp](https://github.com/vola-trebla/ndjson-local-log-triage-mcp)

## License

MIT
