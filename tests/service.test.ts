import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ConfigStore,
  ConsoleError,
  defaultConfig,
  type Identity,
  type Project
} from "../src/backend/config";
import { CommandReceipts } from "../src/backend/receipts";
import { CodexConsoleService } from "../src/backend/service";

type FakeThread = { id: string; cwd: string; status: string; name?: string };
type RequestCall = { method: string; params: any };
type PendingTurnStart = { params: any; resolve: (result: any) => void };

class FakeCodexPeer extends EventEmitter {
  connected = false;
  serverInfo = { userAgent: "fake-codex" };
  readonly requests: RequestCall[] = [];
  readonly responses: Array<{ id: string | number; result: unknown }> = [];
  readonly rejections: Array<{ id: string | number; error: { code: number; message: string } }> =
    [];
  readonly turnStarts: PendingTurnStart[] = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(private readonly threads: FakeThread[]) {
    super();
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  close(): void {
    this.connected = false;
  }
  forceDisconnect(): void {
    this.connected = false;
    this.emit("disconnect", new Error("fake transport disconnected"));
  }

  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.requests.push({ method, params });
    switch (method) {
      case "thread/read":
        return { thread: this.thread(params.threadId) } as T;
      case "thread/resume":
        return { thread: this.thread(params.threadId) } as T;
      case "thread/turns/list":
        return { data: [], nextCursor: null } as T;
      case "thread/list":
        return { data: this.threads.filter((thread) => thread.cwd === params.cwd) } as T;
      case "model/list":
        return {
          data: [
            {
              id: "fake-default",
              model: "fake-default",
              isDefault: true,
              supportedReasoningEfforts: []
            }
          ]
        } as T;
      case "turn/start":
        return new Promise<T>((resolve) => {
          this.turnStarts.push({ params, resolve });
          this.resolveWaiters();
        });
      default:
        throw new Error(`Unexpected fake Codex RPC method: ${method}`);
    }
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }
  reject(id: string | number, error: { code: number; message: string }): void {
    this.rejections.push({ id, error });
  }

  async waitForTurnStarts(count: number): Promise<void> {
    if (this.turnStarts.length >= count) return;
    await new Promise<void>((resolve) => this.waiters.push({ count, resolve }));
  }

  resolveTurnStart(threadId: string): void {
    const index = this.turnStarts.findIndex((pending) => pending.params.threadId === threadId);
    if (index < 0) throw new Error(`No pending turn/start for ${threadId}`);
    const [pending] = this.turnStarts.splice(index, 1);
    pending.resolve({ turn: { id: `turn-${threadId}`, status: "inProgress" } });
  }

  private thread(id: string): FakeThread | undefined {
    return this.threads.find((thread) => thread.id === id);
  }
  private resolveWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      if (this.turnStarts.length >= this.waiters[index].count)
        this.waiters.splice(index, 1)[0].resolve();
    }
  }
}

interface Fixture {
  service: CodexConsoleService;
  peer: FakeCodexPeer;
  identity: Identity;
  roots: { alpha: string; bravo: string };
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "elements-codex-service-"));
  const roots = { alpha: path.join(dir, "alpha"), bravo: path.join(dir, "bravo") };
  await Promise.all([mkdir(roots.alpha), mkdir(roots.bravo)]);
  const identity: Identity = { uuid: "operator", elevated: false };
  const grants: Project["grants"] = [
    { userId: identity.uuid, permissions: ["view", "send", "approve", "files"] }
  ];
  const base = defaultConfig();
  const config = new ConfigStore(path.join(dir, "config.json"));
  config.value = {
    ...base,
    enabled: true,
    maxConcurrentTurns: 2,
    projects: [
      { id: "alpha", name: "Alpha", root: roots.alpha, grants },
      { id: "bravo", name: "Bravo", root: roots.bravo, grants }
    ]
  };
  const peer = new FakeCodexPeer([
    { id: "thread-alpha", cwd: roots.alpha, status: "idle", name: "Alpha thread" },
    { id: "thread-bravo", cwd: roots.bravo, status: "idle", name: "Bravo thread" }
  ]);
  const receipts = new CommandReceipts(path.join(dir, "receipts.json"));
  const service = new CodexConsoleService(config, receipts, () => peer as any);
  await service.connect();
  return { service, peer, identity, roots };
}

function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof ConsoleError && error.code === code;
}

test("service verifies a Codex thread belongs to the selected project before attaching it", async (t) => {
  const { service, peer, identity } = await fixture();
  t.after(() => service.disconnect());

  await assert.rejects(
    service.snapshot(identity, "alpha", "thread-bravo"),
    hasCode("THREAD_FORBIDDEN")
  );
  assert.equal(
    peer.requests.some(
      (call) => call.method === "thread/resume" && call.params.threadId === "thread-bravo"
    ),
    false
  );

  await service.snapshot(identity, "alpha", "thread-alpha");
  peer.emit("request", {
    id: "foreign-approval",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-bravo", command: "echo should-not-attach" }
  });
  assert.deepEqual(peer.rejections, [
    {
      id: "foreign-approval",
      error: { code: -32602, message: "Thread is not attached to an authorized project console." }
    }
  ]);
});

