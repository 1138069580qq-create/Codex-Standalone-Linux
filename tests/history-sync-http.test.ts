import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createApp } from '../src/server';
import { UserStore } from '../src/auth';
import { ProtectedConfigStore } from '../src/protected-config';
import { CodexConsoleService } from '../src/backend/service';

const Core: any = require('../public/history.js');
const TEMP_ROOT = process.platform==='win32'?'D:/WorkData/StarPack/Temp/history-sync-http-20260912':'/mnt/d/WorkData/StarPack/Temp/history-sync-http-20260912';
const PASSWORD = 'history-sync-http-test-password';

type Item = { id: string; type: string; text: string };

class HistoryFixture extends CodexConsoleService {
  items: Item[] = [];

  override status(identity: any) {
    return { ...super.status(identity), connected: true };
  }

  override async snapshot(identity: any, projectId: string, threadId: string): ReturnType<CodexConsoleService["snapshot"]> {
    this.project(identity, projectId);
    assert.equal(threadId, 'thread-a');
    return {
      id: threadId,
      title: 'HTTP history fixture',
      status: 'idle',cursor:'fixture:1',turnId:undefined,tokenUsage:null,metrics:null,
      items: this.items,
      turns: [{ id: 'turn-a', status: 'completed' }],
      pending: [],
      truncated: false,
    };
  }
}

async function readJson(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  return { value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length };
}

test('history sync HTTP enforces account and CSRF, sends minimal deltas, and strips meta history', async t => {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(TEMP_ROOT, 'fixture-'));
  const data=path.join(root,'data'),projectRoot=path.join(root,'project');
  await Promise.all([fs.mkdir(data),fs.mkdir(projectRoot)]);

  const users = new UserStore(path.join(data, 'users.json'));
  const admin = await users.upsert({ username: 'history-http-admin', password: PASSWORD, admin: true });
  const other = await users.upsert({ username: 'history-http-other', password: PASSWORD, admin: false });
  const settings = new ProtectedConfigStore(path.join(data, 'config.json'));
  await settings.save({
    ...settings.value,
    enabled: true,
    defaultOwnerId: admin.id,
    transport: { type: 'unix', endpoint: path.join(data, 'mock.sock') },
    projects: [{
      id: 'p',
      name: 'History fixture',
      root: projectRoot,
      ownerId: admin.id,
      grants: [{ userId: admin.id, permissions: ['view', 'send'] }],
    }],
  });

  let fixture!: HistoryFixture;
  const runtime = await createApp(
    {
      host: '127.0.0.1',
      port: 0,
      origin: 'http://127.0.0.1:0',
      dataDir: data,
      secureCookies: false,
    },
    (config, receipts) => (fixture = new HistoryFixture(config, receipts))
  );
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    runtime.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (url: string, body: any, headers: Record<string, string> = {}) => fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', ...headers },
    body: JSON.stringify(body),
  });
  const login = async (username: string) => {
    const response = await post('/api/login', { username, password: PASSWORD });
    assert.equal(response.status, 200);
    const auth = await response.json() as any;
    return {
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      csrf: auth.csrf as string,
    };
  };

  const item = (id: string, text: string): Item => ({ id, type: 'agentMessage', text });
  const local = [item('item-a', '相同文字'), item('item-b', '本地旧文字')];
  fixture.items = local;
  const manifest = await Core.manifest(local);
  const syncUrl = '/api/codex/threads/thread-a/sync';

  assert.equal((await post(syncUrl, { projectId: 'p', digest: manifest.digest })).status, 401);

  const adminAuth = await login('history-http-admin');
  const otherAuth = await login('history-http-other');
  const adminHeaders = { cookie: adminAuth.cookie, 'x-csrf-token': adminAuth.csrf };
  const otherHeaders = { cookie: otherAuth.cookie, 'x-csrf-token': otherAuth.csrf };

  assert.equal((await post(syncUrl, { projectId: 'p', digest: manifest.digest }, { cookie: adminAuth.cookie })).status, 403);
  assert.equal((await post(syncUrl, { projectId: 'p', digest: manifest.digest }, { ...adminHeaders, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await post(syncUrl, { projectId: 'p', digest: manifest.digest }, otherHeaders)).status, 403);
  assert.equal((await post(syncUrl, {projectId:'p',digest:manifest.digest},{...adminHeaders,origin:'https://untrusted.example'})).status,403);

  const unchanged = await post(syncUrl, { projectId: 'p', digest: manifest.digest }, adminHeaders);
  assert.equal(unchanged.status, 200);
  const unchangedBody = await readJson(unchanged);
  assert.equal(unchangedBody.value.sync, 1);
  assert.equal(unchangedBody.value.unchanged, true);
  assert.equal('items' in unchangedBody.value, false);
  assert.ok(unchangedBody.bytes > 0);

  fixture.items = [item('item-a', '相同文字'), item('item-b', '远端更新文字🙂'.repeat(512))];
  const needsManifest = await post(syncUrl, { projectId: 'p', digest: manifest.digest }, adminHeaders);
  assert.equal(needsManifest.status, 200);
  const needsManifestBody = await readJson(needsManifest);
  assert.equal(needsManifestBody.value.needsManifest, true);
  assert.equal('items' in needsManifestBody.value, false);

  const changed = await post(syncUrl, {
    projectId: 'p',
    digest: manifest.digest,
    known: manifest.known,
  }, adminHeaders);
  assert.equal(changed.status, 200);
  const changedBody = await readJson(changed);
  assert.equal(changedBody.value.sync, 1);
  assert.equal(changedBody.value.items.length, 1);
  assert.equal(changedBody.value.items[0].id, 'item-b');
  assert.deepEqual(changedBody.value.order, ['item-a', 'item-b']);
  assert.ok(changedBody.bytes > unchangedBody.bytes);

  const metaResponse = await fetch(`${base}/api/codex/threads/thread-a/meta?projectId=p`, {
    headers: { ...adminHeaders, 'accept-encoding': 'identity' },
  });
  assert.equal(metaResponse.status, 200);
  const metaBody = await readJson(metaResponse);
  assert.equal('items' in metaBody.value, false);
  assert.equal('turns' in metaBody.value, false);
  assert.ok(metaBody.bytes > 0);
  t.diagnostic(JSON.stringify({unchangedBytes:unchangedBody.bytes,manifestRequestResponseBytes:needsManifestBody.bytes,oneChangedItemBytes:changedBody.bytes,metadataBytes:metaBody.bytes}));
});
