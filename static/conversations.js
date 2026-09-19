/* ==========================================================================
   知更 · 话题（会话）
   --------------------------------------------------------------------------
   一个话题 = 一件事 / 一个阶段。它的记忆和提案都挂在对话下，互不串味。

   为什么要把「对话」当一等公民而不是做个过滤器：
   AA 会遗忘。遗忘是按时间衰减算的，而「跟股票有关的事」和「跟论文有关的事」
   混在一起时，搁置的那一类会互相干扰 —— 一条三个月前的持仓记录，会把另一条
   关于论文的紧急记忆顶掉。分开之后，每个话题有自己的时间线和轮次，
   衰减就在各自的语境里发生。

   本版本之前的用户数据（conversation_id 为空）在首次进入时被归拢到默认话题，
   不会丢。这是数据迁移，不做静默丢弃。
   ========================================================================== */

const Convos = (function () {
  const DEFAULT_TITLE = "新话题";
  const LS_KEY = 'aa.conv';

  function S() { return window.AAApp.S; }

  function current() {
    const s = S();
    if (!s.convId) return null;
    return s.conversations.filter(c => String(c.id) === String(s.convId))[0] || null;
  }

  function storageKey() {
    const email = (S().user && S().user.email) || 'anon';
    return LS_KEY + ':' + email;
  }

  function remember(id) {
    try { localStorage.setItem(storageKey(), String(id)); } catch (e) {}
  }

  function recall() {
    try { return localStorage.getItem(storageKey()); } catch (e) { return null; }
  }

  async function load() {
    S().conversations = await Cloud.data.listConversations() || [];
    return S().conversations;
  }

  /**
   * 保证「有对话可用」。
   * 三件事：拉列表 → 空则建一个 → 把本版本之前的孤儿数据归拢进来。
   */
  async function ensure() {
    await load();

    if (!S().conversations.length) {
      const c = await Cloud.data.createConversation('主要想法');
      if (c) S().conversations = [c];
    }

    const saved = recall();
    const hit = saved && S().conversations.filter(c => String(c.id) === String(saved))[0];
    S().convId = hit ? hit.id : (S().conversations[0] ? S().conversations[0].id : null);

    // 老数据归拢，只做一次（做完后不再有 conversation_id 为空的行）
    if (S().convId != null) {
      try {
        const moved = await Cloud.data.adoptOrphans(S().convId);
        if (moved.memories || moved.proposals) {
          window.AAApp.toast('已把 ' + moved.memories + ' 条记忆、' + moved.proposals +
                             ' 条提案归入「' + label(current()) + '」。', 'info');
        }
      } catch (e) { /* 归拢失败不该挡住进入 */ }
    }
    if (S().convId != null) remember(S().convId);
    return S().convId;
  }

  async function switchTo(id) {
    S().convId = id;
    remember(id);
    await window.AAApp.reloadConversation();
  }

  async function create(title) {
    const c = await Cloud.data.createConversation(title || DEFAULT_TITLE);
    if (!c) throw new Error('创建话题失败。');
    S().conversations.unshift(c);
    S().convId = c.id;
    remember(c.id);
    await window.AAApp.reloadConversation();
    return c;
  }

  async function rename(id, title) {
    const clean = String(title || '').trim().slice(0, 40);
    if (!clean) return null;
    const row = await Cloud.data.updateConversation(id, { title: clean });
    const local = S().conversations.filter(c => String(c.id) === String(id))[0];
    if (local) Object.assign(local, row || { title: clean });
    document.dispatchEvent(new CustomEvent('aa:convos-changed'));
    return row;
  }

  async function remove(id) {
    await Cloud.data.deleteConversation(id);
    S().conversations = S().conversations.filter(c => String(c.id) !== String(id));
    // 删掉的是当前对话 → 换到第一个；一个都不剩 → 建一个新的
    if (String(S().convId) === String(id)) {
      if (S().conversations.length) {
        S().convId = S().conversations[0].id;
      } else {
        await create('主要想法');
        return;
      }
      remember(S().convId);
      await window.AAApp.reloadConversation();
    } else {
      document.dispatchEvent(new CustomEvent('aa:convos-changed'));
    }
  }

  function bumpUpdated(id, at) {
    const c = S().conversations.filter(x => String(x.id) === String(id))[0];
    if (c) c.updated_at = at || new Date().toISOString();
  }

  function label(c) {
    if (!c) return '—';
    const t = String(c.title || '').trim();
    return t || DEFAULT_TITLE;
  }

  /** 首条记忆写进来时，把「新话题」自动改成有意义的标题 —— 省掉一次起名动作 */
  async function maybeAutoTitle(text) {
    const c = current();
    if (!c) return;
    if (String(c.title || '').trim() && c.title !== DEFAULT_TITLE) return;
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!t) return;
    try { await rename(c.id, t); } catch (e) {}
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */

  function sidebarHTML() {
    const s = S();
    const items = s.conversations || [];
    return '' +
    '<div class="conv-block">' +
      '<div class="conv-head">' +
        '<span class="conv-title">话题</span>' +
        '<button class="conv-new" data-act="conv-new" title="新建话题" aria-label="新建话题">' +
          icon('plus', 15) + '</button>' +
      '</div>' +
      '<div class="conv-list">' +
        (items.length ? items.map(function (c) {
          const active = String(c.id) === String(s.convId);
          return '<div class="conv-item' + (active ? ' is-active' : '') + '">' +
            '<button class="conv-go" data-act="conv-switch" data-id="' + c.id + '"' +
              (active ? ' aria-current="true"' : '') + '>' +
              '<span class="conv-ic">' + icon('chat', 15) + '</span>' +
              '<span class="conv-main">' +
                '<span class="conv-name">' + esc(label(c)) + '</span>' +
                '<span class="conv-sub">' + esc(shortAgo(c.updated_at)) + '</span>' +
              '</span>' +
            '</button>' +
            '<button class="conv-more" data-act="conv-menu" data-id="' + c.id +
              '" title="重命名或删除" aria-label="更多操作">' + icon('edit', 14) + '</button>' +
          '</div>';
        }).join('') : '<div class="conv-empty">还没有话题</div>') +
      '</div>' +
    '</div>';
  }

  /** mobile 用的顶部切换按钮 + 弹层 */
  function switchButtonHTML() {
    const c = current();
    return '<button class="btn btn-ghost btn-sm conv-switch-btn" data-act="conv-picker">' +
      icon('chat', 15) + '<span class="conv-switch-name">' + esc(label(c)) + '</span>' +
      icon('chevronRight', 14) + '</button>';
  }

  function pickerBody() {
    const s = S();
    return '<div class="conv-picker">' +
      (s.conversations || []).map(function (c) {
        const active = String(c.id) === String(s.convId);
        return '<button class="conv-pick' + (active ? ' is-active' : '') +
          '" data-act="conv-switch" data-id="' + c.id + '">' +
          icon('chat', 16) + '<span class="grow">' + esc(label(c)) + '</span>' +
          (active ? icon('check', 16) : '') + '</button>';
      }).join('') +
      '<button class="conv-pick is-new" data-act="conv-new">' +
        icon('plus', 16) + '<span class="grow">新建话题</span></button>' +
      '</div>';
  }

  function shortAgo(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (sec < 60) return '刚刚';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    const days = Math.floor(sec / 86400);
    if (days === 1) return '昨天';
    if (days < 30) return days + ' 天前';
    const p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  return {
    load, ensure, switchTo, create, rename, remove, current, label,
    bumpUpdated, maybeAutoTitle,
    sidebarHTML, switchButtonHTML, pickerBody,
    DEFAULT_TITLE,
  };
})();

if (typeof window !== 'undefined') window.Convos = Convos;
