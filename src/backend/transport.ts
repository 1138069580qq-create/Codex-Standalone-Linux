import { EventEmitter } from "events";
import WebSocket from "ws";

/**
 * The persisted configuration shape is intentionally kept compatible with
 * config.ts. The optional limits make the transport testable without changing
 * the panel configuration schema.
 */
export interface TransportOptions {
  type: "unix" | "websocket";
  endpoint: string;
  bearerTokenEnv?: string;
  requestTimeoutMs?: number;
  /** Alias retained for small standalone callers. requestTimeoutMs wins. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  clientInfo?: { name: string; version: string; title?: string | null };
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

type JsonRpcId = string | number;
type ConnectionState = "idle" | "connecting" | "connected";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Attach-only JSON-RPC connection to the existing Codex desktop backend.
 * No process lifecycle is owned by this client. Both the Unix control socket
 * and regular WebSocket endpoints use an HTTP Upgrade followed by one JSON
 * object per text WebSocket message (Codex 0.153.4).
 */
export class CodexRpcClient extends EventEmitter {
  readonly options: TransportOptions;
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxFrameBytes: number;

  serverInfo?: unknown;

  private state: ConnectionState = "idle";
  private connectPromise?: Promise<void>;
  private generation = 0;
  private endedGeneration = 0;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private websocket?: WebSocket;

  constructor(options: TransportOptions) {
    super();
    if (!options || (options.type !== "unix" && options.type !== "websocket")) {
      throw new Error("Codex RPC is attach-only; use an existing Unix or WebSocket endpoint.");
    }
    this.options = options;
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? options.timeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  /** Opens exactly one configured transport and performs the app-server handshake. */
  async connect(): Promise<void> {
    if (this.state === "connected") return;
    if (this.connectPromise) return this.connectPromise;

    const generation = ++this.generation;
    this.endedGeneration = 0;
    this.state = "connecting";
    this.serverInfo = undefined;

    const attempt = this.connectInternal(generation);
    this.connectPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    }
  }

  /** Sends a JSON-RPC request. Requests are never retried by this transport. */
  request<T = any>(method: string, params?: unknown): Promise<T> {
    return this.requestInternal<T>(method, params, false);
  }

  /** Sends a JSON-RPC notification without creating a pending request. */
  notify(method: string, params?: unknown): void {
    this.assertMethod(method);
    if (!this.connected) throw new Error("Codex RPC transport is not connected.");
    this.sendMessage(params === undefined ? { method } : { method, params });
  }

  /** Resolves a server-originated JSON-RPC request. */
  respond(id: JsonRpcId, result: unknown): void {
    this.assertId(id);
    if (!this.connected) throw new Error("Codex RPC transport is not connected.");
    // JSON.stringify omits undefined object fields; JSON-RPC requires result.
    this.sendMessage({ id, result: result === undefined ? null : result });
  }

  /** Rejects a server-originated JSON-RPC request. */
  reject(id: JsonRpcId, error: { code: number; message: string }): void {
    this.assertId(id);
    if (!this.connected) throw new Error("Codex RPC transport is not connected.");
    if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
      throw new Error("Invalid JSON-RPC error response.");
    }
    this.sendMessage({ id, error: { code: error.code, message: error.message } });
  }

  /** Disconnects only this client socket; the attached backend is untouched. */
  close(): void {
    if (this.state === "idle" && !this.websocket) return;
    this.disconnect(new Error("Codex RPC transport closed."), this.generation);
  }

  private async connectInternal(generation: number): Promise<void> {
    try {
      await this.openConfiguredTransport(generation);
      this.assertCurrent(generation);

      this.serverInfo = await this.requestInternal(
        "initialize",
        {
          clientInfo: this.options.clientInfo || { name: "codex-standalone-webui", version: "1.0.0" },
          capabilities: { experimentalApi: true }
        },
        true
      );
      this.assertCurrent(generation);
      this.sendMessage({ method: "initialized" });
      this.assertCurrent(generation);
      this.state = "connected";
    } catch (cause) {
      const error = asError(cause, "Could not connect to Codex app-server.");
      this.disconnect(error, generation);
      throw error;
    }
  }

