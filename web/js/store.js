/* 全局状态 + 小工具。 */
export const S = {
  route: 'chat',        // chat | care | settings
  mood: null,           // 知更状态（/api/state）
  unread: 0,
  busy: false,          // 正在等回复
  messages: [],         // 已加载对话
  loadedUpTo: 0,        // 已拉到哪条 id
  timer: null,          // 心跳
};

export const $ = (sel, root) => (root || document).querySelector(sel);

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** 消息列表按天分组用的分隔标签 */
export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今天';
  if (same(d, yest)) return '昨天';
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 星期' +
    '日一二三四五六'[d.getDay()];
}

export function hhmm(ts) {
  const d = new Date(ts);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
