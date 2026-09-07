import test from "node:test";
import assert from "node:assert/strict";
import { normalizeItem, MAX_ITEM_CHARS } from "../src/backend/normalize";
import { ReplayHub } from "../src/backend/events";

test("normalization never reveals hidden reasoning and always bounds output", () => {
  const item = normalizeItem({
    id: "r",
    type: "reasoning",
    text: "hidden",
    encrypted_content: "secret",
    summary: ["public summary"]
  });
  assert.equal(item.text, "public summary");
  assert.equal(JSON.stringify(item).includes("secret"), false);
  const long = normalizeItem({
    id: "a",
    type: "agentMessage",
    text: "x".repeat(MAX_ITEM_CHARS + 1)
  });
  assert.equal(long.text.length, MAX_ITEM_CHARS);
  assert.equal(long.truncated, true);
  const file = normalizeItem({
    id: "f",
    type: "fileChange",
    changes: [{ path: "app.ts", kind: { type: "update" }, diff: "do not preload full diff" }]
  });
  assert.equal(file.text, "update app.ts");
  assert.equal(JSON.stringify(file).includes("preload"), false);
});
test("replay stores immutable event payloads, not references to the mutable session", () => {
  const hub = new ReplayHub();
  const cursor = hub.cursor;
  const payload = { text: "before" };
  hub.publish({ type: "item", projectId: "p", threadId: "t", payload });
  payload.text = "after";
  assert.equal(hub.replay(cursor, "p", "t")![0].payload.text, "before");
});
