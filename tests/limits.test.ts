import {fakeHistoryReader} from './fixtures/history-peer';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { ConfigStore, defaultConfig, type Identity } from "../src/backend/config";
import { CommandReceipts } from "../src/backend/receipts";
import { CodexConsoleService } from "../src/backend/service";
import { normalizeRateLimits } from "../src/backend/limits";

class LimitsPeer extends EventEmitter {
  connected = true;
  serverInfo = { userAgent: "limits-fixture" };
  calls: Array<{ method: string; params: any }> = [];
  resetCalls = 0;
  async connect() {}
  close() {
    this.connected = false;
  }
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === "initialize") return this.serverInfo as T;
    if (method === "account/rateLimits/read")
      return {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1700000000 },
          secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 1700600000 }
        },
        rateLimitResetCredits: {
          availableCount: this.resetCalls ? 0 : 1,
          details: this.resetCalls
            ? []
            : [{ id: "credit-1", title: "Fixture reset", expiresAt: 1700700000 }]
        }
      } as T;
    if (method === "account/rateLimitResetCredit/consume") {
      this.resetCalls += 1;
      return { outcome: "reset" } as T;
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limits-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const config = new ConfigStore(path.join(root, "config.json"));
  const value = defaultConfig();
  value.enabled = true;
  value.projects = [
    {
      id: "p",
      name: "P",
      root: projectRoot,
      grants: [{ userId: "user", permissions: ["view", "send"] }]
    }
  ];
  config.value = value;
  const peer = new LimitsPeer();
  const service = new CodexConsoleService(
    config,
    new CommandReceipts(path.join(root, "receipts.json")),
    () => peer as any, fakeHistoryReader((m,p)=>peer.request(m,p))
  );
  await service.connect();
  return {
    service,
    peer,
    user: { uuid: "user", elevated: false } as Identity,
    admin: { uuid: "admin", elevated: true } as Identity
  };
}

test("normalizes primary/weekly quota windows and reset credits", () => {
  const result = normalizeRateLimits({
    rateLimits: { secondary: { usedPercent: 71, windowDurationMins: 10080, resetsAt: 1700000000 } },
    rateLimitResetCredits: { availableCount: 1, details: [{ id: "x", title: "X" }] }
  });
  assert.equal(result.windows[0].windowDurationMins, 10080);
  assert.equal(result.windows[0].usedPercent, 71);
  assert.equal(result.resetCredits?.availableCount, 1);
});

test("reads shared limits and only administrators can consume a reset credit", async (t) => {
  const { service, peer, user, admin } = await fixture();
  t.after(() => service.disconnect());
  const limits = await service.rateLimits(user);
  assert.deepEqual(
    limits.windows.map((w) => w.windowDurationMins),
    [15, 10080]
  );
  assert.equal(limits.resetCredits?.details[0].id, "credit-1");
  await assert.rejects(
    service.consumeRateLimitReset(user, "reset-request-1", "credit-1"),
    /administrator/i
  );
  const first = await service.consumeRateLimitReset(admin, "reset-request-1", "credit-1");
  assert.equal(first.outcome, "reset");
  assert.equal(first.rateLimits.resetCredits?.availableCount, 0);
  const callCount = peer.resetCalls;
  const replay = await service.consumeRateLimitReset(admin, "reset-request-1", "credit-1");
  assert.equal(replay.outcome, "reset");
  assert.equal(peer.resetCalls, callCount);
});
