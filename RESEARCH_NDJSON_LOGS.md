# **Transforming Local Log Diagnostics: Architecture and Implementation Roadmap for an Autonomous SRE Co-Pilot (MCP v0.3.0 to v1.0.0)**

Distributed architectures generate massive telemetry datasets that frequently exceed the context limitations and financial budgets of cloud-hosted Large Language Models (LLMs).1 By transitioning the Model Context Protocol (MCP) server from a passive local log querier into an autonomous Site Reliability Engineering (SRE) co-pilot, operators can leverage local-first compute to discover structures, extract semantic meaning, and tail live event streams.3 This document presents the complete engineering blueprint and strategic roadmap to evolve ndjson-local-log-triage-mcp from its current state into an intelligent, stream-aligned, and backpressure-managed autonomous diagnostics engine.6

## **Advanced Pattern Discovery and Semantic Filtering**

The raw execution logs of modern microservices are fundamentally semi-structured, consisting of dynamic variable parameters embedded within static templates authored by software engineers.1 To achieve autonomous debugging, the co-pilot must dynamically parse these inputs without human intervention or manual regular expression definitions.8

### **Structure Learning via Fixed-Depth Tree Parsing (Drain)**

Manual maintenance of regular expressions is fragile and scales poorly across highly volatile distributed systems.9 To automate structure learning, the MCP server must implement an online, streaming log parser based on the Drain algorithm.10 Drain uses a fixed-depth parse tree to group unstructured log messages into templates in real-time, effectively reducing millions of raw logs into a few hundred distinct patterns.1

                                   │
                                   ▼

                                   │
                                   ▼

                                   │
                                   ▼
                \[Layer 1: Group by Log Message Length L(M)\]
                                   │
                                   ▼

                                   │
                                   ▼

                                   │
                                   ▼

                       /                       \\

                     /                           \\
        \[Create New Log Group Node\]

The parsing tree consists of a root node, internal nodes representing message lengths and token prefixes, and leaf nodes containing log groups.10 During initialization, the tree depth ![][image1] (which bounds the maximum traversal path) and the similarity threshold ![][image2] are configured.10 When a log message ![][image3] is received:

1. The raw text is preprocessed using lightweight, local regular expressions to mask obvious variables (such as IPv4/IPv6 addresses, decimal numbers, and UUIDs) to prevent unnecessary branching.10
2. The tree is traversed to the first layer, where nodes partition groups based on the token length ![][image4] of the log message.9
3. The parser navigates from the length node down to internal layers based on the tokens at the beginning positions of the log message (up to index ![][image5]).9
4. At the leaf node, which maintains a list of candidate log groups, the similarity between the log message tokens ![][image6] and the representative template tokens ![][image7] of each group is computed.10

The similarity function is defined as:  
![][image8]  
Where ![][image9] represents the total number of non-parameterized tokens in the log message, and ![][image10] yields ![][image11] if the tokens are identical, and ![][image12] otherwise. If the maximum similarity ![][image13], the message is assigned to group ![][image14], and the group template is updated by replacing mismatched positions with a wildcard placeholder \*.10 If no candidate group meets the similarity threshold, a new log group is instantiated under that leaf node.10  
For enterprise-grade reliability, the MCP server will leverage the architectural enhancements of Drain3, incorporating persistent state serialization and dynamic parameter adjustment to ensure parsing consistency across server restarts.13

### **NDJSON Structural Inference and Schema Derivation**

While raw text requires templating, structured Newline Delimited JSON (NDJSON) logs demand schema derivation to enable fast database-like querying without index overhead.14 The MCP server implements an iterative schema inference engine that streams a uniform sampling of the NDJSON file (for example, the first ![][image15] lines) and computes the structural union.16  
This process derives a strict JSON Schema, classifying keys based on data types and identifying potential indexing constraints:

| JSON Data Type    | Inferred Field Property                             | Optimization & SRE Utility                                                  |
| :---------------- | :-------------------------------------------------- | :-------------------------------------------------------------------------- |
| String (ISO-8601) | {"type": "string", "format": "date-time"}           | Used for fast chronological slicing and timeline bucketing.14               |
| String (UUID/Hex) | {"type": "string", "pattern": "^\[0-9a-f\]{8}-..."} | Flagged as a high-cardinality transaction/span correlation key.14           |
| Number (Integer)  | {"type": "integer"}                                 | Analyzed for numerical anomaly detection (e.g., HTTP status code counts).18 |
| Object            | {"type": "object", "properties": {...}}             | Recursively unpacked to resolve nested resource contexts.19                 |
| Array             | {"type": "array", "items": {"type": "string"}}      | Extracted for metadata tagging and categorical slicing.20                   |

If structurally polymorphic fields are encountered (such as an error field containing a simple string in some records and a nested stack trace object in others), the schema generator utilizes an anyOf schema construct to preserve type safety while allowing query flexibility.16

### **Feasibility Study: Local Log Embedding and Vector Search**

To move beyond syntax-based regex queries, semantic search allows the co-pilot to identify related error modes using natural language (for instance, mapping "socket hung up" to "network connection timeout").8 Evaluating the feasibility of running local vector inference on gigabytes of logs reveals critical computational and architectural constraints.21  
Direct vectorization of every log line in a ![][image16] file is computationally infeasible for a local MCP server.22 Generating dense vectors for millions of lines saturates CPU resources, stalls the single-threaded Node.js event loop, and exhausts memory allocation.6 However, by combining syntactic template extraction with local vector spaces, a hybrid semantic retrieval model becomes highly viable 2:

             │
             ▼

──►  
 │  
 ▼

                                           \- Model: bge-small-en-v1.5 (q8)
                                           \- Execution: WASM / WebGPU Accelerated
                                                          │
                                                          ▼
                                             \[Local Vector Indexing\]
                                           \- Engine: Voyager Rust WASM
                                           \- Storage: SQLite vss Tables

By passing raw logs through the Drain parser first, the dataset is compressed by up to four orders of magnitude—reducing millions of raw entries into several hundred static templates.1 The MCP server then executes the local semantic pipeline solely on these unique templates 23:

1. **Local Model Management:** The server downloads and caches an ONNX-optimized model (such as Xenova/bge-small-en-v1.5 or Xenova/all-MiniLM-L6-v2) to run fully locally, ensuring complete privacy and zero external network costs.2
2. **Quantized Inference:** To minimize CPU and memory footprint, the model runs under 8-bit quantization (q8 or q4), enabling extremely fast local execution.24
3. **Hybrid Vector Database:** The extracted template embeddings are indexed inside a local SQLite table containing virtual tables for vector similarity search, alongside traditional lexical search virtual tables (FTS5).23
4. **WASM-Powered Spatial Search:** High-performance spatial indexing is achieved using Voyager, a lightweight Rust-based vector search engine compiled to WebAssembly.2
5. **Fallback Safety:** If the vector model fails to load due to missing native drivers, the retrieval engine degrades gracefully to lexical keyword and regular expression search, preventing the server from crashing.23

## **Real-Time Tail Mode Triage and Backpressure Architecture**

For proactive incident detection, the co-pilot must continuously monitor active log streams (replicating the behavior of tail \-f), parse events in real-time, execute statistical anomaly analysis, and dispatch alerts to the agent host without overwhelming system resources.3

### **Live Triage Push-Notification Architecture**

The standard Model Context Protocol relies heavily on synchronous, client-initiated Request-Response cycles.25 To enable proactive alerts, the server leverages MCP's asynchronous notification layer, sending one-way JSON-RPC 2.0 messages that require no response 25:

MCP Client (AI Agent Host) MCP Server (SRE Co-pilot)  
 │ │  
 │─── JSON-RPC Request (tools/call: start_triage) ─\>│  
 │ │  
 │\<── JSON-RPC Response (Status: Monitoring) ──────│  
 │ │  
 │ \*Anomalous Spike Detected\* │  
 │\<── JSON-RPC Notification (notifications/triage) ─│  
 │ │  
 │ │

For standard input/output (stdio) transports, the server writes JSON-RPC notifications directly to stdout, which are captured and routed by the client.25 For HTTP transports with Server-Sent Events (SSE), the server utilizes persistent SSE connections to stream notifications, while the client executes command calls via separate HTTP POST requests to the MCP endpoint.25

### **High-Velocity Backpressure Management**

Tailing high-throughput application logs can produce bursts exceeding ![][image17] events per second.7 If the stream reader consumes data faster than the parsing engine or the LLM host can process it, memory buffers will accumulate, leading to severe event-loop lag and process termination.6  
To mitigate this, the co-pilot implements a strict pull-based backpressure propagation mechanism using native Node.js Stream pipes 6:

           │
           ▼ (fs.read)

           │
           ▼ (.write() \-\> returns false when buffer full)

◄──  
 │ │  
 ▼ ▼

- **Stream Buffering Control:** The log parser is structured as a native Transform stream with a tuned highWaterMark (typically configured between ![][image18] and ![][image19]).6
- **Backpressure Propagation:** When downstream queues fill up, the destination writable stream's .write() method returns false, indicating that the buffer limit has been breached.6 The TailFile readable stream immediately stops calling fs.read(), pausing data flow.7
- **Kernel Delegation:** This pauses log ingestion at the source, delegating the physical buffering of incoming logs back to the operating system's kernel buffers and filesystem queues.6 This keeps the node process's memory footprint completely flat.29
- **Event Loop Isolation:** Intensive synchronous CPU operations (such as regex matching or string template conversions) are managed using async iterators combined with bounded concurrency gates (e.g., using p-limit).21 This ensures the event-loop delay is kept strictly under ![][image20], preventing server lag and timeout issues during peak loads.21

## **Distributed Observability Integration**

To serve as a comprehensive gateway, the MCP server must act as a translator, allowing agents to query both local files and centralized cloud logging backends using a single, unified interface.3

### **The Gateway Pattern: Abstract Query Mapper**

The co-pilot abstracts the query syntax of diverse enterprise logging providers behind a unified MCP tool called query_external_logs. The server acts as a query translator, converting standard structured parameters into vendor-specific query dialects:

                  ┌────────────────────────────────────────┐
                  │          Agent Tool Invocation         │
                  │        (Unified Gateway Schema)        │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │      MCP Unified Gateway Mapping       │
                  └───────────────────┬────────────────────┘
                                      │
            ┌─────────────────────────┼─────────────────────────┐
            ▼                         ▼                         ▼

┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐  
│ Datadog Translator │ │ Splunk Translator │ │ Elasticsearch Trans. │  
│ \- Translates to DD-QL │ │ \- Translates to SPL │ │ \- Translates to DSL │  
│ \- POST /api/v2/logs │ │ \- POST /services/search│ │ \- POST /\_search │  
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘

When an agent issues a search, the co-pilot handles authentication, signs the requests, executes the network transaction, and maps the provider's response format back to the OpenTelemetry Log Record schema.14 This abstracts away the complexity of managing distinct API tokens, endpoint configurations, and proprietary query syntax.27

### **OpenTelemetry Log Model Alignment**

To enable unified parsing and correlation, the server maps raw local inputs (NDJSON, Syslog, Kubernetes container logs) to the standardized OpenTelemetry (OTel) Log Data Model.14 The OTel specification defines standard logging parameters, grouping information into Resource, Scope, and LogRecord structures.14

#### **1\. Raw Format to OTel Semantic Mapping**

