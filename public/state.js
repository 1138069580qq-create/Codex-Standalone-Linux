/* Shared, deterministic client reducer; no DOM and no network dependencies. */
(function (scope) {
  // randomUUID is secure-context-only; getRandomValues is also available on HTTP.
  function requestId(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('浏览器无法生成请求 ID，请使用现代浏览器或 HTTPS。');
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function windowLabel(minutes) {
    if (minutes === 10080) return '一周';
    if (!Number.isFinite(minutes) || minutes <= 0) return '额度窗口';
    if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时`;
    return `${minutes} 分钟`;
  }
  function applyEvent(state, event) {
    const p = event.payload || {};
    if (event.type === 'item') state.items.set(p.id, { ...p });
    else if (event.type === 'delta') {
      const item = state.items.get(p.itemId);
      if (!item || !Number.isInteger(p.offset) || p.offset < 0 || typeof p.text !== 'string') return false;
      if (p.offset > item.text.length) return false;
      if (p.offset < item.text.length) {
        if (item.text.slice(p.offset, p.offset + p.text.length) === p.text) return true;
        return false;
      }
      item.text = (item.text + p.text).slice(0, 65536);
    } else if (event.type === 'approval') state.pending.set(p.id, p);
    else if (event.type === 'approvalResolved') state.pending.delete(p.id);
    else if (event.type === 'status') { state.status = p.status || state.status; if(p.tokenUsage)state.tokenUsage=p.tokenUsage; }
    let size = [...state.items.values()].reduce((sum, v) => sum + v.text.length, 0);
    while (state.items.size > 200 || size > 512 * 1024) {
      const key = state.items.keys().next().value;
      size -= state.items.get(key).text.length; state.items.delete(key); state.truncated = true;
    }
    return true;
  }
  function parseSse(chunk, carry = '') {
    const blocks = (carry + chunk).replace(/\r\n/g, '\n').split('\n\n');
    const tail = blocks.pop(); const events = [];
    for (const block of blocks) {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) events.push(JSON.parse(data));
    }
    return { events, carry: tail };
  }
  function contextWindow(usage) {
    const valid = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    const used = valid(usage?.last) ? usage.last : null;
    const capacity = valid(usage?.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
    return { used, capacity, percent: used !== null && capacity !== null ? used / capacity * 100 : null, remaining: used !== null && capacity !== null ? Math.max(0, capacity - used) : null };
  }
  const api = { applyEvent, parseSse, requestId, windowLabel, contextWindow };
  if (typeof module !== 'undefined') module.exports = api;
  else scope.CodexState = api;
})(globalThis);
