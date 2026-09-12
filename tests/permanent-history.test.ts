import test from 'node:test';
import assert from 'node:assert/strict';
import { historySync } from '../src/backend/history-sync';

const Core: any = require('../public/history.js');
const ORIGIN = 'https://history.test';
const DAY = 24 * 60 * 60 * 1000;

const item = (id: string, text: string) => ({ id, type: 'agentMessage', text });
const snapshot = (id: string, text: string, savedAt: number) =>
  Core.snapshot({ items: [item(id, text)], turns: [] }, savedAt);
const serverState = (items: any[]) => ({ items, turns: [], pending: [], status: 'idle' });

test('41 conversations survive 1000 days and a restarted Core sharing storage', async () => {
  let now = 1_700_000_000_000;
  const storage = Core.memoryStore();
  const first = Core.create({ storage, origin: ORIGIN, now: () => now });
  await first.init({ id: 'account-a' });

  const expected = new Map<string, string>();
  for (let i = 0; i < 41; i++) {
    const id = `thread-${i}`;
    const text = `第 ${i} 个会话的历史文字`;
    expected.set(id, text);
    await first.write('project-a', id, snapshot(id, text, now));
  }

  now += 1000 * DAY;
  const restarted = Core.create({ storage, origin: ORIGIN, now: () => now });
  await restarted.init({ id: 'account-a' });
  for (const [id, text] of expected) {
    assert.equal((await restarted.read('project-a', id)).items[0].text, text);
  }
});

test('reset acts as logout while same-account records remain isolated from another account', async () => {
  const storage = Core.memoryStore();
  const cache = Core.create({ storage, origin: ORIGIN, now: () => 1 });
  await cache.init({ id: 'account-a' });
  await cache.write('project-a', 'thread-a', snapshot('thread-a', 'A 的本地历史', 1));

  cache.reset();
  assert.equal(await cache.read('project-a', 'thread-a'), null);
  await cache.init({ id: 'account-a' });
  assert.equal((await cache.read('project-a', 'thread-a')).items[0].text, 'A 的本地历史');
  await cache.init({ id: 'account-b' });
  assert.equal(await cache.read('project-a', 'thread-a'), null);
});

test('a refreshed snapshot exposes previousId and reads the previous text', async () => {
  const cache = Core.create({ storage: Core.memoryStore(), origin: ORIGIN, now: () => 1 });
  await cache.init({ id: 'account-a' });
  await cache.write('project-a', 'thread-a', snapshot('thread-a', '旧文字', 1));
  await cache.write('project-a', 'thread-a', snapshot('thread-a', '新文字', 2));

  const latest = await cache.record('project-a', 'thread-a');
  assert.equal(latest.value.items[0].text, '新文字');
  assert.ok(latest.previousId);
  const previous = await cache.record('project-a', 'thread-a', latest.previousId);
  assert.equal(previous.value.items[0].text, '旧文字');
});

test('a failed write leaves the existing head readable', async () => {
  const base = Core.memoryStore();
  let fail = false;
  const storage = {
    get: base.get,
    put: async (key: string, value: string) => {
      if (fail) throw Error('disk full');
      return base.put(key, value);
    },
  };
  const cache = Core.create({ storage, origin: ORIGIN, now: () => 1 });
  await cache.init({ id: 'account-a' });
  await cache.write('project-a', 'thread-a', snapshot('thread-a', '仍然有效', 1));

  fail = true;
  await assert.rejects(cache.write('project-a', 'thread-a', snapshot('thread-a', '不应成为 head', 2)), /disk full/);
  fail = false;
  assert.equal((await cache.read('project-a', 'thread-a')).items[0].text, '仍然有效');
});

test('a Chinese snapshot larger than 384 KiB round-trips through chunks intact', async () => {
  const cache = Core.create({ storage: Core.memoryStore(), origin: ORIGIN, now: () => 1 });
  await cache.init({ id: 'account-a' });
  const text = '中文🙂'.repeat(100_000);
  assert.ok(new TextEncoder().encode(text).byteLength > 384 * 1024);

  await cache.write('project-a', 'thread-large', snapshot('thread-large', text, 1));
  assert.equal((await cache.read('project-a', 'thread-large')).items[0].text, text);
});

