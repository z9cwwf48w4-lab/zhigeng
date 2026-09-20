/* 知更 · 前端入口：路由 + 心跳 + 顶栏状态。 */
import { api } from './api.js';
import { S, $, esc } from './store.js';
import * as chat from './views/chat.js';
import * as care from './views/care.js';
import * as settings from './views/settings.js';

const ROUTES = [
  { id: 'chat', label: '对话', mod: chat,
    icon: '<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>' },
  { id: 'care', label: '它在意的', mod: care,
    icon: '<path d="M12 21s-7-4.6-9.5-8.5C.7 9.7 2.3 6 5.7 6c2 0 3.4 1.1 4.3 2.6h4c.9-1.5 2.3-2.6 4.3-2.6 3.4 0 5 3.7 3.2 6.5C19 16.4 12 21 12 21z"/>' },
  { id: 'settings', label: '设置', mod: settings,
    icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>' },
];

function icon(paths, size) {
  return '<svg viewBox="0 0 24 24" width="' + (size || 20) +
    '" height="' + (size || 20) + '" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    paths + '</svg>';
}

function paintNav() {
  $('#rail-nav').innerHTML = ROUTES.map((r) =>
    '<button class="rail-btn' + (S.route === r.id ? ' on' : '') +
    '" data-go="' + r.id + '" title="' + r.label + '" aria-label="' + r.label + '">' +
    icon(r.icon) +
    (r.id === 'chat' && S.unread ? '<span class="dot"></span>' : '') +
    '</button>').join('');
}

function paintTop() {
  const m = S.mood;
  $('#mood-line').textContent = m
    ? '它' + m.feel + ' · ' + m.gap_txt +
      (m.mem_n ? ' · 记着你 ' + m.mem_n + ' 件事' : '')
    : '…';
  $('#rail-dot').className = 'rail-dot' + (S.busy ? ' busy' : '');
  $('#rail-foot-txt').textContent = S.busy ? '在想' : '在线';
  paintNav();
}

export function go(route) {
  if (!ROUTES.some((r) => r.id === route)) route = 'chat';
  S.route = route;
  if (route === 'chat') S.unread = 0;
  paintNav();
  const mod = ROUTES.find((r) => r.id === route).mod;
  Promise.resolve(mod.load ? mod.load() : null)
    .then(() => mod.render($('#view')))
    .catch((e) => console.error(e));
}

async function heartbeat() {
  try {
    const st = await api.state();
    S.mood = st.mood;
    const before = S.unread;
    S.unread = st.unread || 0;
    if (S.unread > before && S.route !== 'chat') {
      notify('知更来找你了');
    }
    // 有新消息（它主动开口）且不在对话页 → 拉进来，进对话页时能看到
    if (S.unread > 0) await chat.load();
    paintTop();
  } catch (e) { /* 服务没起时静默 */ }
}

function notify(body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification('知更', { body }); } catch (e) { /* 忽略 */ }
}

// 顶部右侧：请求通知权限的小按钮（拒绝过就不再出现）
function paintTopRight() {
  const el = $('#topbar-right');
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    el.innerHTML = '<button class="btn-gold" id="nt-perm" ' +
      'style="font-size:var(--fs-xs);padding:6px 12px">允许它来找我</button>';
    $('#nt-perm').addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (e) { /* 忽略 */ }
      el.innerHTML = '';
    });
  }
}

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (btn) go(btn.dataset.go);
});

go('chat');
paintTopRight();
heartbeat();
setInterval(heartbeat, 30e3);           // 心跳：状态 + 主动开口检查
setInterval(() => { if (S.route === 'chat' && !S.busy) chat.load(); }, 15e3);
