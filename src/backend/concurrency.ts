import { ConsoleError } from './config';
import { runtimeStatus } from './normalize';

export const MAIN_TURN_LIMIT = 5;
export const CONCURRENCY_MESSAGE = '并行满了请稍后再试';
export function isMainThread(thread: any): boolean {
  const source = thread?.source ?? thread?.threadSource;
  return !/sub.?agent/i.test(typeof source === 'string' ? source : JSON.stringify(source || ''));
}
export async function readMainThreads(readPage: (params: any) => Promise<any>): Promise<any[]> {
  const rows: any[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await readPage({limit: 100, archived: false, modelProviders: [], ...(cursor ? {cursor} : {})});
    if (!Array.isArray(result?.data)) throw new ConsoleError(503, 'CONCURRENCY_UNAVAILABLE', '暂时无法核对主会话并行数，请稍后再试。');
    rows.push(...result.data.filter(isMainThread));
    if (!result.nextCursor) return rows;
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) break;
    cursor = result.nextCursor; cursors.add(result.nextCursor);
  }
  throw new ConsoleError(503, 'CONCURRENCY_UNAVAILABLE', '主会话列表未完整返回，请稍后再试。');
}

/** One gate per WebUI backend, shared by every account and attached task.
 * Reservations cover async validation/dispatch; a submitted-but-unknown turn is never replayed.
 * Desktop launches cannot be stopped by WebUI, but are included before admitting a web send.
 */
export class MainTurnGate {
  private remote = new Set<string>();
  private local = new Map<string, {at: number; turnId?: string}>();
  private observed = new Map<string, {version: number; active: boolean; turnId?: string}>();
  private pending = new Map<symbol, string | undefined>();
  private version = 0;
  private reading?: Promise<void>;
  private refreshedAt = 0;
  constructor(private read: () => Promise<any[]>, private now = Date.now) {}
  get count() {
    const ids = new Set([...this.remote, ...this.local.keys()]);
    let unnamed = 0;
    for (const id of this.pending.values()) id ? ids.add(id) : unnamed++;
    return ids.size + unnamed;
  }
  observe(id: string, status: string, turnId?: string) {
    if (!id) return;
    const active = runtimeStatus({status}) === 'running';
    this.observed.set(id, {version: ++this.version, active, turnId});
    const prior=this.local.get(id);
    if (active) this.local.set(id, {at:this.now(),turnId});
    else {
      if (turnId && prior?.turnId && turnId !== prior.turnId) return;
      if (turnId || !prior || this.now()-prior.at>=2000) this.local.delete(id);
      this.remote.delete(id);
    }
  }
  async synchronize() { this.refreshedAt = 0; await this.refresh(); }
  private async refresh() {
    if (this.reading) return this.reading;
    if (this.refreshedAt && this.now() - this.refreshedAt < 1000) return;
    const version = this.version;
    const work = (async () => {
      const rows = await this.read(), active = new Set<string>();
      for (const row of rows) if (isMainThread(row) && typeof row.id === 'string' && runtimeStatus(row) === 'running') active.add(row.id);
      for (const [id, state] of this.observed) if (state.version > version) state.active ? active.add(id) : active.delete(id);
      // Allow owner-state propagation after acceptance. Thereafter the complete backend snapshot is authoritative.
      for (const [id, state] of this.local) if (this.now() - state.at >= 2000 && (this.observed.get(id)?.version || 0) <= version) this.local.delete(id);
      this.remote = active; this.refreshedAt = this.now();
      for (const [id, state] of this.observed) if (state.version <= version && !this.local.has(id) && ![...this.pending.values()].includes(id)) this.observed.delete(id);
    })();
    this.reading = work;
    try { await work; } finally { if (this.reading === work) this.reading = undefined; }
  }
  async acquire(threadId?: string) {
    await this.refresh();
    if (threadId && (this.remote.has(threadId) || this.local.has(threadId) || [...this.pending.values()].includes(threadId)))
      throw new ConsoleError(409, 'THREAD_BUSY', '此主会话仍在运行，请等待本轮结束。');
    if (this.count >= MAIN_TURN_LIMIT) throw new ConsoleError(409, 'CONCURRENCY_LIMIT', CONCURRENCY_MESSAGE);
    const token = Symbol(), gate = this;
    this.pending.set(token, threadId);
    let submitted = false, version = this.version, done = false;
    return {
      bind(id: string) { threadId = id; gate.pending.set(token, id); },
      submit() { submitted = true; version = gate.version; },
      finish(outcome: 'running' | 'complete' | 'rejected' | 'unknown', turnId?: string) {
        if (done) return; done = true;
        // Unknown creation without an ID conservatively keeps a slot until restart/reconciliation.
        if (submitted && outcome === 'unknown' && !threadId) return;
        gate.pending.delete(token);
        if (!threadId || !submitted || outcome === 'rejected') return;
        const event = gate.observed.get(threadId);
        if (outcome === 'complete') gate.observe(threadId, 'idle', turnId);
        else if (!(event && event.version > version && !event.active && (!turnId || event.turnId === turnId))) gate.local.set(threadId, {at:gate.now(),turnId});
      }
    };
  }
}