test('legacy version 1 records have no TTL and migrate into the previous chain on write', async () => {
  let now = 1_700_000_000_000 + 1000 * DAY;
  const storage = Core.memoryStore();
  const key = JSON.stringify([ORIGIN, 'account-a', 'project-a', 'thread-legacy']);
  const legacy = {
    version: 1,
    savedAt: 1,
    items: [item('thread-legacy', '一千天前的旧文字')],
    turns: [],
    truncated: false,
  };
  await storage.put(key, JSON.stringify(legacy));

  const cache = Core.create({ storage, origin: ORIGIN, now: () => now });
  await cache.init({ id: 'account-a' });
  assert.equal((await cache.read('project-a', 'thread-legacy')).items[0].text, '一千天前的旧文字');

  await cache.write('project-a', 'thread-legacy', snapshot('thread-legacy', '迁移后的新文字', now));
  const latest = await cache.record('project-a', 'thread-legacy');
  assert.equal(latest.value.items[0].text, '迁移后的新文字');
  assert.ok(latest.previousId);
  const previous = await cache.record('project-a', 'thread-legacy', latest.previousId);
  assert.equal(previous.value.version, 1);
  assert.equal(previous.value.items[0].text, '一千天前的旧文字');
});

test('Core.manifest and sync send only a digest when history is unchanged', async () => {
  const items = [item('a', 'A'), item('b', 'B')];
  const manifest = await Core.manifest(items);
  const requests: any[] = [];
  const responses: any[] = [];
  const result = await Core.sync(async (_url: string, body: any) => {
    requests.push(body);
    const response = historySync(serverState(items), body);
    responses.push(response);
    return response;
  }, '/api/codex/threads/t/sync', 'project-a', items);

  assert.deepEqual(requests, [{ projectId: 'project-a', digest: manifest.digest }]);
  assert.equal('items' in responses[0], false);
  assert.deepEqual(result.items, items);
});

test('Core.sync requests and applies exactly one changed item', async () => {
  const local = [item('a', 'A'), item('b', '旧 B'), item('c', 'C')];
  const remote = [item('a', 'A'), item('b', '新 B'), item('c', 'C')];
  const requests: any[] = [];
  const responses: any[] = [];
  const result = await Core.sync(async (_url: string, body: any) => {
    requests.push(body);
    const response = historySync(serverState(remote), body);
    responses.push(response);
    return response;
  }, '/api/codex/threads/t/sync', 'project-a', local);

  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['digest', 'projectId']);
  assert.deepEqual(Object.keys(requests[1]).sort(), ['digest', 'known', 'projectId']);
  assert.equal(responses[1].items.length, 1);
  assert.equal(responses[1].items[0].id, 'b');
  assert.deepEqual(result.items.map((row: any) => row.text), ['A', '新 B', 'C']);
});

test('Core.sync removes deleted items and follows the server order', async () => {
  const local = [item('a', 'A'), item('b', 'B'), item('c', 'C')];
  const remote = [item('c', 'C'), item('a', 'A')];
  const responses: any[] = [];
  const result = await Core.sync(async (_url: string, body: any) => {
    const response = historySync(serverState(remote), body);
    responses.push(response);
    return response;
  }, '/api/codex/threads/t/sync', 'project-a', local);

  assert.equal(responses[1].items.length, 0);
  assert.deepEqual(responses[1].order, ['c', 'a']);
  assert.deepEqual(result.items.map((row: any) => row.id), ['c', 'a']);
});

test('historySync rejects malformed manifests', () => {
  const state = serverState([item('a', 'A')]);
  const malformed = [
    { known: [['a', 'bad']] },
    { known: [['a', '0'.repeat(64)], ['a', '1'.repeat(64)]] },
    { known: [['a', '0'.repeat(64), 'extra']] },
    { digest: 'bad' },
  ];
  for (const input of malformed) {
    assert.throws(() => historySync(state, input), (error: any) => error.code === 'INVALID_HISTORY_SYNC');
  }
});