For multi-format local logs, the parser maps fields to their exact OTel semantic equivalents 14:

- **NDJSON Logs:** Fields such as time, msg, and level are mapped directly to timeUnixNano, body, and severityNumber respectively.14 Dynamic trace context fields (e.g., trace_id and span_id) are parsed from hex strings and injected into the log's trace metadata envelope.14
- **Kubernetes Logs:** Log streams are parsed to separate container runtimes from application content.20 Pod-specific metadata is mapped to resource-level attributes (such as k8s.pod.name, k8s.namespace.name, and container.name).20
- **Syslog (RFC-5424):** Text-based headers are parsed using structured regex.10 Structured elements are mapped to OTel resource properties (such as host.name and process.pid), and the message content is placed in the log body.14

#### **2\. Structural Inconsistencies and Mapping Workarounds**

Mapping structured JSON logs into OTel introduces platform-specific compliance challenges 19:

- **Canonical vs. Structured Body:** The canonical OTel specification dictates that the primary textual message must reside in the body string, while metadata resides in the attributes map.14 However, in structured application logs, the entire log record is a rich document without a clear boundary.19 For platforms like ClickHouse or Grafana Loki, mapping the entire document as a structured map directly to body preserves query speed and nested search capabilities.19
- **GCP Log Exporter Flattening:** In Google Cloud Logging, the default exporter maps OTel body to textPayload and attributes to labels.19 Because GCP labels are strictly flat string-to-string maps, complex nested metadata structures (like an exception.err object) are flattened into escaped JSON strings, destroying their queryability.19 To prevent this, the MCP server utilizes a local pre-exporter transform, mapping the attributes into a single structured body object. This ensures GCP ingests the data as a rich, queryable jsonPayload.19
- **SigNoz Rendering Deficiencies:** SigNoz displays structured attributes as stringified raw JSON blocks rather than interactive tables if they are mapped to the standard attributes block.19 The MCP server dynamically converts structured fields to standard lowercase dot-notation paths (e.g., exception.stacktrace) to ensure correct rendering in SigNoz UI boards.18

## **Cognitive Load Minimization and Token Optimization**

High-throughput incidents can generate thousands of redundant error messages within a short time window.1 Transmitting these raw entries to an LLM context window is extremely inefficient and dilutes the critical diagnostic signal.1 The co-pilot utilizes local data reduction and visualization pipelines to optimize token consumption.

### **Algorithmic Aggressive Summarization**

To compress data without losing diagnostic utility, the co-pilot groups logs using the templates generated by the Drain parser.1 Instead of returning thousands of raw log lines, the co-pilot returns a single template pattern along with the statistical distributions of its dynamic parameters.10  
For instance, consider a scenario where ![][image21] raw database timeout errors are encountered within a ![][image22]\-second window:

\- {"time": "12:00:01", "msg": "Database timed out", "client_ip": "192.168.1.5", "db_node": "pg-01"}  
\- {"time": "12:00:02", "msg": "Database timed out", "client_ip": "192.168.1.12", "db_node": "pg-02"}  
... (1,498 identical rows omitted)

The co-pilot compresses these into a single template profile:

### **Pattern ID: DB_TIMEOUT_01**

- Template: Database timed out from client_ip=\* on db_node=\*
- Total Occurrences: 1500 (Frequency: 150 events/sec)
- Parameter Cardinality and Distribution:
  - client_ip (2 unique): 192.168.1.5 (80%), 192.168.1.12 (20%)
  - db_node (2 unique): pg-01 (80%), pg-02 (20%)

This summarization reduces token consumption by over ![][image23], as shown in the empirical token optimization matrix below:

| Ingestion Metric         | Raw Log Extraction Mode  | Aggressive Summarization Mode | Net Savings (%)                |
| :----------------------- | :----------------------- | :---------------------------- | :----------------------------- |
| **Lines Evaluated**      | 1,500 raw entries        | 1,500 raw entries             | 0.0% (Same coverage)           |
| **Character Volume**     | 172,500 characters       | 415 characters                | \-99.76%                       |
| **Token Consumption**    | \~43,125 tokens          | \~104 tokens                  | \-99.75%                       |
| **SRE Diagnostic Value** | Hard to read, repetitive | High-signal, statistical      | Significant reduction in noise |

### **Local Visual Log Mapping**

To help the agent quickly conceptualize distributed request paths, the MCP server parses local trace logs and generates a text-based visual map using Mermaid syntax.14  
By reading local log slices, the server isolates the target trace_id across distinct microservice log files, determines the parent-child span hierarchy, and calculates relative latency boundaries.14

                                        │
             ┌──────────────────────────┴──────────────────────────┐
             ▼                                                     ▼

\- Span: HTTP GET /checkout \- Span: Process Order  
\- Start: 10:00:01.100 \- Start: 10:00:01.120  
\- End: 10:00:01.420 \- End: 10:00:01.390  
 │ │  
 │ ▼  
 │  
 │ \- SQL: SELECT stock  
 │ \- Start: 10:00:01.150  
 │ \- End: 10:00:01.380  
 │ │  
 ▼ ▼  
\[Mermaid Code Generation\] ──────────────────────────►

This raw trace metadata is structured and outputted as an interactive Mermaid sequence diagram 31:  
sequenceDiagram  
autonumber  
api-gateway-\>\>checkout-service: POST /checkout (trace_id: 9f8a2c)  
activate checkout-service  
checkout-service-\>\>inventory-db: SELECT stock WHERE item_id=452 (trace_id: 9f8a2c)  
activate inventory-db  
Note over inventory-db: Slow Query Warning (Z-Score: 3.4)  
inventory-db--\>\>checkout-service: DB Result (duration: 230ms)  
deactivate inventory-db  
checkout-service--\>\>api-gateway: 500 Internal Error (trace_id: 9f8a2c)  
deactivate checkout-service

## **Autonomous SRE Workflows and Auto-Diagnosis Playbooks**

To act as a proactive co-pilot, the MCP server exposes predefined diagnostic playbooks. When an anomaly is detected, the server suggests an optimized sequence of next steps to the agent, accelerating root cause analysis.22  
This diagnostic workflow is modeled as an automated transition sequence:

                  ┌────────────────────────────────────────┐
                  │    Trigger: Anomaly Spike Detected     │
                  │        (Z-Score \> Threshold)           │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │  Step 1: Execute Schema Discovery      │
                  │   \- Identify format, keys, & services │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │  Step 2: Template Extraction (Drain)   │
                  │   \- Isolate error pattern & clusters   │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │  Step 3: Multi-Service Correlation     │
                  │   \- Trace request across log files     │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │  Step 4: Token-Optimized Synthesis     │
                  │   \- Generate Mermaid map & variables   │
                  └────────────────────────────────────────┘

Anomalous spikes are calculated using a rolling Z-score over standard error rates:  
![][image24]  
Where ![][image25] is the current error rate within the active time bucket, ![][image26] is the historical mean, and ![][image27] is the historical standard deviation. If ![][image28], an anomaly alert is triggered.22  
The diagnostic loop executes as follows:

1. **Trigger Action:** The background triage engine identifies a statistical error spike (Z-score ![][image29]).
2. **Schema Alignment:** The server executes discover_schema over the active log file to determine whether it is parsing structured NDJSON or unstructured logs, identifying the exact timestamp and severity keys.16
3. **Template Slicing:** The server triggers group_semantic_patterns to cluster the spike window, separating systemic infrastructure noise from novel application failures.10
4. **Cross-Service Trace Correlation:** The top ![][image30] failed transaction trace_id values are isolated.14 The server initiates correlate_request across all local log files (such as API gateway logs, payment microservice logs, and database slow query logs) to rebuild the transaction journey.14
5. **Context Generation:** The compiled data is transformed into a token-optimized markdown report, containing the dynamic variable distribution and a Mermaid sequence diagram, and delivered as a high-signal notification payload to the agent host.31

## **Tool Definitions for Log Schema Discovery and Semantic Grouping**

The MCP server exposes its capabilities to client applications (like Claude Desktop or Cursor) through a set of structured tools, with inputs validated using Zod schemas.4

### **Tool 1: discover_log_schema**

This tool analyzes an unknown log file, detects its format, and returns the schema structure along with field properties.16

- **Zod Input Schema:**

TypeScript  
const DiscoverLogSchemaInput \= z.object({  
 filePath: z.string().describe("The absolute path to the local log file to analyze"),  
 sampleSize: z.number().default(500).describe("Number of log lines to inspect for structural inference")  
});

- **Expected Tool Response Output:**

JSON  
{  
 "fileFormat": "NDJSON",  
 "detectedKeys": {  
 "timestamp": { "type": "string", "format": "date-time", "isChronologicalIndex": true },  
 "level": { "type": "string", "isSeverityField": true, "possibleValues": },  
 "traceId": { "type": "string", "isTraceCorrelationKey": true },  
 "exception.message": { "type": "string", "isPolymorphic": false }  
 },  
 "suggestedFilters": \["level", "traceId"\]  
}

### **Tool 2: group_semantic_patterns**

This tool groups unstructured or raw log files into structural patterns and templates using the Drain algorithm, computing variable distributions.1

- **Zod Input Schema:**

TypeScript  
const GroupSemanticPatternsInput \= z.object({  
 filePath: z.string().describe("The absolute path to the log file"),  
 similarityThreshold: z.number().min(0).max(1).default(0.5).describe("Similarity ratio for template matching"),  
 depth: z.number().min(2).max(6).default(4).describe("Fixed depth of the parsing tree"),  
 timeWindowStart: z.string().optional().describe("ISO-8601 timestamp to filter the start of the log window")  
});

- **Expected Tool Response Output:**

JSON  
{  
 "totalProcessedLogs": 15000,  
 "uniquePatternsCount": 3,  
 "patterns":  
}

### **Tool 3: start_live_triage**

This tool initializes a background log-tailing pipeline over the target file, applying backpressure management and dispatching notifications upon anomaly detection.6

- **Zod Input Schema:**

TypeScript  
const StartLiveTriageInput \= z.object({  
 filePath: z.string().describe("Absolute path to the active log file to tail"),  
 anomalyThresholdZ: z.number().default(3.0).describe("Z-Score limit to trigger background notifications"),  
 highWaterMark: z.number().default(16384).describe("Stream HWM bytes to trigger pull-based backpressure")  
});

- **Expected Tool Response Output:**

JSON  
{  
 "status": "active",  
 "monitoringTarget": "/var/log/nginx/access.log",  
 "backpressureBufferLimitBytes": 16384,  
 "playbookAssigned": "AUTO_DIAGNOSE_SPIKES"  
}

### **Tool 4: query_external_logs**

This tool serves as an API gateway, translating structured inputs into cloud-provider query syntax to query centralized log stores.5

- **Zod Input Schema:**

TypeScript  
const QueryExternalLogsInput \= z.object({  
 provider: z.enum(\["datadog", "splunk", "elasticsearch"\]).describe("Target cloud observability provider"),  
 query: z.string().describe("Natural or structured filtering arguments to execute"),  
 startTime: z.string().describe("ISO-8601 start window timestamp"),  
 limit: z.number().default(100).describe("Maximum records to return from the provider")  
});

- **Expected Tool Response Output:**

JSON  
{  
 "recordsReturned": 1,  
 "logs":  
}

## **Multi-Format Correlation Patterns**

