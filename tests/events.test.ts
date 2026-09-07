import test from "node:test";
import assert from "node:assert/strict";
import { ReplayHub } from "../src/backend/events";

test("replays from a valid cursor without leaking another project or thread", () => {
  const hub = new ReplayHub();
  const initial = hub.cursor;
  hub.publish({
    type: "item",
    projectId: "alpha",
    threadId: "thread-a",
    payload: { marker: "alpha-a-1" }
  });
  hub.publish({
    type: "item",
    projectId: "bravo",
    threadId: "thread-b",
    payload: { marker: "bravo-b-1" }
  });
  hub.publish({
    type: "delta",
    projectId: "alpha",
    threadId: "thread-other",
    payload: { marker: "alpha-other" }
  });
  hub.publish({
    type: "status",
    projectId: "alpha",
    threadId: "thread-a",
    payload: { marker: "alpha-a-2" }
  });

  const replay = hub.replay(initial, "alpha", "thread-a");
  assert.ok(replay);
  assert.deepEqual(
    replay.map((event) => event.payload.marker),
    ["alpha-a-1", "alpha-a-2"]
  );
  assert.ok(replay.every((event) => event.projectId === "alpha" && event.threadId === "thread-a"));
  assert.equal(hub.replay("unknown-epoch:0", "alpha", "thread-a"), null);
});

test("rejects an evicted replay cursor rather than returning a partial event history", () => {
  const hub = new ReplayHub(2);
  const beforeEvents = hub.cursor;
  const first = hub.publish({
    type: "item",
    projectId: "alpha",
    threadId: "thread-a",
    payload: { marker: 1 }
  });
  hub.publish({ type: "item", projectId: "alpha", threadId: "thread-a", payload: { marker: 2 } });
  hub.publish({ type: "item", projectId: "alpha", threadId: "thread-a", payload: { marker: 3 } });

  assert.equal(hub.replay(beforeEvents, "alpha", "thread-a"), null);
  const replay = hub.replay(first.cursor, "alpha", "thread-a");
  assert.ok(replay);
  assert.deepEqual(
    replay.map((event) => event.payload.marker),
    [2, 3]
  );
});
