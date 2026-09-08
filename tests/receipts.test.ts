import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsoleError } from "../src/backend/config";
import { CommandReceipts } from "../src/backend/receipts";

async function receiptFile(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `elements-codex-receipts-${label}-`));
  return path.join(dir, "receipts.json");
}

test("returns the completed result for the same request id without submitting the command twice", async () => {
  const file = await receiptFile("idempotent");
  const receipts = new CommandReceipts(file);
  let submissions = 0;
  const key = "user-1:thread-1:request-12345678";

  const first = await receipts.run(key, async () => {
    submissions += 1;
    return { turnId: "turn-1", status: "running" };
  });
  const second = await receipts.run(key, async () => {
    submissions += 1;
    return { turnId: "turn-2", status: "running" };
  });

  assert.equal(submissions, 1);
  assert.deepEqual(second, first);
  const persisted = JSON.parse(await readFile(file, "utf8")) as Array<
    [string, { state: string; result?: unknown; at?: number }]
  >;
  assert.deepEqual(persisted, [[key, { at: persisted[0][1].at, state: "done", result: first }]]);
});

test("does not retry an unconfirmed command after a receipt-store reload", async () => {
  const file = await receiptFile("ambiguous");
  const key = "user-1:thread-1:request-abcdefgh";
  const initial = new CommandReceipts(file);
  let firstSubmission = 0;

  await assert.rejects(
    initial.run(key, async () => {
      firstSubmission += 1;
      throw new Error("connection dropped after submit");
    }),
    /connection dropped after submit/
  );
  assert.equal(firstSubmission, 1);

  const persisted = JSON.parse(await readFile(file, "utf8")) as Array<[string, { state: string }]>;
  assert.deepEqual(
    persisted.map(([storedKey, receipt]) => [storedKey, receipt.state]),
    [[key, "pending"]]
  );

  const afterRestart = new CommandReceipts(file);
  await afterRestart.load();
  let retriedSubmission = 0;
  await assert.rejects(
    afterRestart.run(key, async () => {
      retriedSubmission += 1;
      return { turnId: "must-not-run" };
    }),
    (error: unknown) => error instanceof ConsoleError && error.code === "OUTCOME_UNKNOWN"
  );
  assert.equal(retriedSubmission, 0);
});


test('preflight failures release the request id durably, but dispatched failures never replay', async () => {
  const file=await receiptFile('dispatch-boundary'),key='user:thread:boundary-123';
  const receipts=new CommandReceipts(file);let calls=0;
  await assert.rejects(receipts.run(key,async()=>{calls++;throw new ConsoleError(409,'PROJECT_BUSY','busy');},{trackSubmission:true}),/busy/);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),[]);
  const reloaded=new CommandReceipts(file);await reloaded.load();
  await assert.rejects(reloaded.run(key,async mark=>{calls++;mark();throw new Error('connection lost');},{trackSubmission:true}),/connection lost/);
  const afterDispatch=new CommandReceipts(file);await afterDispatch.load();
  await assert.rejects(afterDispatch.run(key,async()=>{calls++;return {};},{trackSubmission:true}),(e:unknown)=>e instanceof ConsoleError&&e.code==='OUTCOME_UNKNOWN');
  assert.equal(calls,2);
});
test('simultaneous identical requests execute once and return the confirmed result on later retry', async()=>{
  const receipts=new CommandReceipts(await receiptFile('concurrent'));let release!:()=>void,calls=0;
  const hold=new Promise<void>(resolve=>release=resolve);
  const first=receipts.run('concurrent-123',async mark=>{calls++;await hold;mark();return {turnId:'confirmed'};},{trackSubmission:true});
  await assert.rejects(receipts.run('concurrent-123',async()=>{calls++;return {};},{trackSubmission:true}),(e:unknown)=>e instanceof ConsoleError&&e.code==='OUTCOME_UNKNOWN');
  release();assert.deepEqual(await first,{turnId:'confirmed'});
  assert.deepEqual(await receipts.run('concurrent-123',async()=>{calls++;return {};},{trackSubmission:true}),{turnId:'confirmed'});
  assert.equal(calls,1);
});