SRE triage often requires correlates data across multi-format logs.20 The following table defines how raw inputs from diverse local layers are aligned to construct a single chronological context 14:

──► \[Nginx Log Format\] ──┐  
 ├──►  
\[K8s Node: Payment Microservice\] ──► ──┤ \- Chronological Alignment  
 ├──►  
 ──►─┘

The unified mapping profiles are structured as follows:

| Log Source Format             | Extraction Mechanism                                                | Standard Key Extraction Mapping                                                        | Common Correlation Strategy                                                         |
| :---------------------------- | :------------------------------------------------------------------ | :------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| **NDJSON Application Logs**   | Stream-based JSON parser reading values directly from properties.19 | Map msg to body, level to severityText, trace_id to traceId.14                         | Chronological and transaction correlation using the extracted traceId.14            |
| **Kubernetes Container Logs** | JSON stream wrapper parsing runtime stdout/stderr logs.20           | Map log to body, stream to attributes.log_stream. Extract pod_name as OTel Resource.19 | Coregulate application errors with underlying cluster node performance anomalies.20 |
| **RFC-5424 Syslog Standard**  | Regex-based token capture extracting header segments.10             | Map message to body, app-name to service.name, procid to process.pid.14                | Correlate runtime application crashes with low-level kernel host errors.14          |

## **Strategic Roadmap: Versions 0.3.0 and 1.0.0**

The development milestones are divided into two distinct phases: **Version 0.3.0 (Operational Stabilization)** and **Version 1.0.0 (Production-Ready Orchestration)**.

                                    │
                                    ├───►
                                    │     \- JSON Schema auto-generation
                                    │     \- Background tailing (polling)
                                    │     \- Simple token deduplication
                                    │
                                    └───► \[v1.0.0: Autonomous Co-pilot\]
                                          \- Online Drain parsing engine
                                          \- Local ONNX semantic indexing (q8)
                                          \- Native backpressure stream pipeline
                                          \- Cloud platform query translators
                                          \- Automated diagnosis playbooks

The concrete deliverables, validation criteria, and target capabilities for each phase are outlined below:

### **Strategic Roadmap Reference Matrix**

| Feature Domain               | Version 0.3.0 (Operational Stabilization)                                                                                         | Version 1.0.0 (Autonomous Production-Ready)                                                                                                     |
| :--------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Log Structure & Parsing**  | \* Static JSON schema auto-generation. \* Standard JSON type-mapping. \* Regular-expression timestamp extraction fallback paths.9 | \* Full online Drain template parser. \* Runtime dynamic wildcard masking rules. \* Custom regex domain masking pipelines.10                    |
| **Semantic Filtering**       | \* Keyword and regular expression queries. \* Exact match filtering logic. \* FTS5 indexing in SQLite.23                          | \* Transformers.js local ONNX embedding inference. \* Local cosine similarity vector retrieval. \* WASM-optimized Voyager spatial indexing.2    |
| **Triage & Streaming**       | \* Background log tailing. \* Fixed 1-second polling frequency. \* Memory alerting thresholds.7                                   | \* Native readable stream log-tailing. \* Strict pull-based stream backpressure. \* Persistent Server-Sent Events (SSE) notification channels.6 |
| **Distributed Integrations** | \* Local Syslog parser integration. \* Kubernetes wrapper logs extraction.20                                                      | \* OTel Log Model mappings. \* GCP Exporter transform filters. \* Unified external cloud query translation (Datadog/Splunk).19                  |
| **Optimization & Visuals**   | \* Basic token usage warnings. \* Truncation profiles for oversized rows.19                                                       | \* Aggressive summarization with parameter frequency distributions. \* Auto-rendered Mermaid sequence diagrams.31                               |
| **SRE Automation**           | \* Manual, agent-initiated debugging tool chain. \* Manual query mapping interfaces.25                                            | \* Auto-Diagnosis playbooks. \* Z-Score anomaly trigger alerting loops. \* Proactive alert notifications.4                                      |

## **Technical Feasibility and Performance Projections**

To validate the operational viability of running the co-pilot locally on a standard developer machine, processing metrics have been projected across various log volumes:

                 │
                 ▼

       \- Core utilization: \~12% (1 core)
       \- Memory footprint: O(T) where T \= unique templates (\~25MB)
       \- Throughput: \~85,000 lines/sec
                 │
                 ▼

       \- Deduplicated to 120 unique templates
       \- Embeddings generated via ONNX (q8) in 1.8 seconds (WebGPU/AMX accelerated)
                 │
                 ▼

       \- Mermaid visual sequence map generated in \<200ms
       \- Complete diagnostic context: 1.5KB payload sent to LLM client

### **Memory Complexity Bounds**

Because the online parser groups logs into static templates and discards identical raw lines, the memory consumption of the parse tree is bounded by the cardinality of the templates rather than the total volume of raw log entries.1 In a system containing ![][image31] logs mapping to ![][image32] unique templates, the spatial complexity scales as ![][image33], where ![][image34].1 Even across several gigabytes of logs, ![][image32] rarely exceeds a few thousand unique templates, maintaining the V8 heap usage of the local MCP server well under ![][image35].

### **Local Embeddings Computational Cost**

A quantized embedding model running locally (such as bge-small-en-v1.5 at q8 precision) has a disk footprint of approximately ![][image36] and executes inference in roughly ![][image37] to ![][image38] per vector on standard commodity CPUs.2 By executing vectorization strictly on the _templated outcomes_ of the Drain parser rather than the raw stream, the computational overhead is kept negligible, preserving system resources for the active workloads being debugged.2  
This strategic blueprint establishes ndjson-local-log-triage-mcp as a high-performance, non-intrusive, and deeply context-aware local SRE co-pilot, reducing cognitive load for human operators and maximizing the reasoning capabilities of connected AI agents.

