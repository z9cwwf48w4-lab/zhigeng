/* API 层：所有后端交互的唯一出口。 */

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
  return j;
}

export const api = {
  state: () => jfetch('/api/state'),
  messages: (after) => jfetch('/api/messages?after=' + (after || 0)),
  profile: () => jfetch('/api/profile'),
  saveProfile: (p) => jfetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  }),
  memories: () => jfetch('/api/memories'),
  addMemory: (content) => jfetch('/api/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }),
  delMemory: (id) => jfetch('/api/memories/' + id, { method: 'DELETE' }),

  /** 对话：SSE 流式。onDelta 收增量，onError 收错误文案。返回完整回复。 */
  chat: async function (content, onDelta, onError) {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('发送失败 ' + r.status));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!data) continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (event === 'delta' && j.t) { full += j.t; onDelta(j.t); }
        else if (event === 'error' && onError) onError(j.message || '出错了');
      }
    }
    return full;
  },
};
