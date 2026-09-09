import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
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
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

type ThreadListGate = {
  cwd: string;
  claimed: boolean;
  started: Deferred<void>;
  result: Deferred<any>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeCodexPeer extends EventEmitter {
  connected = false;
  serverInfo = { userAgent: "fake-codex" };
  readonly requests: RequestCall[] = [];
  readonly responses: Array<{ id: string | number; result: unknown }> = [];
  readonly rejections: Array<{ id: string | number; error: { code: number; message: string } }> =
    [];
  readonly turnStarts: PendingTurnStart[] = [];
  private readonly turnStartWaiters: Array<{ count: number; resolve: () => void }> = [];
  private threadListGate?: ThreadListGate;

  constructor(private readonly threads: FakeThread[]) {
    super();
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  close(): void {
    this.connected = false;
  }

  holdNextThreadList(cwd: string): ThreadListGate {
    if (this.threadListGate) throw new Error("A thread/list gate is already active.");
    const gate: ThreadListGate = {
      cwd,
      claimed: false,
      started: deferred<void>(),
      result: deferred<any>()
    };
    this.threadListGate = gate;
    return gate;
  }

  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.requests.push({ method, params });
    switch (method) {
      case "thread/read":
      case "thread/resume":
        return { thread: this.thread(params.threadId) } as T;
      case "thread/turns/list":
        return { data: [], nextCursor: null } as T;
      case "thread/list": {
        const gate = this.threadListGate;
        if (gate && !gate.claimed && params.cwd === gate.cwd) {
          gate.claimed = true;
          gate.started.resolve(undefined);
          return gate.result.promise as T;
        }
        return { data: this.threads.filter((thread) => thread.cwd === params.cwd) } as T;
      }
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
          this.resolveTurnStartWaiters();
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
    await new Promise<void>((resolve) => this.turnStartWaiters.push({ count, resolve }));
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

  private resolveTurnStartWaiters(): void {
    for (let index = this.turnStartWaiters.length - 1; index >= 0; index -= 1) {
      if (this.turnStarts.length >= this.turnStartWaiters[index].count)
        this.turnStartWaiters.splice(index, 1)[0].resolve();
    }
  }
}

interface Fixture {
  service: CodexConsoleService;
  peer: FakeCodexPeer;
  identities: { alice: Identity; bob: Identity };
  roots: { projectOne: string; projectTwo: string; shared: string };
  receiptFile: string;
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "elements-codex-multiuser-"));
  const roots = {
    projectOne: path.join(dir, "project-one"),
    projectTwo: path.join(dir, "project-two"),
    shared: path.join(dir, "shared-project")
  };
  await Promise.all(Object.values(roots).map((root) => mkdir(root)));

  const identities = {
    alice: { uuid: "identity-A", elevated: false },
    bob: { uuid: "identity-B", elevated: false }
  } satisfies Record<"alice" | "bob", Identity>;
  const fullAccess = ["view", "send", "approve", "files"] as const;
  const projects: Project[] = [
    {
      id: "project-one",
      name: "Project one",
      root: roots.projectOne,
      grants: [{ userId: identities.alice.uuid, permissions: [...fullAccess] }]
    },
    {
      id: "project-two",
      name: "Project two",
      root: roots.projectTwo,
      grants: [{ userId: identities.bob.uuid, permissions: [...fullAccess] }]
    },
    {
      id: "shared",
      name: "Shared project",
      root: roots.shared,
      grants: [
        { userId: identities.alice.uuid, permissions: [...fullAccess] },
        { userId: identities.bob.uuid, permissions: [...fullAccess] }
      ]
    }
  ];
  const config = new ConfigStore(path.join(dir, "config.json"));
  config.value = {
    ...defaultConfig(),
    enabled: true,
    maxConcurrentTurns: 2,
    projects
  };
  const peer = new FakeCodexPeer([
    { id: "thread-project-one", cwd: roots.projectOne, status: "idle", name: "One" },
    { id: "thread-project-two", cwd: roots.projectTwo, status: "idle", name: "Two" },
    { id: "thread-shared-a", cwd: roots.shared, status: "idle", name: "Shared A" },
    { id: "thread-shared-b", cwd: roots.shared, status: "idle", name: "Shared B" }
  ]);
  const receiptFile = path.join(dir, "receipts.json");
  const service = new CodexConsoleService(
    config,
    new CommandReceipts(receiptFile),
    () => peer as any
  );
  await service.connect();
  return { service, peer, identities, roots, receiptFile };
}

function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof ConsoleError && error.code === code;
}

function settled(actor: string, promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ actor, status: "fulfilled" as const, value }),
    (reason) => ({ actor, status: "rejected" as const, reason })
  );
}

test("two distinct identities only see and act on their own exclusive projects", async (t) => {
  const { service, peer, identities } = await fixture();
  t.after(() => service.disconnect());
  const { alice, bob } = identities;
  assert.notEqual(alice.uuid, bob.uuid);

  assert.deepEqual(
    service
      .projects(alice)
      .map((project) => project.id)
      .sort(),
    ["project-one", "projectless", "shared"]
  );
  assert.deepEqual(
    service
      .projects(bob)
      .map((project) => project.id)
      .sort(),
    ["project-two", "projectless", "shared"]
  );

  const rpcBeforeForbiddenCalls = peer.requests.length;
  await assert.rejects(
    service.snapshot(alice, "project-two", "thread-project-two"),
    hasCode("PROJECT_FORBIDDEN")
  );
  await assert.rejects(
    service.send(alice, "project-two", "thread-project-two", {
      text: "Alice must not send here",
      requestId: "alice-forbidden-send-0001"
    }),
    hasCode("PROJECT_FORBIDDEN")
  );
  assert.equal(peer.requests.length, rpcBeforeForbiddenCalls);

  await service.snapshot(bob, "project-two", "thread-project-two");
  const events: any[] = [];
  t.after(service.hub.subscribe((event) => events.push(event)));
  peer.emit("request", {
    id: "bob-only-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-project-two",
      turnId: "turn-project-two",
      command: "git status",
      availableDecisions: ["accept", "decline"]
    }
  });
  const approval = events.find(
    (event) => event.type === "approval" && event.projectId === "project-two"
  );
  assert.ok(approval);

  await assert.rejects(
    service.answer(alice, "project-two", "thread-project-two", approval.payload.id, {
      decision: "accept"
    }),
    hasCode("PROJECT_FORBIDDEN")
  );
  assert.equal(peer.responses.length, 0);

  await service.answer(bob, "project-two", "thread-project-two", approval.payload.id, {
    decision: "accept"
  });
  assert.deepEqual(peer.responses, [{ id: "bob-only-approval", result: { decision: "accept" } }]);
});

