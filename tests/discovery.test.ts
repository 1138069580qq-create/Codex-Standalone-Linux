import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverExistingCodex } from "../src/backend/discovery";

test(
  "discovers and probes a real Codex app-server Unix socket without starting a process",
  { skip: !process.env.CODEX_DISCOVERY_SOCKET, timeout: 10000 },
  async () => {
    const socket = process.env.CODEX_DISCOVERY_SOCKET!;
    const result = await discoverExistingCodex({ roots: [path.dirname(socket)] });
    const candidate = result.find((item) => item.endpoint === socket);
    assert.ok(candidate, JSON.stringify(result));
    assert.equal(candidate.type, "unix");
    assert.equal(candidate.verified, true, JSON.stringify(candidate));
    assert.match(candidate.serverInfo || "", /codex/i);
  }
);

test("probes discovered runtime socket candidates and rejects non-loopback WebSockets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-discovery-unit-"));
  const socket = path.join(root, "codex.sock");
  await mkdir(socket);
  const probed: Array<{ type: string; endpoint: string }> = [];
  const result = await discoverExistingCodex({
    roots: [root],
    ssOutput:
      'tcp LISTEN 0 128 127.0.0.1:4500 0.0.0.0:* users:(("codex",pid=123,fd=1))\ntcp LISTEN 0 128 10.0.0.1:4501 0.0.0.0:* users:(("codex",pid=123,fd=2))',
    probe: async (candidate) => {
      probed.push(candidate);
      return "codex-fixture";
    }
  });
  assert.equal(
    result.some((item) => item.endpoint.includes("10.0.0.1")),
    false
  );
  assert.equal(
    result.some((item) => item.endpoint === "ws://127.0.0.1:4500"),
    true
  );
  assert.equal(result.find((item) => item.endpoint === "ws://127.0.0.1:4500")?.verified, true);
  assert.ok(probed.length >= 1);
});

test("discovery never accepts credential-bearing or remote WebSocket environment values", async () => {
  const previous = process.env.CODEX_EXISTING_ENDPOINT;
  try {
    process.env.CODEX_EXISTING_ENDPOINT = "wss://user:secret@example.invalid:4500/?token=secret";
    const result = await discoverExistingCodex({ roots: [], ssOutput: "" });
    assert.equal(
      result.some((item) => item.endpoint.includes("example.invalid")),
      false
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_EXISTING_ENDPOINT;
    else process.env.CODEX_EXISTING_ENDPOINT = previous;
  }
});
