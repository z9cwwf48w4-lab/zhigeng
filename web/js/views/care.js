/* 它在意的：知更该记住惦记的事。 */
import { api } from '../api.js';
import { S, $, esc, toast } from '../store.js';

export async function load() { /* 心跳统一拉 */ }

export async function render(el) {
  let mems = [];
  try { mems = (await api.memories()).memories; } catch (e) { /* 静默 */ }
  S.memCache = mems;

  el.innerHTML =
    '<div class="page"><div class="page-inner">' +
      '<h2>它在意的</h2>' +
      '<p class="sub">写在这里的事，知更会记着，聊天时会自然提起，也会惦记进展。</p>' +
      '<div class="mem-add">' +
        '<input id="mem-input" placeholder="比如：下周三有门课要结课" maxlength="300">' +
        '<button class="btn-gold" id="mem-add-btn">记下</button>' +
      '</div>' +
      '<div id="mem-list">' + (mems.length ? mems.map(card).join('')
        : '<div class="empty-hint">还没有记下任何事。</div>') + '</div>' +
    '</div></div>';

  const add = async () => {
    const v = $('#mem-input').value.trim();
    if (!v) return;
    try {
      await api.addMemory(v);
      await render(el);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#mem-add-btn').addEventListener('click', add);
  $('#mem-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) add();
  });
  el.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api.delMemory(Number(b.dataset.del));
        await render(el);
      } catch (e) { toast(e.message, 'err'); }
    }));
}

function card(m) {
  const d = new Date(m.created_at);
  return '<div class="mem-card"><span>' + esc(m.content) + '</span>' +
    '<span style="display:flex;gap:10px;align-items:center">' +
    '<span style="font-size:var(--fs-xs);color:var(--ink-3)">' +
    (d.getMonth() + 1) + '/' + d.getDate() + '</span>' +
    '<button class="x" data-del="' + m.id + '" aria-label="删除">✕</button>' +
    '</span></div>';
}
