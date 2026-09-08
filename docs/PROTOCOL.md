# Protocol provenance and compatibility

Official source consulted on 2026-09-07: https://developers.openai.com/codex/app-server

The official page was fetched successfully (HTTP 200). The implementation follows its initialize → initialized handshake, thread / turn primitives and JSON-RPC request, notification and server-request framing. The page documents WebSocket TCP and Unix listeners; a Unix app-server endpoint uses WebSocket framing, not newline-delimited stdio JSON.

Runtime tested against **codex-cli 0.153.4**, with real Unix and TCP WebSocket transports on Linux and real WebSocket attachment through the browser on Windows. This identifies the binary actually tested; it is not a claim that this is the latest Codex release.

Main methods:

- `initialize`, `initialized`
- `model/list`
- `thread/list`, `thread/read`, `thread/resume`, `thread/turns/list`
- `thread/start`, `thread/name/set`
- `turn/start`, `turn/interrupt`
- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`
- `account/rateLimits/read`, `account/rateLimitResetCredit/consume` (availability depends on version and account)

The core uses the experimental API capability to access supported thread/turn APIs. Unsupported methods / approvals fail visibly; quota and reset cards are not synthesized. The raw upstream error and credential-bearing payloads are not sent to browsers.

Opening a task invokes `thread/resume`, which attaches the WebUI client to that existing task. This is separate from raw read-only endpoint discovery; discovery initializes a connection but never creates or resumes tasks or calls a model.

Production transport code rejects stdio / process-launch configuration and never spawns Codex. Only explicitly enabled integration tests launch an isolated **real Codex test process**, with a fresh CODEX_HOME, no copied authentication, and no model invocation.

A working test process proves wire compatibility, not that any particular desktop instance exposes an externally usable endpoint. Browser login is independent of Codex account login. This repo does not scrape desktop authentication or bypass endpoint restrictions.


## v1.1 desktop attachment (experimental, 2026-09-08)

The optional desktop runner attaches to an explicitly selected existing local task through the desktop's owner/follower IPC, not the standard app-server WebSocket. The owner identity and thread are checked. This is version-sensitive internal IPC, not an official compatibility guarantee. No vendor application code or credentials are included in this repository.

Snapshots / patches synchronize public history and task settings. Default sends use desktop setting inheritance; only explicit user overrides are forwarded. Model metadata comes from the desktop config's model_catalog_json (if set) or its fallback cache, with filesystem change notifications. Only allowlisted model metadata is exposed; provider credentials and model instructions are never returned. Catalog metadata does not prove upstream model availability. Quota/reset cards, extension catalogs, MCP, goal writes and approval replies are not implemented by this desktop adapter.

Regular app-server mode additionally adapts skills/list, plugin/installed, mcpServerStatus/list and thread/goal APIs where supported. Skills and installed plugin selections are validated on the backend and translated to server-owned structured inputs.