[image1]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAsAAAAZCAYAAADnstS2AAAAqUlEQVR4XmNgGDJAAohl0AXRwUIg/g/FRWhyWIEmA0QxC7oENrCSAaKYKABS+BVdEBn0AHETlA1SXIMkBweVQPwLylZlQHiOHa4CClKhEhxIYpegYhgAJPgci9h3NDEGD6hEOpo4SKwBTYxhMwOmdSlIYpZAzAWTSEOSgAGQR2FiH5ElQOA3EBcyQEz5wwAJGZBiZSBehKQODtQYIO6HASEgdkTijwI6AQCURSXAcD7IXAAAAABJRU5ErkJggg==
[image2]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAsAAAAbCAYAAACqenW9AAAAWUlEQVR4XmNgGAWDFnAA8Vcg/o8D+8AUMkIFFgFxBRDvRGKXAXE+TCEIgExkQuL/QGITBCBbiAIsDCQo7gfiD+iCuADIVJAGogBIsQ66IDYgz0CCe0fBIAEANQ0VXRjhPe4AAAAASUVORK5CYII=
[image3]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAaCAYAAACzdqxAAAABC0lEQVR4XmNgGAX0BvVA/AWI/0PxWVRpDPCQAaEWpK8YVRoTwBSDMC6gB8S1DBA1xmhyOMETBoTLcYHHQHyMAb8aFOAFxClAvIUBt6Z1UJqQr1DACSgNCi9smniAOBfKBsmvRpLDC2CGgcINxJZBkgOBH1DanQEir4Ukhxc8RWKDNMYh8fOBmBvKBvkMm4+wApAr0pD4II0LkfjI3iYrfGEApBEU+yDwDFmCASK3Ck0MJ0B3AcxVtkCsgyTuDRXXRhLDC16i8d8wQAy4jSYOypHojsAKGIH4LgMkiyKD5QzYDSAqfHuA+AMQvwXiz0D8B0nOB4hDkfhfGRBqPwHxbyCuRJIfBaNgFBADAG1ESZl9s8ZBAAAAAElFTkSuQmCC
[image4]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADQAAAAaCAYAAAD43n+tAAACTElEQVR4Xu2XMUhVURjHPw0UxCkIEWxyECUcSrHBxQgVwSEczD0oqLYIEZeoNYWmhkhEUKzBQXHIUdRIAkOQWoJAh4gidVAkre9/zzm+r8/zzj3CvS6+H/x55/y///3uffe88959RCXOD33ayJBaVrk282SK1a7NjPmrjRhes3bIHOy0zRqRIUUP6502LRdZv+j/fiEeUCF3wNoQtQrWkZifipiTO2JyuLA5Ss/Oksng1ccy67k20ygj0/SjLngYYq1p0wP6PbKvxfjG6iSTaVY1xwUK9/Byn8xB+Cilgdx1bXrYZLWQydeoGrhqhRVIu2DUb2ozxHdKb+qIyXWz7tgx8gOi5sDqANTTen5mfdBmiJimACsYk1sRY+RfiTmYEWPU34i5D3zMY857DMLvtenhCcU1lhmMv4p5NeuhHWMlUW8qlL3cprjzJqTtnxtiPE5xjbfEWK/+vhjjJsb0a6O4XMIPCofxm+QYo3AW4K7fFfPfVDjmMatK1PSbLUYrxeUSQk2HWR1iPkjFs45VNcd+ccdMygIZ/63yfPRT+nkT3Hf8J11gLtPJJrc8nkbX3ZMAnh4kvda/onwfMTcyYZRMEBcqeWl93w9oqPFTOllvsF6j8r9YP4Z18l/LMRNknpsOyTwrobET5n9Ye6w6d4AAmWvKu8TaZf0ks+fQW2YWxBh7FhmsGPYXviRwXAics0ubWTHPWtJmjrjHslzJ/QQCrO4LbWbNM9a0NnMAf/CwLc6ERSr+hJwVZ/ZmHPe0kSH1rEptlihRInv+AfuonyGlwp7AAAAAAElFTkSuQmCC
[image5]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAaCAYAAADIUm6MAAABS0lEQVR4Xu2WPUsDQRCGpxAVghaxsbCMha0a1NrGxjT+hpDCLp1gIVYWlnZWggoi/g47weAPsJN0WgQhanTmdi43vnfgeriJxT7wwt2zM+zksvkgikT+jHnOAsr/zBnnU9OGtZAccd447+RmKMUSucEncCEQL5xlvZ6j7MH9misq2ViCNU6XM2Ncndz+d8Z5IU09lIGQIyL7PYD3furHnEO9loZ9sxaaa84suB8H3+P09XqRsoapYcXo2SA3g7ygQprkCqaN66gbJ7L/AKVFCp4K3Cs4ZJKz6pkV7fHlhvOB0rJFbsgWeHEH4JAKp+GZbe3xQWZ5RolcUv5I1NTZozMq1jmP4HC+hBPKL5wbd2EXAiN/L+5RUn6+BHm77cKO3qeusCkA8uuc7ou5NXXf2KSsaFedfJrlvpoWBeaU8gOnka/qSCQSiUTGzxcwflclyu+q5wAAAABJRU5ErkJggg==
[image6]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAaCAYAAACtv5zzAAABFklEQVR4XmNgGCSgF4g/APF/dAko+MEAkZuMLkEK+M6A3YJcID7PAHEERaCOAWKBOJq4E1ScD02cJKAKxOxA/AKII5HEz0FpbD7DCr4B8Sl0QSBYCqWXA/EcKNsYSgcA8R8omyAAuaQAXZABEokgkAbE96DsGih9EYg7oWy8QJ8BYgETugQQNEJpUFCB1GxDkiMY/jZA7AXEuxkgin2hfBgwA2JOJD5IjQAaHy8oAuISBojCt1A+CIMAKGl+BuJfQCwFFQPFAwjcAuKvUPwXKoYXgCwApWmaAF0GiAWM6BLUAmsYiAhLSgDI8HfogtQEIAtAEQ0DR5DYVAEgC1Sg7J/IEtQCPQwQS0A5lgVNbhSMglEw2AEAKbM7btHJ2yEAAAAASUVORK5CYII=
[image7]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAaCAYAAAC3g3x9AAAA90lEQVR4Xu2UPQrCQBCFRxFEC0EEOztb8QKeQPAogohXsBAEb2BlaW9hq42lJ7CzEAUb8Q91HpOVYcCsiZb54JGdt7uPzU4IUXSyrLKqc2ociRFrw2qxKqwja8XKqzVfc2Y1rck8rfENW9bMmgFXa/goUvgp6tawnEjuxTGh8EAv2NxR9Y61VjXAGugRPD+C42NBWnlj1k3Vjj7rbk1Hg6SDc5JAfBa6o/BKqgYIGxjvTZfVI9m4D2rIUSB5vQNrwVqSNMv7QSOwbc241EgCU3YiLlPydCwqCMMd/Q0EojEOXP5PILAajC96Ii5DklD8VTJmLiEh4QUIqjJ9zPKh9wAAAABJRU5ErkJggg==
[image8]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAmwAAABKCAYAAAAG/wgnAAAHFUlEQVR4Xu3dWagsRxkA4IpG4w6KohExcSeSaFRcccEYH8QFV1SExAU0GiIiQghoMA8K7qhBXFCuqC+CgsENH4QQUBRUosEEF0RccIlbXBI1Guunuzx1/tszZ+bcOXfumfk++DlVf/dMz9z7MD/VXVWlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwFpdPkY4t8YHa3xg5zAAAOv2q9R/d+oDALBmt6T+X1J/G9yxxidqPDXlXz3mj8UTa/yixp/H/m27YwDAFnlAjefVeFGNF9d4SY2XzoleX7BF4fLIrr8pTs2JCTfWuKbrX1Tje11/P3IxfFPXjv8jAGCLPLwMxcH7apwxxkNrnFXjETVeUOPL4zm5iPh8135b1z4szsyJCb/MiQmXlt3/Nuek/rKeUuPilPta175/jau7PgCwBe5eFiswXlnj/WM7Rp6e3B17c9dep0fnxAxRrO31naeOx4jklHZuFL536/qL6m+pLvLaO9R4Rk4CAJvtW2WxQuFPXTuer4pRtjd1uXW7Nifm2Ov7tuK0l1/zoPFvn4/Rr3d0/UX0r+/bbxz7+bphKgcAbLgoABa5BXiiuqCsrmC7PidG+TW/Hf/+p8aHx3Y+Zy8XltkFW/hX6jffzwkAYDtEsfCwnDxgV5ThuleN/d/VeEIZCrDbj8ea88tOARP5+4ztB9b4ZBkKqBiVak4qO6//eY13dcf6a+YiKfdfW+OSMd/e/281/l7j3jXeO+b+MeaigFtEG0H7w9huIvfZGjfXeFSX78W/UXwmAGDLPK0cXawcD/018/Nl+fPcefwbM1P7YzHTNY+w9cdP6dohX6NfNiNfM3yuxutzcgXiWvspkuP7fDEnAYDtcEON03LygPUFUoyW5WKq95saP6rx9HQsCrbrun7Ir+3la8RoXt/PpnKrcCzv+52cAAC2w39z4jjoi5aYiZmLqebbNb7R9ftjL6zx07EdS22EecVQvkbMvOz72VQuZtjeJSeXEKOJf8zJMty+3cs9y+6lVQCALRGLwC7jspyYECv+TxU7vf54zLzMxdRUO5YS6fuPrfHXsd3WMftxGZ5ta37StfP73in1s5Zb9t+oidc/JOXiFu7jxvbUNeeJhYxjlBEANtJba7xhbPe3wZqv5MQBenCNj9Y4L+Vjwdrj7Us5MeH0nFjQvGIkbnG2LZhiRf9fl2G2ajzAH8uIxLE4J5YPaZMIIm5Thu2wvll2xGvytT405n449t9Tjr5mtOO68fpwpMatxnbz+7L7vWM0b5nRyJhYMDVyFu/Z72QQM1Rf3vVn+XdOAMAmuG/Z/eN+pBz94577TX4QvvfOMhy7XT4wR14dP7RCpO/fo+sfpBipOTknJ7TZj20bqxA7I8SIVo7YKaHJ3/UwmLW0R2+Z7xWTJGK26SLaCOE8y1wbAA6NqR+4fsufGM2JfTWnfLcMyzjEc1JZzFqceu9ZYoQnln6Y0o/Y3Los9777FbMjY6PxeV5Whs/S7625zGdb5twTxddzIonFcT+Sk3PEqN4iYhHjvbRn9ABg40wVDf1tr6njTRy7vMZXUz5mVL69DGuHLSJG4eZd57mpP+/cVXhWGa6xaPSi2I1Nz+MZrNgVIMey2y2diPqdHbL4Tvm26SrE+8bkilmikMzPwgHAxmhFx6vygdGsxU7jYfRPl+G5sn92+dg3Mn6w41mi13X5eeJZqWWKl3hg/645eYKIW6Fxm28vcWs0vvNj8oENEEuQAAArdK+ye7QoVpJv4vZjW/U+659764utVqwsU4DFubNuu06J58RekZOjeI7sUyliRuSRGh+v8bH/nwkAcAidU3YXWmeV4ZbnlP681o7ZhTm3lyjU8rnxTFhfRMZMwt4ZZWePylXrrysOfwDAoXd2TpSjf+SuTP0m9rRs4jVP6vrPHHOLinOnlhKJfCzvkcUo2qztkM4twwzVeQEAcCg8u+y+rRmmVpefWtfqfqkfhVUUSk0893ZR12+urvGDnCzDWmK5wItnu3KuiVmIUwUeAMBGubnsLL0RhVosqdFv9N3koimW8YhblLGy/RfGXCyuGt5ShtuicTze75Ix3zy/DAutTomCL64Vi6XG31gM9rRdZ+zInwkAYKtFcbTKrX6iUDwWbVV/AAA6qyyQFl3qY5b4LKfnJHtqy4jkXSJiTbXXpBwAcEh9Jif24ZScWFLMYmV/4nnFtidob5XFOAAAxyAKs8fnZFl8NwoAAA7YrJG02JkBAIA1iyVQpgq283MCAID1uKxMF2w/ywkAANYj1syb2srrmpwAAGA9nlOGXSZ616c+AABrdqQMt0VjqzEzQwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAN8D+1D/aGr66fVAAAAABJRU5ErkJggg==
[image9]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAaCAYAAAC+aNwHAAAAsklEQVR4XmNgGAUw8ByI/yPh30B8F0m+Ek3+B5IcHPAzQCSPoEsgAZA8TtDOAFFgiy6BBN6iCyCDXwz4bUgG4hx0QWQA8x8u8BCIGdEFYYCLAaJ5B7oEEsBnOEMTA0SBOboEEniBLoAMfjLgtyEeiDPRBZEBIf/fRxdAByDNN9AFkQDIhXgByIB76IJQADJYCl0QHbQyYPfCJSB2RRfEBWoYIIb8gdKghMWJomIUjAJaAQB1qS0EQS26SAAAAABJRU5ErkJggg==
[image10]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAH0AAAAaCAYAAACacVPHAAAFHUlEQVR4Xu2aV4glRRSGj1nMOcuOmEFFVBQEWTBhVpRFQXRWEcQHc0BRXMWcUIwPohhQkMXwICq4uoogKMYHH0RQMOec8/m2qvbW/Lf6Tt2wM8Nuf3C4XX91VXVXPtXXrGWmMpZdL5ddtywBbnP7L1qJv93ed7tKI0bASm5fuN3hto3bwW53WfOztPRgOxUm4VIrV/QbFvR1NGIEbGrlMm9we1m02RJealnBbXsVKyhVZC8oYxXrTrebhWlW9VFBvmuo6OztdoBot7qNi7bU8YP1nnKbYKrcUMVJeCj+alnz3I6yML2PmpfcflUxspEKke/cdlRxJrKn27EqVnKqdTdEL050+1LFDPK6XkXnt/hL/Bbx+rH4+5bbdfF6GMj7EAlflIVrWNf6q49p42YbvNFPsf5ekns3UTGSpuldNcLCiIZPLXSctdzWixpp1ozXg7KzhXyWzzTCqQwgDi3ZFVlczr9ux6g40+AFBm30uVbf6JtZ73vPtHL8Dm6rxmum+fvcnl4cW07TL49bdz6E9xcN0A9TMeNGtz9UrOFotwvd7o1hNjFnW+jxuBCJCyzcgyuh0Etvd/vQ7Rm39SdGL9qEvWnhJa61MLXl01tiP7d33d5zu1riTrBOZTG18cLkVeIBtz9VdA60UC5rfarQ/Dmeyq5PtomNM8eGW88PslAWef7udqjbPjHuYrcf43VilnV3DqVpxz8p57l9YiExHeD0qF8TNQpfGDVGAtoRMZxAezherx3Dly2ODQ12TtRpEK6xHNbfz7Iw9/6ShY+PGuswnQOejZryj3U2ZDmUeb6FNK/G8Ekxjo3UT9Zp2I3d9orXNNLPFtb7UmeqgbIYOKmuCOejm3on7jkLmzRmxDQQe1F6/yoYvSR+RHQ01g3Vvi1oVGZiftQUtNL0frd130/49SycGv20TAM0NoiqNa2DaT1nbZ1q0no+yhM28ttKxRrGLCSeJTranQVNG0hh6i3d09ToNXmmRlfQmDpVSyNYSSNqOnjURl926f2rwDUhsfqEaOrWlBqIAw2mVKY/XI97rPseQDtORQv6XyoKvRqd40rV5oqW+MrK+UwFlPuNikNCnoerWMPmFhLnbgOgqV+qjX5kDPObuCRqChrrO9CIuStUuj9n3Mr3oOmmEO1y0RLEPaFiBuvpkoKyz1Ix43sVKiDPXVSsYcxC4g1ER5tspGsYbsk0vZddMeA24QPDwhin4Akkmvx0NHbCqj0oGqT1fI8Yxgu4shO9CJ5rUNiorahiZCcLZSf/fF+buJHj2Qbxucmzqcye7G4hsR7rod1f0PLKT65YDlN10nI3B40dN+AxJNJhBAciCTogHzgS51q4Z+VMWy1q45kG7I7ZcSur28Rn1U3qMJxhIW88gBJ0zLzsUcwouMZa91VQOVT2R/EXZx+f+/OofWzh7HtLC25V0r4mceRJ63SG1KivWLgn74Vp94rh9yqvWSc+72y4S3QSysate9Ht7XiNRlzu3o1Zc2UssBDH++XMc3vHujt+P3xgvX15zh8om+PcHM4HWOv7HbGcZeTvvcxD5TJ91zLudpOFo+JhaOpsTbB53tqCe5rvi2pgRp0O13PGwtrMLNAP/TaYwmkmZw6D0G/ZulS1RJhqaz+QMCvgdg7DoOlxOTl+7geWtvQVsEWoHQ0vWHAj+dfMoJT+BFED+yr2TM9rRAPsP/jU3NIArtC2Khbg4wcbudkaMQXwgYtvAbUjt3Sq2dLS0tLS0rKM8T+rc1qm/6b9wAAAAABJRU5ErkJggg==
[image11]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAaCAYAAACO5M0mAAAAZklEQVR4XmNgGLqAGV0AGYAka4D4PxBnocnBwQ0gXgfEfgwEFCKDoaIwB10QGwApzEUXxAZACvPQBbEBkMICdEFsAKSwEF0QHYgwQBT2oEvAwGogfg3ET4D4MZR+CcS/kBWNAsoBAO7yGbPFo+KDAAAAAElFTkSuQmCC
[image12]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAaCAYAAACO5M0mAAAApElEQVR4XmNgGJpAHl0AHZwA4qtA7AbEj4H4AIosFMwF4r9oYv+BuBRNDKvgDKg4HEhDBTyRBYEgByoOBwlQAVNkQSCIgIqrwgQqoQL6MAEoCIaKw22qggqgKwyCioejCxjDBKAgDCoON8AOKmAJE4CCWKg4yLNgwA4VAJmADGBOQgEggUloYtug4igAm24QH+R+DLCcARKNIBqkqABVehRQAwAA4fYow14SzbMAAAAASUVORK5CYII=
[image13]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHQAAAAaCAYAAABmZHgNAAAD70lEQVR4Xu2ZW6hOQRTHl1vuFAqJJJcHPODBJaGI3MWDF684iBSSWyh3eUCJlE6RF7dIkqLkTbx4kCgOKSH3B7lbf7Onb511Zubb831nH9/5zv7Vv71nrdmz98zes+ayiXJycloGC7ShmdCW1UMbq5GhrBOsucK2XpxLHrF6aWOF0I+1lkxdBgn7BHH+kdVVpKuKdqzfrJOsbqxJrD+srawvIp9lLxmfixmsT2Sutwpxngr5vrLO1XdHcZpMOU9Ys1lDWMdYr1jjE59Ep6sGVGyiNpKxb1a21om9GMiDjyGUtxNrO5k865QvFpTxg9VZO5hNZPwPlH0P656yhbjE+sDqqx2VRC35Gx129F7JDdZhZXOBa68mRx/fyDQq8rRSvhh+Uvg+AP6F2kil3Ru9/hdrlHZUAqiQrzFcdtgwqQiBsekMmfHXVQZYw+rC+k7+PGnAWIjr22iHwncPvJhd2piSbWTKRXivGOwLPaQdDjDB8DWMZB9rMGsMmfyuEHUhOcL/RjoiGEnm+ufa4cD33MfJ9PByWEqm/OXaEQF6+3TWTNas5Ij5yGSZKQ0HqfBSrVBJFwfI3zASjGUW5F8i0uBFckQPhX+l8MWA3oXry5mtYuabpk5pmEOmLN+E0Yduf61oEP50IY/r5TDcpnQ3kHlwfkqkR1Nh7EFPTlOej5IrLOhD5ZchqSFT3gjt8ICPf6BIN+az/GMa+RsKoa1YeEOvOyvSKKdOpJ+Jc1TGdZ+0+J4TzGdNJROyppCpl2+c9ZURww4y5SBsxtBTnPdmfRbpaBZpQ4Jdz2nwMuq0UYFeN0ykZaNfE3YA+2tliwHXv9XGhFVUWBJBG8ksuVy46poWbF5gDMZ4Xi5XWEe0MS3zyOymuNhA7kpeJ7MBEUJPMLBuQ1nYalsm7NjAgB0NXyryY/EBv2v4sKBXFCvDBZZk2EBByG4s8BwlL4Xusy5qYwImG66JEdafxSqv/XYnCGtOCWbVsIfWgJjpDddGwUMyZbTXjoTVZPyLtUMwjho+c4i7ZKJUR2Uvl7QbNl7s140xT4LlhGu7D2CvN3RThFT94jCVxzUdlB09PVQWXrR9xhA2jw6nA4QvxFEqnsdyh8IfYDnY1UbJvCTTCHZhbkNjrcjjwtV4+OuCwfxdcsRkx/YahKT9yTnAx4JQhbw44gNAKHdxmYqP2eAmFV7e++S4M/EhQoTAs2Jv+n/zlBpuTTYJ2ATYrY0ZghCXJWX1imoAY0dTNkKW99pCcb0CW3xppaNYRXOLtUIbMwA/ArL85xr7sYyNUFZjbWZg/agnVI0N/mdmBf6RdtfGlo7eo20uYNjor405OTk5OTk5LYu/WAMJEhLnAdcAAAAASUVORK5CYII=
[image14]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAaCAYAAAC+aNwHAAAA0UlEQVR4XmNgGPZAGogLgHgmECshiVshsbGCxUD8H4hvA7E3EKsC8TQgfg7EllA5nAAk+RuIudElgKCSASJ/CV0CBv4wEDCdASIfhC4IAh8YIJLM6BJoAKsFugwQiYfoElgAVgP+MkAkeNEliAUgzVhNJhbgM8AfiJ2B2B6IHYDYhQFLOIE0v0YXhIJsIK5nQFhSDsRMKCqgErhcAAMg+VvogjBwjQGigB1dAgpyGSDy4egSyADmCnTnySHJEQR7GRCK30HpRqjcGpiiUTAKqA4AuwIyyvSyLAIAAAAASUVORK5CYII=
[image15]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAZCAYAAABzVH1EAAACJklEQVR4Xu2WP0gdQRDGR1FE7FRsUmihlRCCjUhCUsTG0qA2KukCKooBK4sUIUUKLQz+qcTOIKaIjYVoY6VJmqS1Cf4pJCTEoGiiRudjZu/2zVt593zVk/vBx818s3u3t2937xGlpKTkyxhrwJp5UMVaY12xPrNKMssRk6x/rJ+sR6bmaGRtk9xr3dSCvCe5KTpAg5nlxNwj6V+peY3mpVEL4Yj1xstPWW+9HDwh6et4YPKcFPIiJ6wl431hnXn5U8oeUHXAQ25XBiZ7y3g3UsiLoG+P8cbVd7hf3gKvT+M6zXH1cUs2Ebd9kcckfe16f64+Zh0gPo/LEfC/afxKc8sChf0gt32RUZK+LcbvVr9Vc8R/4nIEfOwV8FFzywyF/SBoOGTNBLwm6Xvf+J3q92qO+FdcjoDvBrnpxT5TJD4OlZyg4bA1E/CCpC9OF58u9bHJAeLfcTkC/n+NFzW3TJP4ZbYQAg1HrJkAt0fajN+vvptFxH/jcgT8HY1v2iPzFPaDoCHWe75UkPTNdWohDg0G3pzGDzUv+NR6aU2lg9VsTQ/0fWe8VfUdsyYH+PrDK/c85M+8HBxTeH9lUUtygwlboPhhdhA+dvZBaEDw/An5RNknGWb/wsvd8xs8L4tl1g/WPmtPr4ckHy+fFdZ341nwd+dSr3hwaJnWk9Q2WLusg8xyxFeSfwsfSNq3Z5YLA7N3J7BLpyjBusU+KnqarJGSklIcXAMQzpqy/TNFrgAAAABJRU5ErkJggg==
[image16]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAZCAYAAABOxhwiAAABxklEQVR4Xu2WzysFURTHv9kIURQLNsLCX4AiSimErCxkRUkhCws7JVs7ZcdG+Q+UtZWyeCVZUDZWyo9QCOGcd+59b+a480uvlO6nvvXmfL/nzpnXzJ0BPJ4/Y4W0Q5pU9S51XDJ6SDekL9IRqSxsJ/IG6d0jDZKGSK+kXtItaaEYxaXxOM/i3/ekO9KLqR0X0jFskrYCx8+Q5pZALYoaSPZaG4ZziB8c3GIH11Qg2gvBgU5HLbER6XJZB2fsBU9ow1IF9wKumobvZ85sa0NxhuyD5yDenDaCrJO6VS1uUcs7JNOmDcUssg8e58XCTZ+6qPj14gbb32rUTho1tZNALjXcxM2V2lCUavB+owHSMOmU9EFqLiRTwA8pL1avDQf2xA3aIEYgt1+HEW+LY6FE/IXvQ7xxbbiohYTLtREB77Wcn9IGMU9ahuzNnLkwtSBxgzNJfh5+4ejQrjrWNEJ6eN+PYg2SWdIGkgdL8vO4HkRXTXMAWVzvSpYNiL+oDcQPNgPx+I0aiX1du5SGQ0h2VRsorpNlO7RDu7wCTfg5rBV/N6Slj/SIcD//IXWkatJ0MYoHlWPxLsLfLE+kK8jwHo/H4/mnfAOYRp5rn2satQAAAABJRU5ErkJggg==
[image17]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAD0AAAAZCAYAAACCXybJAAACbUlEQVR4Xu2WOWhVQRSGj6KohRJUbILGws4mINgoWChikcoiNunSRMUNBCtttBDUQnEpYgg2WkTE2AS3RhEXEFRECzuXQsR9X1DP78zIuf+dMz4RUzzuBz9vzjcz9868u3BFGhoa2p2tmrUsDds1bzQfNP3U9zfs03zRPNcspb7EAs11zQ/NBeqzHJUw5qFmHvW5nJCwAExE1lW7f3NPc97UdzVXTN0qrzW7TP1Rs9vUYJmEtSS6qU5816w0NcasMnVLeJueIfmTwnWwLLBc6seZmXGo+Y7Dhblm6p1Sn9eTcX/E2/QtyR8MDrdXq6Q7ioHri+05scav5Vz0CbRx9zHwc1mW8DYN7y025z0w9itLCf5ObO+INTMs9U3nnnX4AyxLjMem8SJk4PFsg9OxZg5JfdNnTJ2AH2NZAhPWsxR/c573wNgXLKV6nEumbdkvwXdqJsb2qcqIAPwDliUwYQNL8TfneQ+MfcVSgsebGByPNXNQgp8Ua7RxVzDwl1mWwISNLMXfnOc9MPYzSwk+XR3vmR6Sqkf7rKkT8IMsS2DCZpbKW8kvBO4+ywLenwR3JLaXxPpf3t5rWJbAhC0slV7xF7vI1NM0m0zNHJb6cSZEN9k41KtNDd5J9X2ADfOxFmdckdkSJuzljgj6Bky9JzoLagQn90D/QlPfkPobHVf1m6nTHzPfuPRRM9U43JE3Te0yonmmeax5FH+fSviQsOAq4iRY5G3NJwmLseDqPNEcI2/pknCcixK+lzE+B87xXnNSwvgV1e5fwKFvVPNSc7XaPX5M12xj2e6UrnJbMkvyn4ZtzRQWDQ0NDf+TnygRyC80mHyLAAAAAElFTkSuQmCC
[image18]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADEAAAAZCAYAAACYY8ZHAAABz0lEQVR4Xu2WuUsFMRDGR9FCsRFsrCzERv8HC20UBDsbsfZCURCs7W20tBAbLyw8ECwEC8HC0s5axQNF8EBQvOZjEpI37ibr1vnBx8vON5PdyQu7IUokEjFmWKM6mMES65X1Y/Reaf/hnlzuG+vAxB+9OPTCemA9e7FekxtknfVBrmis0g5yzNomqQuxS5KDB9Q0kHg72iCZH96wNkKUaaKGpG5BeZZZVi3Fm9jUhsEubmHKNAFCN7LxWBPYEVmE5s6kbBMjJLXNngfqWJNmXKaJeRJvThshyjYBUHvuXYNDbxxrYp/VympjdbDOTHzApRYDReM6GMBv4oL+/u033jjWxBGri9XN6iFZTMQ3XGoxUDShgwH8JrCKqB8y152sdmdHm8jaTgDepw6GQIHdw0XwmwCo/zZjvPN9yjZxTeIPaiMPJE/pYADdxDLJHFWsNeXFmsjbNqck/qI28kDytA4G0E0AzIGvcnVGPNRE7DuBN12UJpJkvNaKUE+Sv6LiX+S2lMV+EJ9UHLSQeHsqjppb40WfaYvkbHPFujS/dyRHkTxWSW5g83EGsvSx+r1rnIOwr/25T4xnV9kKC4D74p/EnHi2RpObSCQSicS/+QULG6IktmuhzgAAAABJRU5ErkJggg==
[image19]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADEAAAAZCAYAAACYY8ZHAAAB1klEQVR4Xu2WzSsGURTGD7EgG1kpspAS/4MFG0rZ2ciaLGyt7d8NO5JsfCX5SCnKgiyklJ018hEpn0W+ztO5t7nveWfmzjvr+6un7pznnJl57jvNvESBQCALLaw/XVTMst5I+qDPYruEB4p6P1i7pv7k1KFX1iPrxan1md6ysMNZOGRtkL9/i6QHN6ipI/E2tUFyfngj2khjj/VO/puy4CJVJP1TyrNMsKrJH2JVG4ZyNpWaSHYMF8o6hBAg7UK27guxrA1D2rlLsI15QoySzDQ6HqhhjZt1nhAFEm9SG3Gss5rNOk8IgJkL5xjsO2tfiB1WK6uN1ck6N/XBqDWZBtaBc5w3xCWVzt06a18I3EM3q4fVyxoz9ZWoNRl94bwhsIuYGzbHXayOyPaGiHucALxvXXSZYbWrWt4QAHO/Zo13vkveEDck/pA2LPjoHClhAMJ6LmqNRYeYJ5mtYC0pzxci6bE5IfGntZGGDZEFHQJgFl/lyph6WgjfdwJvusxkDVFL0reg6j8UPVIW+0F8VnXQQuJtqzpm7oxXUF4iZyRDV0ZYnxZ1RCxS1HtN8h/I0s8acI7xPwjPte29Zx0bz26YFTbgi+SXxDnXWPWmNxAIBAKBsvkH2G6vc2kCrV0AAAAASUVORK5CYII=
[image20]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAZCAYAAACclhZ6AAAByUlEQVR4Xu2WzytFQRTHj4VQyEL+A1kohbUIWwsltsLCj4iykFIW2PAXYGEnsbDGRrKxooRi8fIzSURJNpxvM9c778ybi0h3MZ/69t75zJl77/Tm3neJAoHAbxnl9GkpmOA8cV443WosESxz3jjvNv2Zw58ccTZFfcjZFXXi8C2mmMyYBq5Ey6TgW8w++RezqGVS8C0m2oIan4/o5Mxw1mxdyVngtEQNTAVnnjMtnGSSc85Z4tRw2uRgHH+9mClK96Q4RZwcW19wtjn1thff9bFQY07EA8U/oDLA5AEtyX/RPi+5JNOTL9yIdV3CAbgqVUuq6YeLGdSS/Bft85IUuT24IO0AXIOqkXVOnfDfAhOHtCT/Rfu85Izcnp4sDsA1irrMOplCMR4Lmoe1ZJ7Jf/JjLRWn5M7FH652QC8mT3xvJjP+KFwsaMZ+1rST/+S1WipS5M6N+2WaRI0bXtJK2ec5lJJpnNMDFoz1inrWuq+4I7dv3Lpc4bB94DqEQ10u6jHOjqgdVsmcEE8dPC7xeUvmFUdSQObge5wDziuZx2wc95Q+Lo6JrYIte2XdDWeDc8K5tg5jePcDW2RufpwXWbE+EAgEAoF/5QOx6ZKZSOQcWgAAAABJRU5ErkJggg==
[image21]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAZCAYAAABzVH1EAAACCklEQVR4Xu2Vuy9lURTG14T5B8RoFCMyYkKjJxlCo53aP2CEmIkphFAgUVAQjyhEJEImFJSERjWmEVrNxKMQIYhHvK3v7r3dddbZOHKqK+eXfLn7+9Y6++x97nkQJSQkvJUWVr0OI/KT9YdVYv1X1hSr+akjTT/rmnXIqlA1xxfWGuuBtaxqXmbITIoDoB/BcmS6KT2H03qgw3BCptdxyeoVHnwjc7yjTPlXibORTtYga5LVzsoKllNUU3hBOZ4MXt8ZuNh/VfYscTaCxVfpUOH+eQ2yOjvOsx6/kiWbRyLORtro9Y1g/hsdksk37bjDes0E+XMvcTbSyuohM4c76Vigw2SnKgPI8ayAees1w+TPvaCxQYcR+cVaVBnm61L+SHgHcrfIVTGWDJDJ83XBBxobdRgDuUDnj4V3IL+342nrNUNk8mxd8IHGJh1G5IMOmDsKb+RKeAfyLTt+7hkZJ3/uBY2+D1gUcCw+cDrTG/EtBtmoHZdbH/uthS+0j1pWqQ4FOPa3J5MnH1Ee4J9E9lFk8N+FB2fkf75C5JKZoE8XKH0yvQjJBeuT8JVk+otFBpDJC/KPwm8yXP1b4d35C0QWYpZ1wNpl7djffTIfL8kC67/KNLi13IahwmA5xWcytRXWNmsvWH5ig3XOmiPTXxMsxwNX713w0q2VMeC+xXOU8RTpICEhITN4BFXJl8PGVQmRAAAAAElFTkSuQmCC
[image22]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAYCAYAAAAVibZIAAAAyklEQVR4Xu2SsQ4BURBFJ9EKCh/in1SICNGKyg+o9eILFKIgod5CfIZCRELDnezizc1Oss2q3klO8c68N8kKkcg/GMMOx4AJvMI7bNPMsIRP+Mrs2vGXM9wE5xM8BGcXb2lN0hmjrcGR8ZYm4i9dcGS8pZ+fhvG6obSlPY7iP/a6QS/0OYr/2OsGvTDgKP5jrxv0wpAjWEn+Y20zjoxeGnEEVUlnlaDVs5bLFO7gTX6fc4Tb8BLYw0twfkiB/2gRWnAN57BJs0ikDN7fNkDj5v/CDgAAAABJRU5ErkJggg==
[image23]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAAZCAYAAAB6v90+AAACiklEQVR4Xu2WS6hPURTGl0cedWUgyeh6DJSSiC5RBpShCDH6lwlSTDy7uXUVSgYKiUxlYGJiIkmXgTzKI2aUJM90rySk+D5r7WudZZ/zv4fJlfOrr3PWt9de55x99tlnizQ0/C3joUXRzMC8f4ZT0C1oFfQNGlNsHuQ7NDqaZbBIn2iny6HNsxv6Kpq3LLSVMQ+6As2HRkIzoGPQRZ8kWjOxH/oAvYLWQiuhm5bT7fIq4QXZYaLFCy2OfITuuPg9dMTFZawQref1ppAhssV8z1E7jpBf9/bFjkOCBe9nvIcuPmmeZ3LGy8E3ewk6Cx2AOorNPzkhv9e6HuKXUmMKpps7E/y75ifSSEfo7Y1mYCnUG81AlxTrj4UOu3iN1JiCpCVakHPec9X8RNWD8TuoYom0fzDCWvwGCb93/3ZqTUHSKfk39sz8SRZXPVjO9yyGzonmnYc+id54ZKZozg3otPPfSo0p6GGxBxmP4kJCOOLxAdabF/0IFycOlId94jeUYyO0z8VbRfsedF4py0WT039jj+jCQS9NDcJV0Y/0a9EcLv914fRtNyDkszvfBb2z8+3QBtdWyhTR/9cjaA70VPIX7oEGoOMWMyc3rdpxTbQvr1sGfyejXMx8vn0f12YoU4zbGubMig2BXC3+D+mNC36iBe0MHvO5ivu4ktyFGa92cad5XJYT3DnEfrzRbcFjzoXgpd1LGVxgIn/0YL4QR5PTwMMlm3mcpmSCxdMHM5Q0SLOdd0+0f2KqaE7LeZ5+0d1GhH0WhLiSuaJJz+1Y9s2kxeKFHacVWhVuYG9HEzwW7ZPeFLdZOTZBm6NpsPYTO98BrXNtw564h4xwNeTAHIoNDQ0NDQ3/HT8A8+mu5hErAFQAAAAASUVORK5CYII=
[image24]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAmwAAABFCAYAAAD3qbryAAAEOElEQVR4Xu3dTahVVRQH8J1JmYlUoyiDoCSkoFKKBhXNGvRFH4OsSRANqlkfRDSImgRRIUghVkODyoFWRAQRDkI0alAR9E2JNUijTKVBWmt59unuNuqzfPr08fvBn733Oufec99ssc+595UCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMCM2RX5K7Ig8ludH0mnRLY16zsilzRrAAAa39XxmTJp1I50w/Zh5IZmfaSvBwAwK2TTtKUvhvf7QiNfc7AcSHvszG6d+nXa2hca8/vCIdjQFw7i6b4AADATskm6uy+W/TdPh6t9z1XdOn3araeyoi9Msz/7AgDA0TQ2S23T1Nam2i37P/prbY4sr+szIrdH1kXeq7XHIzvrPC0sw/F89m1/n3F7GZ7FS19F9kQ2RVbX2gd1HOUzfJ/U+ZLIy5HnI3Nrbbr/fgCA/+SByO4yNCU3l3/fAj2tDA3UdFpZhmtdWobn5/Laec3v6/GP65jGRunEZj7W87OdXdd7u2OjN7raWZH1kdfquj32VB3XdGN6qZkDAJSfymTH6JfIz3XefqvyaGmbp+ky1W7VePyFyHN1fnpkUZ2P8ksS99f5LU39ozpeEVkcuSCyY3J4n/Ea+WzaZ039xWY+nnNtUwMA2KdvaHJ9b1c7WnLn6pzITf2Bw9D/fb2xgcrzTqrztWXysx95ezPdWceL6jh+xvH981Zoyp27y+t8dF9kWWROmTyf9mUZboGeWoadv3yfbFifiCyt5wAAlLcj85p1Ng3vNuvZoN3RAgA47pzXzPMZr6l2owAAmCG5y3YozVp+mzJv3x0s14wnAwAwfbJZO6EvAgAw8y4uQ7M2/lxF2tjMAQCYQSeXoVnL25yt37s1AAAzJJu1r8vw8xL5UxS5zixoTwIAAAAAAAAAAAAAADhevFUmX5AYAwDAMaL9FqtGDQDgGLMjsqVZ9w3bysjerpbyJ0um01V94SD29AUAgNmsb9D6dbq1L0zhSDdU+/uMAACzVtv85P897XfTVkRWRb5tatsidzXrP8qwU5f6Z+By52xrmbzvO5FzI2si55fhP0Nsr8fSPZHPy2TX76HIq5E3/zmjlG+aOQDArPdrZHXk6siu7lgaG68Ly9DQra/rR+p4euSxyHV1nbLJS0siy+p8TmRpnWcTl41Zvt+zZXKN5ZF5df5wZHFN2l3HfNZuUZ0DAFAmzVR7m3NTM58fuaxMzruxOdbu3uXOWnqlqY2+qGN/q7NdX1nHjU0NAIBwWx2zefqhmW+u87V1fLSOr5dh5yx3yq6PLCzDLtyT9XjflM1t5g/WMV+/oQy3Q9OPdcxmcGdkXV0DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfyNx0T1njSjnt+AAAAAElFTkSuQmCC
[image25]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAaCAYAAAC6nQw6AAAAwUlEQVR4XmNgGAWjgPpgIhCnIvE7gLgGiU8QiAPxJSg7F4h/AfF/KP8sEPdA2QQBTBMI8ED5+kBsAWVHIMnjBUZI7DIGVIM5kNgwwI0ugA18YkA1CBsgJA8GIEWL0QWRgD8QX0QXBAEBBohmZQZE+GghyV9FYoPkkDEKmAkV5ATic1C2IlQOFOAroGwYwDAABhgZEDa4MkBcBuPXIamDAZwGkQL8GBDpjSJwCIjDoexyZAlSgRwQPwDipWjio2BIAgB6cCipqjtjpwAAAABJRU5ErkJggg==
[image26]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEwAAAAaCAYAAAAdQLrBAAAChUlEQVR4Xu2WS6hOURiGP9cihERCBihDJSVRSrnfQqKMZIaBXKYmDCkhFJm4RCki1DnpDCh3iULiCDMpkRK5vG/fWud/z+f/+/996pSynnrb63vX2muvvS7f3maFQqFQKBQKhX+B3dDo4A1KKtThN7SgjncheAWwxHxyIvSmR7Ng9tD+nrC1dbzB0E3oV/CVO9CwaPYin6JRgU3QT2h9rGgGJ+ZB8J4nP3IAOhRNYW80GnAfWhnNivSBVkezIvXesSm8KQ6eHndThLtrVDR7QI8G2gtUHscq85sGBJ/e4lTWxE//KHQc+iD+ROgGdEI8shO6BX1O8XnzPrKmJp88gs6YL8rA5F2HnkKHodPQ5ORfhT5C/VOceQyds+5j2wFdgTqhy+IvhF5J3BJPzAe+WTyea3p9oX1W+7UYkfwMyzlfvYRGmt+rvE3X99DYVF5uPjmK9jsF+mY+QVrH6wrz359J5mmEcYb1/aRMtkAXU5mLoM+5DW2QuCXYAV8qrzhfjHBlGXNHZPZDRyTWhxMm/HXBy/3OFI8fGU0BzIvcRZlpVuubO/CL1Cn6/GPQa4kz2mYj1C5xHH9L8Kal0WwAd8+YVOZu+SF1JA6AX1Ue9e2hLrZjvExiLlbeXTyiu6Quswh6ITHHtkZiMs66P+sNNFviOI6mcJWr3KRt26Ct0J4UzzU/lkOh4enaaJJy+WS68oupX7vYNuYpwiM7wTxvkg5ofldtbfJiX+QSNMt8Aud11bbAPas2YZ1SnmOeh2aIx5c4KzETaof5EVTemU+S/q8xSXMR8gRkvoc4sw26C40Xj0eS+YrXIck7aN6Ov0KnzNNG5it0TeKmPLP6271QKBQKhf+bP+FwoNRnlSZCAAAAAElFTkSuQmCC
[image27]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEsAAAAaCAYAAAD/nKG4AAACf0lEQVR4Xu2WS6hOURTHFyUlb0oJ10AywARlYKAMRIQBkYnyLCUm7pTyiEQYSBgpxMCzGEgpA/II5XknVwyQV4m8+f+ttfvWt75zPtftxODuX/07e/33Pufs11n7iGQymUwmk8lk/hX9oOnQzKCMowX62UQra027Nn1EJ2St815CP1ycMThRp4K3zPzIPin2E1Og09EsoXc0OsE1qG80O0gP6Kw0H08dzEdFjY9JsU/KfDIBGhrNApgbq9i5m6Pxl2yDDkWzjAtSPHh676IJ5kJ3o9kJdkG7o/kf+AaNiGYZR6RxsgabV7S9b0ProeuikznW1b0SfbmnG/QJOg7tN88fHM/NI6uge9ATaLV5d6Cv0BjRz/uB+S3QJWncFcuh+9BlaKJ5A6C3ou252HxWIo69KYOk/obuFi92nod1c6w8DbppZe4UEl/+wpW/u3Jsdxja6OJUP150UdZAC0UnjrRBA6X+mWegHVbm5GwSXSz/LpaZqwhzZuzHH2FSTiv9SHQlyvAPPwmtczHv850nz0Tveey8/tKYr2KnGXOgqVwEkzsnMFHU7iJ00MW+zVbogIsrZZboFk/EzrHzi4JHJon+ipyweCe0p1YtC6R+8rjycTcU4f2yg4recCuPhD7Wqn7v0mEurpSr0Hwr+wHNs2uKmRvIZ9HPhywR/WwJd98QqBc0WXRH+lz3FJphZeag864uMVX0U+Q/IndqT+iLq2c6YT774Lxb0BbR3x+S+rvXrpUSV+49dMPFD6F2F4+DXovuxlbnzxa9b4PztotOEgc3yvlXoNEu9vDgOOpi5igePPz0V5jHw4qLxsOH+fkNtNTqzkk1J3smk8lkMl2EXx7YnEm7aWORAAAAAElFTkSuQmCC
[image28]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEUAAAAaCAYAAADhVZELAAACWklEQVR4Xu2XT4hOURjGHyZ/UhKxsGAWUxai2CEruylFNpQyG6UoyYIUNmqK2FhYmJoNhSyVhZQks7HBQhSSPyEsUP4z3mfec+c787jfvee7M77V+dXTfOd5zzn33vP3HSCTyWT+L69No5E+md6b3kXewvHa3eU6/PmfTQMSq+MyvO0D0xyJ1cKGV9Q0RuCxTRroEt9NPeH3XPi7PG+F2zIDXndpKLMPlheP16ih1/RUTeMMvKNBDbRhjRqT5Cj8+Ucir1i1ddwyvRTvJNLajnHVNFu8HfAOrolfRT+8zW4NNGQlvL+NkZc6KKzDSY1ZF/wk+qS8Gt74mfiprIW3P66BKYD98mypotgqh8XvDf4W8WtZAG/4VQMN4GB/M13QQAPmmT6avmighFXwb9gv/qLgHxS/kulIX56dwIH+YLqtgUR4ppyFT5RuiTI2wL9hr/jzgz8kfiXFgEwTf7OUmzLL9AR+PRY3SqekTNoyeJ194jOloH9M/Lb8gDfgMo3ZBT+gpgIONq/4t2iQMwSYNvA9q7Ykn8M6h8RfEvzt4pfyCl55hQZQPyspzDQ9Nj2E5w+p3IUnkTE8PPlOP8VXWEe3WnH71OYqN+EVt2nAOIH6k74KniXMim9oIJFiq8Sr6nzwLkYe04k9UZn8Nt0X7wASJvkUvNJp8ZmEFatnq8RS4K3DTPScBjrkBXxiYoqBKvOWR9764MWUfes/8DT/ZfqDVscUy/RTrr8YXoVsm5oBp3AP/k6Pwt83E8Nj8F+QO2qitTIuwc/M4Ynh7rBTjUwmk8lkMpnM5PkLbGaXOiMSYw4AAAAASUVORK5CYII=
[image29]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAZCAYAAAB3oa15AAABuklEQVR4Xu2WvSuHURTHj/eXQSmKARtRymSQJP+AsmG1KYkiZcMik4FBKBuKsrCY2FhINvkN8jIpibw7x7nPr/Mcz/sPg+6nvv26n3Pvc+/zu88bgMVi+U3WMB+YJ8yoqoWxDjz2FFOsan8CTV6i2s+i7UcecN9q084x7cp0Dw+atciQNuBJd4W7Na5OOC/2MBfKzQCP9SUfk8LsY7LcpUTkAk84LdyDcXJXvKA+c8q1GB9KNuYIc44pUrVMoQWELcK5XMaVrzG+S/lAtjF3mApdiAntxgnmHcJ3twl4oUPKlxsf90HwxTLmFdOoCxHowcxjbjBbquZFB/BCB5QvNX5B+VhMAR+EbtAkXAOPD9qFWuA+g8qXGT+hfCz6gQ/SrQsRGQYef6ULAjo56jOmfJXxvcpHYhJ4MG1vVFaALztJK/BxKEFQ3e8pFPgu0CxiXjD1uhABZ6HtwvUZdylcIfDOSt4wx8qNQPiJp9kBfunQnZ+UTeAXkuQeeBEFwjkn2iCcs1MSas8q54KuvUPMGfC/8hNsAE+cMr+P4F480Yk5UI5w/vFV4M+PJXf5O/QpEfR0sFgsFsv/5BM1TGVDtQKq5gAAAABJRU5ErkJggg==
[image30]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAaCAYAAACO5M0mAAAAkUlEQVR4XmNgGDqAG10ACjjQBRqB+D8U/0FiyyErAoEmqAQMvwRiFhQVUFAHxI7ogthANQORCqsYIAqzgPgyEPehSiNAOQPEbaJQfiyUj+FOFSDmRBMDKfyEJoYVwEIABTCiCwDBXwYsCkECb7GIYVVYikUMQ+E3BoSPQcCBAaJIHUkMDkBWI0ejEqr0KKAGAAAbRyT1zTbmAgAAAABJRU5ErkJggg==
[image31]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAaCAYAAABVX2cEAAAA3klEQVR4XmNgGAWUgnlA/BmI/0PxAhRZCPjLgJAHYWdUaUyArBgb2AfEKuiC2AAjEG8H4vUMEMOCUKXBAJclGCAfiE2gbFyu+4MugAu8RWJ/YIAYxockpgbEnUh8vADZJaBwAfFvIoktA2IeJD5OAAqvzWhi6F7F5m2sADm8kMVABnRD+b+Q5PCCd+gCUABznTYQt6DJ4QS4vLCbASJ3D4g50eSwAhYg3osuCAVMDJhhhxMwA/EbID6JLoEEvgHxD3RBdLAKiD8yQNIXKF2B8h42oA/E2eiCo2AUDGkAAM4NNN65dbHtAAAAAElFTkSuQmCC
[image32]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAAaCAYAAABozQZiAAAAlklEQVR4XmNgGLlgMxD/JwGjAJBAGBYxdIUa6GJCDBCbkQETA0TRBTRxEHiEzNkKxIzIAkBQwADR7I8mzgbEfcgC+cgcKHjPgOlkEBAAYnF0QXSAzb9EAWYGiMYz6BLEgHIGiGZvdAliwGcGMp0MAmT7FxQVZPt3NgNEcwKaOE4QBMTfGCBx+xaKQf7+xUCm80fBKIADAO8/LWwyw7tTAAAAAElFTkSuQmCC
[image33]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC8AAAAaCAYAAAAnkAWyAAACCElEQVR4Xu2Wu0sdQRTGj49IRHxBsBG11cLCStEi+EDstbAQxUKwshEkf4OCWFjYpbNJFdKkCSiIRrCQlAoWIhY+QEHx/Thfzl5ZP2d39q5XC7k/OOD85juz3L1zxxHJ83HoZZGCRhZpaNBa0JrXqqA5F+Na31imYEOrmWVS5rQetIaDcb3WgdblU+IldVr75ErE1klaPdb2H4zLQmMvhWJNyzwRcKt1zzIAfZ/JLWqtk/splv1CHq4gNMb2Ow+NvWCBHZYhusQy3eTbta7IAWSZzFtmolwtSxd74l4gTOab+UH+Rl7u9U9a38kB9N+xFPezsfdXWDJfxZqXyDPVYrkT8nCl5JpoDFrEsrM8oUywUAbF/aGegTeHEO9ZZkgstxly5YFLwi+xbBVPxOBdGwFvSNkSy+FIzNAZuCQkfU6Y2HyNJF/UlRt1uCiQw4mVDeiJ3BFFYoELniAGxHJ8jI4E3kerWG6GJzygB1szEtcbZaIybeL2zG+xXCVPePCufSrxoV2xeRx/TOYE8hH14X0k6kHoH0vlUOw0igO9uApEEb4mZEO/ZNFzJBb+K/YbwN/Yqz6Qm2Qp9uPEt3ostjb+P2BdXDFi93HAqtYay1wzpXXGMgdEbdWcgwcVs3wFHVrXLN+KPq1tlq8A959cvgwv01pjLFPwR+we9O6MsEgBrth58uQhHgFmQYx+mwDbowAAAABJRU5ErkJggg==
[image34]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEIAAAAaCAYAAAADiYpyAAACEklEQVR4Xu2Wv0scURDHJ0oUrEwaLWxFu6D5C0wKC4uIhZVFBLUKqChYBNKkSmORTsRSyyCICibFFQbURBBSpRG1sVBJUNAQ88P53tx5b7/uce/dWlzxPvCF3e/czs7tzpt9IpFIJFKZFdX/ANUKI6qfUqprPxnO80uStc8kw0nwg8EUj/90Z4pXC1R6SW9Uw2wyj8U6wqVOLOke+eCIjSoYUv1jU1lQfWbTg3PVuFjN7ykGTtlIY1X1gLwJsaQvyG9QzZIXQpek551U/VG1ku/DE9V04bhcV6R5d8CTZH5I+sXNqhY2PUDXYa2+Jf+52H16yA/hg6q+cPxRLN+zUjjPNp17U+7JhoJOO1Stkd+m+quaIr8a3DqLSxrdVWRM1euce4Oni2RfORDIuupAksvuoepEteh4WcFXw+VSrP7GwvmxEwsCnxck6uOAJ6/FlsEj8nOqb+RlxZ0Prof6vxTOq+7sC8lwsTKnOhMbrC7fVZ/Iy8qylOaDS3Fpoxs3KebNfc0HvP0d8jBs0S3vyK+WcnWiKxHDBosHpxd4i/cxH4o0iX3j0SUu3WL34U1cKFdsOGR6ofNiF78kPyvtYnlHycduD34H+T7sii3BcmxJ4IMYEJu02DsgMYQ58VsCE3nQL5bzKfnYDaJz0EGVeCX2W9SJmq+T4VvQ3Uts1hrY+2NWMDnVBpuRSCQSiUQitcwNCDCHCMBPQqwAAAAASUVORK5CYII=
[image35]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEUAAAAZCAYAAABnweOlAAACzElEQVR4Xu2XS8hNURTH/155RFJSnimUFDFWFAYGimSkMPSKkDLB4EuZKCkU5THBgMKEwkiIoYFITLzf73de69/a67v7rLvv2ff7vpTB/tW/e/Z/rb3POevss8++QKFQKPxbNotWezPwTrRMNEw0VLRE9LaSoUwU3RD9EV1ysRQHRZ+g+dT3ariJl2jkfhGdF02FXp/51AfRK9HH0P4hmoQ2OQHtYIOtqYY7iU9oGlPJAGYH35ju2nVcFp1GPv8sNIc37FkAjW3wAeEFNDbNB3LkirJTtF8018UM5viZxoJfd14KFqUvdIw9LmZsEfVDvij+GsgoNB5ml8gVpY4R0Bz+xlwIfg4WhdRduPm5oqz0AegrXzd2S3pSlO1I5xxB2vdYUVZB80dGMTJQtD4cd6co16CxVrO8Jbmi3BXdgp7gJ3S6G2dCjmcf0r7HikKYfydqk4vRca4oW0UToAsrF+HXol/QNa7LcMC13gww1j9qnwuewZtK3TzXB/qjfcARF+UBmsd6Gh3nirJbNAc6K+aLOoK/o5HaPuy4zpstmAzN3xbax0Pbsxfqx7MqRVwUPmX24RaAzBJNaYSzRUm9PkOgsWc+kIOd7L319HHt3tD826Hdak05hLTviYtC2Od3OOZeI6Y7RSGMUeN8oA52SH3j70FjAyJvcPCuhPbM0O7p18c4DO3XCzoLY3JF4WKdwoqy2AfqYIeN3oS+45+dx3eV+UsjL3VC7lbfOC+FLwrheNy1clZ6v64oqX0KsaK0zXBoh10+IIwV3XfeN9FX53FW8Ktk8ClzzPGRl2IQNO+o8/nFsFfIsA3ee+eTFdDYJufzr4nt2he5WJKT0P8Tj0QPw+9z6CAxy6GDPg6/V6vhTm5CZ9UpaN68ariJY9DFz84dzyo++YVRm/9nnqB6nbyOGWjMAhMLynvgtfCTfAD5xb5QKBQKhULhv+Uv0cvu6vWVhQIAAAAASUVORK5CYII=
[image36]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADsAAAAZCAYAAACPQVaOAAACPUlEQVR4Xu2WPWtVQRCGX6JExUAItkqCNkKK1GkTBBGEgCGFoAg2/ggtrPwHASWVRToLCxUsVNDYSBIICYKa+I0h+BEJokVQ52V2vXPm7p57PRAE2Qdezp6Z2dmdPcueBQqFwv/AoOiXNwqbojOiAVG/aFL0pRLRzkdorqgDVXeFXlRjPwX7muiHsbPNcT+LvgfbkxD718SkHjuRqIOViDxvofEL3mG4LbqH9NgkN699yPtquSv6hnRH2q6IpkXjzteJVdE60nkjG2hWLHkG9U15Rw5+pZtobT1PytYtLHYYmuOU85FR0QiaF7sI9V3wjhwx0U4VS5hj2zoCPA9I02LrfG3cEB0K7bpiuV1WRI+hk95dicgTi51FOjfHJ90UeyToqOhksC2ZuFp4QnKQSF2xe8w7D5RUXAqeqKQH2uea8V1Ea9G6KXYs6JjohGgZuvBDfyJr8MlzxXq4soy75B0JXpn2T1Tz23Y3xaa4BfVNeIflKnTSllyxu9x7/EpPnT3FG9M+B+03JNqP6qHStFjSyY87oodOsRPbMyHuRbDtDe+kL9geGVsO/mct7PdS9MDZd7TYFKlO/DL8/1qOQ+NOO3uK9+79ObTva2dvWux5qK/Tja6NVFKe1PFEjfDaxutaJy5D89mrIv/ptB02NjIf7Nw1ntS8SCw05cvCqxxvOdxyFNv2znkWmpBfic8548vBlX4HzfdBdN/47Na+Dr1BxViOEf+9X9EqJoqnLxd7K8Sz4EKhUCgUCv+I3++W1rf42QU4AAAAAElFTkSuQmCC
[image37]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAZCAYAAACclhZ6AAAB6klEQVR4Xu2Wv0tcQRSFrzESCyUExCqWohAQtJeIWqRJIQhCwBBMmiiKAYsgCBb+aKwttEkXRAsrC7EJifkPJKIGFo2KiBgIRgmBeA4z69535+muKLKB+eBjvWfuzM64771dkUgkclOG4Fsben7CbvgIPoSd8DjRUQR8hH/gP29vcviC7Lj2caKjyMh3mEk4DdvMWFGS7zD/Fbd9mFdwAi74+gmchc+zDaAOzsBxlWlG4Tb8AJvE3asFke8wG3ANfoV/4f1ER8iY5O6vDKyEJb7egZ/gU9/Lv+0/jDXnZOED57IHVAAn99nQw7EHql7yWT5+iOsrV9k7n/WojDBrMLWmUa55mH4bXkK9uP4RO2DISLgpbshmhFmLqekibFZ5QXDigA09paa+J67/m8ktWxJu/E1KRpi1qrraZ9oKNX4lbB60oeQ2pC8VLsrsi8rS2JRw469TMmIPoy/rdnHj/PIuCDbzerbwaXJismfi+l+Y3JKRcONXfTL6O8z+wuiQ9HkBVeIap+wAqIHfTXYGT02WxqGEGxj2WZnKsp90l8pY16r6Pfys6oB5cW/Ipw4fl3w9EPcTR/NS3OK7/nU1OZzKkeTW5Zq8VH6JW4PZPlyG63DPZxz7zclgRdzNz/ejcz6PRCKRSOROOQfKPItESY0t0gAAAABJRU5ErkJggg==
[image38]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAZCAYAAACclhZ6AAACFklEQVR4Xu2WzUtVQRjG36ywRZG5cGMto0AwbK0k5UIEoUgIgkTURS7bRRC4UNu4MchFbly0CV20CBfRJrTwH4iiEi5+hZQoRB+LPnyeOzPe97xnyquLuML84Ie+zztnnHPPzPGKJBKJvXIOrsM/cB7WZNtFNuENeAIeh11wIzOiArgJ76v6kbibOq8ywsx6MjOiAggLKye7B8fhJdOrGJYlvvBYtu+4I27hHSbfy830wBE47esGOAE7wwBwBj6EwyrTDMJFOClu6/OslsVlcYsesw1x+Tv4Gr6CP+GhzIg8Q1J6ygV4DB7w9RJ8AS/4sfzdfmCseU2AL5wBVf+VUTgFf0n8THDialXP+GwnwjY+orJbPutVGWHWaGpNk5R5M4F6cZM8tQ3DWXHj7tqGoSD5RXFBNiPMWk1Nn8AWle+KMInmoKmrxI15Y3LLB8nP1R/JCLOLqq7zmfao6ufgtuKh1IQLm30dFqS3CidlNqeyGO8lv/C+SEbszeht3Sauz3/eUa5KaeGakIWnwbfJ11K7SLu4MddNbilIfv5/PRl9Xu03jCsSv24bNvUnwAPIjAc8cAouqJr8gN9NFuOT5BcQXv+HVRae9DWVsT6t6ttwVtU5auFvcRd+9j8fZEY4usX1VvzPl9l2FH7f49uMr+E1cVvli7g5mH2Ez+BbuOoz9r7xYvBc3OHn36OPfZ5IJBKJxH9lC36AmPavcPCgAAAAAElFTkSuQmCC
