import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig, validateConfig } from "../src/backend/config";

test("remote WebSocket plaintext and credentials in endpoint fail closed", async () => {
  for (const endpoint of [
    "ws://public.example:4500",
    "wss://user:pass@example.test",
    "wss://example.test/?token=secret",
    "file:///etc/passwd"
  ]) {
    const value = defaultConfig();
    value.transport.type = "websocket";
    value.transport.endpoint = endpoint;
    await assert.rejects(validateConfig(value));
  }
  const value = defaultConfig();
  value.transport.type = "websocket";
  value.transport.endpoint = "ws://127.0.0.1:4500";
  assert.equal((await validateConfig(value)).transport.endpoint, value.transport.endpoint);
  value.transport.bearerTokenEnv = "actual token containing spaces";
  await assert.rejects(validateConfig(value));
});
test("standalone core has no ElementsPanel imports and transport never spawns Codex", () => {
  const transport = readFileSync(path.resolve(__dirname, "../src/backend/transport.ts"), "utf8");
  const server = readFileSync(path.resolve(__dirname, "../src/server.ts"), "utf8");
  assert.doesNotMatch(transport, /spawn\(/);
  assert.doesNotMatch(server, /PanelPluginContext|ElementsPanel/);
  assert.match(server, /CSRF_DENIED/);
  assert.match(server, /app\.proxy = false/);
});
