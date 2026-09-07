/* Shared, deterministic client reducer; no DOM and no network dependencies. */
(function (scope) {
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
    else if (event.type === 'status') state.status = p.status || state.status;
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
  const api = { applyEvent, parseSse };
  if (typeof module !== 'undefined') module.exports = api;
  else scope.CodexState = api;
})(globalThis);