test(
  "service permits two independent project turns to begin concurrently",
  { timeout: 5000 },
  async (t) => {
    const { service, peer, identity, roots } = await fixture();
    t.after(() => service.disconnect());

    const alpha = service.send(identity, "alpha", "thread-alpha", {
      text: "Work in alpha",
      requestId: "alpha-request-0001"
    });
    const bravo = service.send(identity, "bravo", "thread-bravo", {
      text: "Work in bravo",
      requestId: "bravo-request-0001"
    });

    await peer.waitForTurnStarts(2);
    assert.equal(service.hasActiveWork, true);
    assert.deepEqual(
      peer.turnStarts
        .map((pending) => ({ threadId: pending.params.threadId, cwd: pending.params.cwd }))
        .sort((a, b) => a.threadId.localeCompare(b.threadId)),
      [
        { threadId: "thread-alpha", cwd: roots.alpha },
        { threadId: "thread-bravo", cwd: roots.bravo }
      ]
    );

    peer.resolveTurnStart("thread-alpha");
    peer.resolveTurnStart("thread-bravo");
    const [alphaResult, bravoResult] = await Promise.all([alpha, bravo]);
    assert.deepEqual(alphaResult, { turnId: "turn-thread-alpha", status: "running" });
    assert.deepEqual(bravoResult, { turnId: "turn-thread-bravo", status: "running" });
  }
);

test("service resolves a pending approval once and rejects a duplicate user decision", async (t) => {
  const { service, peer, identity } = await fixture();
  t.after(() => service.disconnect());
  await service.snapshot(identity, "alpha", "thread-alpha");
  const events: any[] = [];
  const unsubscribe = service.hub.subscribe((event) => events.push(event));
  t.after(unsubscribe);

  peer.emit("request", {
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-alpha",
      turnId: "turn-alpha",
      command: "git status",
      availableDecisions: ["accept"]
    }
  });
  const approval = events.find((event) => event.type === "approval");
  assert.ok(approval);

  await assert.doesNotReject(
    service.answer(identity, "alpha", "thread-alpha", approval.payload.id, { decision: "accept" })
  );
  assert.deepEqual(peer.responses, [{ id: "approval-1", result: { decision: "accept" } }]);
  await assert.rejects(
    service.answer(identity, "alpha", "thread-alpha", approval.payload.id, { decision: "accept" }),
    hasCode("APPROVAL_EXPIRED")
  );
  assert.equal(peer.responses.length, 1);
});

test("service clears attached state and never answers a stale approval after peer disconnect", async (t) => {
  const { service, peer, identity } = await fixture();
  t.after(() => service.disconnect());
  await service.snapshot(identity, "alpha", "thread-alpha");
  const events: any[] = [];
  const unsubscribe = service.hub.subscribe((event) => events.push(event));
  t.after(unsubscribe);

  peer.emit("request", {
    id: "approval-before-disconnect",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-alpha", command: "git status", availableDecisions: ["accept"] }
  });
  const approval = events.find((event) => event.type === "approval");
  assert.ok(approval);
  assert.equal(service.hasActiveWork, true);

  peer.forceDisconnect();
  assert.equal(service.hasActiveWork, false);
  const status = service.status(identity);
  assert.equal(status.connected, false);
  assert.match(status.reason || "", /pending commands will not be resent/i);
  assert.deepEqual(
    events.slice(-2).map((event) => [event.type, event.payload]),
    [
      ["connection", { connected: false }],
      ["reset", { reason: "backend-disconnected" }]
    ]
  );

  const requestsAtDisconnect = peer.requests.length;
  await assert.rejects(
    service.answer(identity, "alpha", "thread-alpha", approval.payload.id, { decision: "accept" }),
    hasCode("CODEX_OFFLINE")
  );
  assert.equal(peer.responses.length, 0);
  assert.equal(peer.requests.length, requestsAtDisconnect);
});

test("service handles simultaneous approval replies atomically", async (t) => {
  const { service, peer, identity } = await fixture();
  t.after(() => service.disconnect());
  await service.snapshot(identity, "alpha", "thread-alpha");
  const events: any[] = [];
  t.after(service.hub.subscribe((event) => events.push(event)));
  peer.emit("request", {
    id: "concurrent-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-alpha",
      command: "echo test",
      availableDecisions: ["accept", "decline"]
    }
  });
  const id = events.find((event) => event.type === "approval").payload.id;
  const results = await Promise.allSettled([
    service.answer(identity, "alpha", "thread-alpha", id, { decision: "accept" }),
    service.answer(identity, "alpha", "thread-alpha", id, { decision: "decline" })
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(peer.responses.length, 1);
});

test("service keeps a very fast completed turn idle even when start RPC resolves later", async (t) => {
  const { service, peer, identity } = await fixture();
  t.after(() => service.disconnect());
  const sending = service.send(identity, "alpha", "thread-alpha", {
    text: "test",
    requestId: "fast-turn-request-0001"
  });
  await peer.waitForTurnStarts(1);
  peer.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-alpha", turn: { id: "turn-thread-alpha", status: "completed" } }
  });
  peer.resolveTurnStart("thread-alpha");
  assert.equal((await sending).status, "idle");
  assert.equal(service.hasActiveWork, false);
});

test("service rejects unauthorized subscriptions before making any backend request", async (t) => {
  const { service, peer } = await fixture();
  t.after(() => service.disconnect());
  const before = peer.requests.length;
  await assert.rejects(
    service.snapshot({ uuid: "unassigned-user", elevated: false }, "alpha", "thread-alpha"),
    hasCode("PROJECT_FORBIDDEN")
  );
  assert.equal(peer.requests.length, before);
});