  private async openConfiguredTransport(generation: number): Promise<void> {
    switch (this.options.type) {
      case "unix":
        await this.openWebSocket(this.unixSocketUrl(), generation);
        return;
      case "websocket":
        await this.openWebSocket(this.options.endpoint, generation);
        return;
      default:
        throw new Error("Codex RPC is attach-only; use an existing Unix or WebSocket endpoint.");
    }
  }

  private openWebSocket(address: string, generation: number): Promise<void> {
    if (!address) return Promise.reject(new Error("Codex WebSocket endpoint is required."));

    const headers: Record<string, string> = {};
    if (this.options.type === "websocket" && this.options.bearerTokenEnv) {
      const token = process.env[this.options.bearerTokenEnv];
      if (!token)
        return Promise.reject(new Error("Configured Codex WebSocket bearer token is unavailable."));
      headers.Authorization = `Bearer ${token}`;
    }

    let websocket: WebSocket;
    try {
      websocket = new WebSocket(address, {
        headers,
        handshakeTimeout: this.connectTimeoutMs,
        maxPayload: this.maxFrameBytes,
        perMessageDeflate: false
      });
    } catch (cause) {
      return Promise.reject(asError(cause, "Could not create Codex WebSocket connection."));
    }

    this.websocket = websocket;
    websocket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.disconnect(new Error("Codex WebSocket sent a binary JSON-RPC frame."), generation);
        return;
      }
      const frame = rawDataToBuffer(data);
      if (frame.length > this.maxFrameBytes) {
        this.disconnect(
          new Error("Codex WebSocket frame exceeds the configured limit."),
          generation
        );
        return;
      }
      this.receiveJsonFrame(frame, generation);
    });
    websocket.on("error", (error: Error) => this.disconnect(error, generation));
    websocket.on("close", () => this.disconnect(new Error("Codex WebSocket closed."), generation));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        websocket.off("open", onOpen);
        websocket.off("error", onError);
        websocket.off("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error("Timed out connecting to Codex WebSocket.");
        this.disconnect(error, generation);
        finish(error);
      }, this.connectTimeoutMs);
      const onOpen = (): void => finish();
      const onError = (error: Error): void => finish(error);
      const onClose = (): void => finish(new Error("Codex WebSocket closed during connection."));
      websocket.once("open", onOpen);
      websocket.once("error", onError);
      websocket.once("close", onClose);
    });
  }

  /** ws supports HTTP Upgrade over a Unix socket through its ws+unix URL form. */
  private unixSocketUrl(): string {
    const socketPath = this.options.endpoint;
    if (!socketPath || !socketPath.startsWith("/"))
      throw new Error("Codex Unix socket path must be absolute.");
    // `ws` parses ws+unix:///socket/path:/rpc-path into socketPath + HTTP path.
    // app-server's tokio-tungstenite acceptor accepts the normal WebSocket GET
    // upgrade at `/`; it is not a newline-delimited stream.
    return `ws+unix://${socketPath}:/`;
  }

  private requestInternal<T>(
    method: string,
    params: unknown,
    allowConnecting: boolean
  ): Promise<T> {
    this.assertMethod(method);
    if (this.state !== "connected" && !(allowConnecting && this.state === "connecting")) {
      return Promise.reject(new Error("Codex RPC transport is not connected."));
    }

    const id = this.allocateId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.reject(new Error(`Codex RPC request timed out after ${this.requestTimeoutMs}ms.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });

      try {
        this.sendMessage(params === undefined ? { id, method } : { id, method, params });
      } catch (cause) {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.reject(asError(cause, "Could not send Codex RPC request."));
      }
    });
  }

  private allocateId(): number {
    for (let attempts = 0; attempts < Number.MAX_SAFE_INTEGER; attempts += 1) {
      const id = this.nextId;
      this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new Error("Codex RPC request id space is exhausted.");
  }

  private sendMessage(message: Record<string, unknown>): void {
    const encoded = this.serializeFrame(message);
    const generation = this.generation;

    if (this.websocket) {
      if (this.websocket.readyState !== WebSocket.OPEN)
        throw new Error("Codex WebSocket is not open.");
      if (this.websocket.bufferedAmount > this.maxFrameBytes) {
        const error = new Error("Codex WebSocket outgoing queue exceeds the configured limit.");
        this.disconnect(error, generation);
        throw error;
      }
      this.websocket.send(encoded, (error?: Error) => {
        if (error) this.disconnect(error, generation);
      });
      return;
    }

    throw new Error("Codex RPC transport is not open.");
  }

  private serializeFrame(message: Record<string, unknown>): string {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(message);
    } catch {
      throw new Error("Codex RPC message is not JSON serializable.");
    }
    if (typeof encoded !== "string") throw new Error("Codex RPC message is invalid.");
    if (Buffer.byteLength(encoded) > this.maxFrameBytes)
      throw new Error("Codex RPC frame exceeds the configured limit.");
    return encoded;
  }

  private receiveJsonFrame(frame: Buffer, generation: number): void {
    if (!this.isCurrent(generation)) return;
    let message: unknown;
    try {
      message = JSON.parse(frame.toString("utf8"));
    } catch {
      this.disconnect(new Error("Codex RPC received invalid JSON."), generation);
      return;
    }
    this.receiveMessage(message, generation);
  }

  private receiveMessage(message: unknown, generation: number): void {
    if (!isRecord(message)) {
      this.disconnect(new Error("Codex RPC received an invalid message."), generation);
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = typeof message.method === "string";
    if (hasMethod && hasId) {
      if (!isJsonRpcId(message.id)) {
        this.disconnect(new Error("Codex RPC request id is invalid."), generation);
        return;
      }
      this.emit("request", { id: message.id, method: message.method, params: message.params });
      return;
    }
    if (hasMethod) {
      this.emit("notification", { method: message.method, params: message.params });
      return;
    }
    if (!hasId || !isJsonRpcId(message.id)) {
      this.disconnect(new Error("Codex RPC received an invalid message."), generation);
      return;
    }

    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError) {
      this.disconnect(new Error("Codex RPC response is invalid."), generation);
      return;
    }

    const pending = this.pending.get(message.id);
    // A response for a timed-out request is harmless; do not turn it into a
    // connection failure or replay the original mutation.
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (hasError) {
      const error = message.error;
      if (!isJsonRpcError(error)) {
        pending.reject(new Error("Codex RPC returned an invalid error response."));
        return;
      }
      pending.reject(new CodexRpcError(error.code, error.message, error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private disconnect(reason: Error, generation: number): void {
    if (generation !== this.generation || this.endedGeneration === generation) return;
    this.endedGeneration = generation;
    this.state = "idle";
    this.serverInfo = undefined;

    const websocket = this.websocket;
    this.websocket = undefined;

    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();

    // Disconnect only our socket; do not send a backend shutdown request.
    if (websocket) {
      try {
        websocket.terminate();
      } catch {
        /* already closed */
      }
    }
    this.emit("disconnect", reason);
  }

  private isCurrent(generation: number): boolean {
    return (
      generation === this.generation && this.endedGeneration !== generation && this.state !== "idle"
    );
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation))
      throw new Error("Codex RPC transport disconnected during connection.");
  }

  private assertMethod(method: string): void {
    if (typeof method !== "string" || !method)
      throw new Error("Codex RPC method must be a non-empty string.");
  }

  private assertId(id: JsonRpcId): void {
    if (!isJsonRpcId(id)) throw new Error("Codex RPC id must be a string or safe integer.");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Codex RPC limit must be a positive safe integer.");
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return isRecord(value) && Number.isInteger(value.code) && typeof value.message === "string";
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}
