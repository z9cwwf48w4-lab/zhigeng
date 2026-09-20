/* 对话视图：流式气泡 + 按天分组。 */
import { api } from '../api.js';
import { S, $, esc, toast, dayLabel } from '../store.js';

let streaming = null;   // { role:'assistant', content } 流式中的消息

export async function load() {
  try {
    const j = await api.messages(S.loadedUpTo);
    for (const m of j.messages) {
      if (!S.messages.some(x => x.id === m.id)) S.messages.push(m);
      if (m.id > S.loadedUpTo) S.loadedUpTo = m.id;
    }
    // 正式记录已回来，乐观占位（id=-1）就不需要了
    S.messages = S.messages.filter(m => m.id !== -1);
  } catch (e) { /* 静默，心跳会再试 */ }
}

export function render(el) {
  _lastDay = '';   // 每次全量重绘，日期分隔从头算
  const inner = S.messages.length || streaming
    ? S.messages.map(bubble).join('') + (streaming ? bubble(streaming) : '')
    : empty();

  el.innerHTML =
    '<div class="chat-scroll" id="chat-scroll"><div class="chat-inner">' +
      inner +
    '</div></div>' +
    '<div class="composer-wrap"><div class="composer">' +
      '<textarea id="chat-input" rows="1" placeholder="说点什么…（Enter 发送）"></textarea>' +
      '<button class="send-btn" id="send-btn" aria-label="发送"' +
        (S.busy ? ' disabled' : '') + '>' + sendIcon() + '</button>' +
    '</div></div>';

  const scroll = $('#chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;

  const inp = $('#chat-input');
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  inp.addEventListener('input', () => {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  });
  $('#send-btn').addEventListener('click', send);
  if (!S.busy) inp.focus();
}

function bubble(m) {
  const me = m.role === 'user';
  const day = daySep(m);
  const tag = m.proactive ? '<span class="tag">✦ 它先开口</span>' : '';
  const cursor = (streaming === m) ? '<span class="cursor"></span>' : '';
  return day +
    '<div class="row ' + (me ? 'me' : 'ai') + '">' + tag +
    '<div class="bubble">' + esc(m.content).replace(/\n/g, '<br>') + cursor +
    '</div></div>';
}

let _lastDay = '';
function daySep(m) {
  if (!m.ts) return '';            // 流式中的消息还没有时间戳
  const label = dayLabel(m.ts);
  if (label === _lastDay) return '';
  _lastDay = label;
  return '<div class="chat-day">' + label + '</div>';
}

function empty() {
  const feel = S.mood ? S.mood.feel : '';
  const hello = S.mood && S.mood.late
    ? '这个点还没睡？'
    : feel === '很想你' ? '好几天没聊了，最近怎么样？'
    : '跟它聊点什么。比如：我今天该先做什么？';
  return '<div class="chat-empty"><div class="big">🪶</div><p>' +
    esc(hello) + '</p></div>';
}

function sendIcon() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
    'stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
}

export async function send() {
  if (S.busy) return;
  const inp = $('#chat-input');
  const text = (inp && inp.value || '').trim();
  if (!text) return;
  inp.value = '';
  inp.style.height = 'auto';
  // 乐观上屏：用户消息立刻可见，落库版本等 load() 替换
  S.messages.push({ id: -1, role: 'user', content: text, ts: Date.now() });
  S.busy = true;
  S.unread = 0;
  streaming = { role: 'assistant', content: '', _pending: true };
  _lastDay = '';
  paint();

  const onDelta = (t) => {
    if (streaming) streaming.content += t;
    paint();
  };
  const onError = (msg) => { if (streaming) streaming.content += '\n' + msg; };

  try {
    const full = await api.chat(text, onDelta, onError);
    if (streaming) streaming.content = full || streaming.content;
  } catch (e) {
    toast(e.message || '发送失败', 'err');
  } finally {
    streaming = null;
    S.busy = false;
    await load();          // 拉服务端落库的正式版本（含 id/ts）
    paint();
    const i2 = $('#chat-input');
    if (i2) i2.focus();
  }
}

/** 局部重绘：只在对话页时重建 DOM 并保持滚动位置。 */
function paint() {
  if (S.route !== 'chat') return;
  const el = $('#view');
  if (!el) return;
  const scroll = $('#chat-scroll');
  const stick = !scroll ||
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  render(el);
  if (stick) {
    const s2 = $('#chat-scroll');
    if (s2) s2.scrollTop = s2.scrollHeight;
  }
}
