import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, Server as HttpServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { CodexRpcClient, TransportOptions } from "../src/backend/transport";

const info = {
  userAgent: "codex-transport-test-server",
  codexHome: "/tmp/codex-test",
  platformFamily: "unix",
  platformOs: "linux"
};

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test event.");
    await sleep(5);
  }
}

function parseFrame(data: WebSocket.RawData): RpcMessage {
  if (Array.isArray(data)) return JSON.parse(Buffer.concat(data).toString("utf8"));
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"));
  return JSON.parse(Buffer.from(data).toString("utf8"));
}

function send(socket: WebSocket, message: RpcMessage): void {
  socket.send(JSON.stringify(message));
}

// Every backend in this suite is an in-process loopback server; no executable
// or existing desktop backend is used by the tests.
async function startPeer(
  t: TestContext,
  handler?: (socket: WebSocket, message: RpcMessage) => void,
  initialize = true
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  t.after(() => closeWebSocketServer(server));
  const frames: RpcMessage[] = [];
  const connections: WebSocket[] = [];
  server.on("connection", (socket) => {
    connections.push(socket);
    let initialized = false;
    socket.on("message", (raw, isBinary) => {
      assert.equal(isBinary, false);
      const message = parseFrame(raw);
      frames.push(message);
      if (message.method === "initialize") {
        assert.equal(message.params?.capabilities?.experimentalApi, true);
        if (initialize) send(socket, { id: message.id, result: info });
      } else if (message.method === "initialized") {
        initialized = true;
      } else if (message.method === "fixture/echo") {
        send(socket, { id: message.id, result: { initialized, value: message.params } });
      } else {
        handler?.(socket, message);
      }
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const client = (overrides: Partial<TransportOptions> = {}): CodexRpcClient => {
    const peer = new CodexRpcClient({
      type: "websocket",
      endpoint,
      requestTimeoutMs: 1_500,
      connectTimeoutMs: 2_000,
      ...overrides
    });
    t.after(() => peer.close());
    return peer;
  };
  return { server, endpoint, frames, connections, client };
}
async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

async function listen(server: HttpServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

test("attach-only: legacy stdio is rejected at runtime before any connection", async () => {
  assert.throws(
    () =>
      new CodexRpcClient({
        // @ts-expect-error Legacy runtime configuration must not be accepted by the public type.
        type: "stdio",
        endpoint: ""
      }),
    /attach-only/i
  );

  // Recheck at connect time too, in case an untyped caller mutates its options.
  const options: TransportOptions = { type: "websocket", endpoint: "" };
  const client = new CodexRpcClient(options);
  Object.assign(options, { type: "stdio" });
  await assert.rejects(client.connect(), /attach-only/i);
  assert.equal(client.connected, false);
  assert.equal(client.serverInfo, undefined);
  client.close();
});

test("attach-only: production transport contains no process or newline transport path", async () => {
  const source = await readFile(path.join(__dirname, "../src/backend/transport.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /child_process|\bspawn\b|\bkill\b|\bchild\b|openStdio|receiveDelimitedData|inputBuffer/
  );
  assert.doesNotMatch(source, /\bcommand\b|\bargs\b|codexHome|["']stdio["']/);
  const client = new CodexRpcClient({ type: "websocket", endpoint: "" });
  assert.equal(client.requestTimeoutMs, 30_000);
  assert.equal(client.connectTimeoutMs, 10_000);
  assert.equal(client.maxFrameBytes, 4 * 1024 * 1024);
});

test(
  "websocket: oversized frames are bounded and inbound failure rejects all pending",
  { timeout: 5_000 },
  async (t) => {
    const backend = await startPeer(t, (socket, message) => {
      if (message.method === "fixture/oversize") {
        send(socket, { method: "fixture/large", params: { data: "x".repeat(2_048) } });
      }
    });
    const client = backend.client({ maxFrameBytes: 512 });
    let disconnects = 0;
    client.on("disconnect", () => disconnects++);
    await client.connect();

    await assert.rejects(
      client.request("fixture/outbound-large", "x".repeat(2_048)),
      /frame exceeds/i
    );
    assert.equal(
      client.connected,
      true,
      "unsent oversized payload must not close a healthy socket"
    );
    assert.deepEqual(await client.request("fixture/echo", "after-outbound-limit"), {
      initialized: true,
      value: "after-outbound-limit"
    });
    assert.equal(
      backend.frames.some((message) => message.method === "fixture/outbound-large"),
      false
    );

    const pending = assert.rejects(client.request("fixture/never"), /payload|frame|closed/i);
    const large = assert.rejects(client.request("fixture/oversize"), /payload|frame|closed/i);
    await Promise.all([pending, large]);
    assert.equal(client.connected, false);
    assert.equal(client.serverInfo, undefined);
    assert.equal(disconnects, 1);
    await assert.rejects(client.request("fixture/echo"), /not connected/i);
    client.close();
    assert.equal(disconnects, 1);
  }
);

test(
  "websocket: initialize timeout clears state and does not reconnect",
  { timeout: 5_000 },
  async (t) => {
    const backend = await startPeer(t, undefined, false);
    const client = backend.client();
    let disconnects = 0;
    client.on("disconnect", () => disconnects++);
    await assert.rejects(client.connect(), /timed out/i);
    assert.equal(client.connected, false);
    assert.equal(client.serverInfo, undefined);
    assert.equal(disconnects, 1);
    await waitUntil(() => backend.server.clients.size === 0);
    assert.equal(backend.connections.length, 1);
    assert.equal(backend.frames.filter((message) => message.method === "initialize").length, 1);
    assert.equal(
      backend.frames.some((message) => message.method === "initialized"),
      false
    );
  }
);

test(
  "websocket: closing one of two clients leaves the shared backend and other client alive",
  { timeout: 5_000 },
  async (t) => {
    const backend = await startPeer(t);
    const first = backend.client();
    const second = backend.client();
    let firstDisconnects = 0;
    let secondDisconnects = 0;
    first.on("disconnect", () => firstDisconnects++);
    second.on("disconnect", () => secondDisconnects++);
    await Promise.all([first.connect(), second.connect()]);
    assert.equal(backend.connections.length, 2);
    const pendingA = assert.rejects(first.request("fixture/never-a"), /closed/i);
    const pendingB = assert.rejects(first.request("fixture/never-b"), /closed/i);
    await waitUntil(() => backend.frames.some((message) => message.method === "fixture/never-b"));

    first.close();
    first.close();
    await Promise.all([pendingA, pendingB]);
    assert.equal(first.connected, false);
    assert.equal(first.serverInfo, undefined);
    assert.equal(firstDisconnects, 1);
    await waitUntil(() => backend.server.clients.size === 1);
    assert.equal(second.connected, true);
    assert.deepEqual(await second.request("fixture/echo", "survivor"), {
      initialized: true,
      value: "survivor"
    });
    assert.equal(secondDisconnects, 0);
    assert.equal(backend.connections.length, 2, "no implicit replacement connection");
    assert.equal(
      backend.frames.some((message) => message.method === "shutdown" || message.method === "exit"),
      false
    );
    // Even after both detach the same server still accepts an explicit attachment.
    second.close();
    const third = backend.client();
    await third.connect();
    assert.deepEqual(await third.request("fixture/echo", "same-backend"), {
      initialized: true,
      value: "same-backend"
    });
    assert.equal(backend.connections.length, 3);
  }
);
test(
  "websocket: text frames, bearer header, server rejection, request timeout, and disconnect cleanup",
  { timeout: 6_000 },
  async (t) => {
    const tokenName = `CODEX_TRANSPORT_TOKEN_${process.pid}_${Date.now()}`;
    const token = "test-capability-token";
    process.env[tokenName] = token;
    t.after(() => delete process.env[tokenName]);

    const server = new WebSocketServer({ port: 0, perMessageDeflate: false });
    await once(server, "listening");
    t.after(async () => closeWebSocketServer(server));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const frames: RpcMessage[] = [];
    let authorization: string | undefined;
    let initialized = false;
    let neverRequests = 0;
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      socket.on("message", (raw, isBinary) => {
        assert.equal(isBinary, false, "Codex transport must send a text WebSocket frame");
        const message = parseFrame(raw);
        frames.push(message);
        if (message.method === "initialize") {
          assert.equal(message.params?.capabilities?.experimentalApi, true);
          send(socket, { id: message.id, result: info });
        } else if (message.method === "initialized") {
          initialized = true;
          send(socket, {
            method: "fixture/handshake",
            params: { experimentalApi: message.params === undefined }
          });
        } else if (message.method === "fixture/echo") {
          send(socket, { id: message.id, result: { initialized, value: message.params } });
        } else if (message.method === "fixture/server-reject") {
          send(socket, {
            id: "fixture-reject",
            method: "fixture/approval",
            params: { question: "reject?" }
          });
        } else if (message.id === "fixture-reject" && message.error) {
          const original = frames.find((item) => item.method === "fixture/server-reject");
          send(socket, { id: original?.id, result: { serverError: message.error } });
        } else if (message.method === "fixture/never") {
          neverRequests += 1;
        } else if (message.method === "fixture/drop") {
          socket.close();
        }
      });
    });

    const client = new CodexRpcClient({
      type: "websocket",
      endpoint: `ws://127.0.0.1:${address.port}`,
      bearerTokenEnv: tokenName,
      requestTimeoutMs: 1_500,
      connectTimeoutMs: 2_000
    });
    const notifications: Array<{ method: string; params: any }> = [];
    client.on("notification", (message) => notifications.push(message));
    client.on("request", (message) =>
      client.reject(message.id, { code: 499, message: "declined" })
    );
    t.after(() => client.close());

    await client.connect();
    assert.equal(authorization, `Bearer ${token}`);
    assert.deepEqual(client.serverInfo, info);
    await waitUntil(() => notifications.some((item) => item.method === "fixture/handshake"));
    assert.deepEqual(await client.request("fixture/echo", { transport: "ws" }), {
      initialized: true,
      value: { transport: "ws" }
    });
    assert.deepEqual(await client.request("fixture/server-reject"), {
      serverError: { code: 499, message: "declined" }
    });

    await assert.rejects(client.request("fixture/never"), /timed out/i);
    assert.equal(neverRequests, 1, "a timed-out request must be sent once, not retried");
    const dropped = client.request("fixture/drop");
    await assert.rejects(dropped, /closed|disconnected/i);
    assert.equal(client.connected, false);
    assert.equal(frames.filter((item) => item.method === "initialize").length, 1);
  }
);

test(
  "unix: uses the app-server WebSocket upgrade framing, not newline JSON",
  { skip: process.platform === "win32", timeout: 4_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-transport-unix-"));
    const socketPath = path.join(dir, "control.sock");
    const httpServer = createHttpServer();
    const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    httpServer.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (peer) =>
        webSocketServer.emit("connection", peer, request)
      );
    });
    await listen(httpServer, socketPath);
    t.after(async () => {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        webSocketServer.close((error) => (error ? reject(error) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve()))
      );
      // Leave the empty temporary directory; no filesystem deletion is performed.
    });

    let upgraded = false;
    let initialized = false;
    webSocketServer.on("connection", (socket) => {
      upgraded = true;
      socket.on("message", (raw, isBinary) => {
        assert.equal(isBinary, false);
        const message = parseFrame(raw);
        if (message.method === "initialize") send(socket, { id: message.id, result: info });
        else if (message.method === "initialized") initialized = true;
        else if (message.method === "fixture/echo")
          send(socket, { id: message.id, result: { initialized, value: message.params } });
      });
    });

    const client = new CodexRpcClient({
      type: "unix",
      endpoint: socketPath,
      connectTimeoutMs: 2_000
    });
    t.after(() => client.close());
    await client.connect();
    assert.equal(upgraded, true);
    assert.deepEqual(await client.request("fixture/echo", "unix"), {
      initialized: true,
      value: "unix"
    });
  }
);