test("identity A and B can start turns concurrently in different authorized projects", async (t) => {
  const { service, peer, identities, roots, receiptFile } = await fixture();
  t.after(() => service.disconnect());

  const aliceSend = service.send(identities.alice, "project-one", "thread-project-one", {
    text: "Alice works only in project one",
    requestId: "alice-project-one-0001"
  });
  const bobSend = service.send(identities.bob, "project-two", "thread-project-two", {
    text: "Bob works only in project two",
    requestId: "bob-project-two-0001"
  });

  await peer.waitForTurnStarts(2);
  assert.deepEqual(
    peer.turnStarts
      .map(({ params }) => ({ threadId: params.threadId, cwd: params.cwd }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId)),
    [
      { threadId: "thread-project-one", cwd: roots.projectOne },
      { threadId: "thread-project-two", cwd: roots.projectTwo }
    ]
  );

  peer.resolveTurnStart("thread-project-one");
  peer.resolveTurnStart("thread-project-two");
  assert.deepEqual(await aliceSend, { turnId: "turn-thread-project-one", status: "running" });
  assert.deepEqual(await bobSend, { turnId: "turn-thread-project-two", status: "running" });

  const receiptText = await readFile(receiptFile, "utf8");
  assert.match(receiptText, /identity-A/);
  assert.match(receiptText, /identity-B/);
});

test("event replay is isolated by both project and thread", async (t) => {
  const { service, peer, identities } = await fixture();
  t.after(() => service.disconnect());

  await Promise.all([
    service.snapshot(identities.alice, "project-one", "thread-project-one"),
    service.snapshot(identities.bob, "project-two", "thread-project-two"),
    service.snapshot(identities.alice, "shared", "thread-shared-a"),
    service.snapshot(identities.bob, "shared", "thread-shared-b")
  ]);
  const cursor = service.hub.cursor;

  for (const [threadId, turnId] of [
    ["thread-project-one", "turn-project-one"],
    ["thread-project-two", "turn-project-two"],
    ["thread-shared-a", "turn-shared-a"],
    ["thread-shared-b", "turn-shared-b"]
  ]) {
    peer.emit("notification", {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } }
    });
  }

  const projectOneEvents = service.hub.replay(cursor, "project-one", "thread-project-one");
  const projectTwoEvents = service.hub.replay(cursor, "project-two", "thread-project-two");
  const sharedAEvents = service.hub.replay(cursor, "shared", "thread-shared-a");
  assert.ok(projectOneEvents);
  assert.ok(projectTwoEvents);
  assert.ok(sharedAEvents);
  assert.deepEqual(
    projectOneEvents.map((event) => [event.type, event.projectId, event.threadId]),
    [["status", "project-one", "thread-project-one"]]
  );
  assert.deepEqual(
    projectTwoEvents.map((event) => [event.type, event.projectId, event.threadId]),
    [["status", "project-two", "thread-project-two"]]
  );
  assert.deepEqual(
    sharedAEvents.map((event) => [event.type, event.projectId, event.threadId]),
    [["status", "shared", "thread-shared-a"]]
  );
});

test("concurrent sends by two users in one shared project reject a conflicting writer", async (t) => {
  const { service, peer, identities, roots, receiptFile } = await fixture();
  t.after(() => service.disconnect());

  const gate = peer.holdNextThreadList(roots.shared);
  const aliceSend = service.send(identities.alice, "shared", "thread-shared-a", {
    text: "Alice starts a shared-project change",
    requestId: "alice-shared-project-0001"
  });
  const bobSend = service.send(identities.bob, "shared", "thread-shared-b", {
    text: "Bob starts a shared-project change",
    requestId: "bob-shared-project-0001"
  });

  await gate.started.promise;
  const firstSettlement = await Promise.race([
    settled("alice", aliceSend),
    settled("bob", bobSend)
  ]);
  assert.equal(firstSettlement.status, "rejected");
  assert.ok(firstSettlement.reason instanceof ConsoleError);
  assert.equal(firstSettlement.reason.status, 409);
  assert.ok(["THREAD_BUSY", "PROJECT_BUSY"].includes(firstSettlement.reason.code));

  gate.result.resolve({ data: [] });
  await peer.waitForTurnStarts(1);
  peer.resolveTurnStart(peer.turnStarts[0].params.threadId);
  const results = await Promise.allSettled([aliceSend, bobSend]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(peer.requests.filter((call) => call.method === "turn/start").length, 1);

  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  assert.ok(rejected?.reason instanceof ConsoleError);
  assert.equal(rejected?.reason.status, 409);
  assert.ok(["THREAD_BUSY", "PROJECT_BUSY"].includes(rejected?.reason.code));
  assert.match(await readFile(receiptFile, "utf8"), /identity-[AB]/);
});
