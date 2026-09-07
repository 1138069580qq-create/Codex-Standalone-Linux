import test from "node:test";
import assert from "node:assert/strict";
import { CodexRpcClient } from "../src/backend/transport";
// Opt-in, existing endpoint only. No thread creation, no model call, no subprocess.
test('attach to operator-provided existing Codex', {skip:!process.env.CODEX_EXISTING_ENDPOINT,timeout:20_000},async t=>{
  const endpoint=process.env.CODEX_EXISTING_ENDPOINT!;
  const peer=new CodexRpcClient({type:endpoint.startsWith('/')?'unix':'websocket',endpoint,bearerTokenEnv:process.env.CODEX_EXISTING_TOKEN_ENV});
  t.after(()=>peer.close());await peer.connect();assert.ok(peer.connected);
  assert.ok(Array.isArray((await peer.request<any>('model/list',{limit:10})).data));
  t.diagnostic(JSON.stringify({serverInfo:peer.serverInfo,readOnly:true}));
});
