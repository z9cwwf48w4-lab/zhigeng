/* ==========================================================================
   AA · 本地数据适配器
   --------------------------------------------------------------------------
   为什么需要这一层
   ----------------
   原来的设计是「先登录，才能进应用」—— 打开就是登录页。这跟主流软件的做法相反：
   主流都是**先让你进去用，需要身份时才让你登录**。

   但数据层原本直接打在云端（PostgREST + RLS，行归属由 auth.uid() 决定），
   没有登录会话就一行都读不出来。所以「免登录使用」的前提是：
   **得有一份能替代云端的数据实现。**

   这个文件就是那份实现 —— 用 localStorage 存，接口与 Cloud.data 逐一对齐。
   上层（app.js / sync.js / conversations.js）代码一行都不用改，
   因为它们只认「业务语义」的方法名，不关心底下是云还是本地。

   边界，必须说清楚
   ----------------
   - **数据只在这台设备、这个浏览器里。** 换设备、换浏览器、清缓存都会丢。
     界面上必须如实告诉用户这件事，不能让他以为已经存好了。
   - **不是安全边界。** localStorage 是明文、同源可读的。本地模式适合「先试试」，
     不适合放敏感信息 —— 所以界面在本地模式下要引导登录，而不是把登录藏起来。
   - **和云端不是同一份数据。** 登录后会走一次显式迁移（见 app.js 的 adoptLocal），
     规则是「云端账号为空才搬」，不合并、不覆盖 —— 合并两个都不知道来源的数据集，
     出错时无法回滚，用户也看不懂。
   ========================================================================== */

const LocalData = (function () {
  const KEY = 'aa.local.v1';

  /* 本地伪归属。上层的 ensureSettings / saveSettings 会用 `row.owner_id` 是否存在
     来判断「这行建过没有」，所以本地行必须带上它，否则每次进设置都以为没建过。 */
  const OWNER = 'local';

  function nowIso() { return new Date().toISOString(); }

  function empty() {
    return {
      seq: 0,
      conversations: [],
      memories: [],
      proposals: [],
      feedback: [],
      user_settings: null,
      sync_state: null,
    };
  }

  /**
   * 读整库。任何异常（没存过 / JSON 坏了 / 隐私模式禁用 localStorage）
   * 都退化成空库，绝不让「存储层出问题」变成「应用打不开」。
   */
  function read() {
    let d = null;
    try {
      const raw = localStorage.getItem(KEY);
      d = raw ? JSON.parse(raw) : null;
    } catch (e) {
      d = null;
    }
    const out = empty();
    if (!d || typeof d !== 'object') return out;
    out.seq = Number(d.seq || 0) || 0;
    out.user_settings = d.user_settings || null;
    out.sync_state = d.sync_state || null;
    for (const k of ['conversations', 'memories', 'proposals', 'feedback']) {
      out[k] = Array.isArray(d[k]) ? d[k] : [];
    }
    return out;
  }

  /** 写整库。这里**必须**抛错 —— 写不进去还装作成功，用户会以为数据存下了。 */
  function write(db) {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      throw new Error('本地存储写入失败：可能是浏览器隐私模式，或存储空间已满。');
    }
  }

  function nid(db, prefix) {
    db.seq = (db.seq || 0) + 1;
    return prefix + '_' + db.seq;
  }

  /** 按 conversation_id 过滤。null / undefined 表示「不筛」（对齐云端的可选条件） */
  function inConv(row, conversationId) {
    if (conversationId == null) return true;
    return String(row.conversation_id == null ? '' : row.conversation_id) ===
           String(conversationId);
  }

  function pick(src, keys) {
    const safe = {};
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(src, k)) safe[k] = src[k];
    }
    return safe;
  }

  function byCreatedAsc(a, b) {
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  }
  function byCreatedDesc(a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  }

  /* ══ 对话 ═════════════════════════════════════════════════════════════ */

  async function listConversations() {
    const db = read();
    return db.conversations.slice().sort(function (a, b) {
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  }

  async function createConversation(title) {
    const db = read();
    const at = nowIso();
    const row = {
      id: nid(db, 'lc'),
      owner_id: OWNER,
      title: title || '新对话',
      round_count: 0,
      last_run_at: null,
      last_touch_at: null,
      archived: false,
      created_at: at,
      updated_at: at,
    };
    db.conversations.push(row);
    write(db);
    return row;
  }

  async function updateConversation(id, patch) {
    const db = read();
    const row = db.conversations.filter(c => String(c.id) === String(id))[0];
    if (!row) return null;
    Object.assign(row, pick(patch, ['title', 'round_count', 'last_run_at',
                                    'last_touch_at', 'archived']));
    row.updated_at = Object.prototype.hasOwnProperty.call(patch, 'updated_at')
      ? patch.updated_at : nowIso();
    write(db);
    return row;
  }

  /** 删对话 = 连它的记忆 / 提案 / 反馈一起删，与云端行为一致 */
  async function deleteConversation(id) {
    const db = read();
    const hit = r => String(r.conversation_id == null ? '' : r.conversation_id) === String(id);
    db.conversations = db.conversations.filter(c => String(c.id) !== String(id));
    db.memories = db.memories.filter(r => !hit(r));
    db.proposals = db.proposals.filter(r => !hit(r));
    db.feedback = db.feedback.filter(r => !hit(r));
    write(db);
  }

  /* ══ 记忆 ═════════════════════════════════════════════════════════════ */

  async function listMemories(conversationId) {
    const db = read();
    return db.memories.filter(r => inConv(r, conversationId)).sort(byCreatedAsc);
  }

  async function adoptOrphans(conversationId) {
    const db = read();
    let memories = 0, proposals = 0;
    db.memories.forEach(function (m) {
      if (m.conversation_id == null) { m.conversation_id = conversationId; memories++; }
    });
    db.proposals.forEach(function (p) {
      if (p.conversation_id == null) { p.conversation_id = conversationId; proposals++; }
    });
    if (memories || proposals) write(db);
    return { memories: memories, proposals: proposals };
  }

  async function insertMemories(list, conversationId) {
    if (!list || !list.length) return [];
    const db = read();
    const at = nowIso();
    const rows = list.map(function (m) {
      return {
        id: nid(db, 'lm'),
        owner_id: OWNER,
        content: m.content,
        tier: m.tier || 'normal',
        base_weight: m.base_weight == null ? 0.6 : m.base_weight,
        lock: !!m.lock,
        archived: false,
        dormant: false,
        rescue_count: 0,
        rescue_base0: null,
        last_accessed: null,
        final_weight: null,
        archived_round: null,
        rescued_at: null,
        conversation_id: conversationId == null ? null : conversationId,
        created_at: at,
        updated_at: at,
      };
    });
    db.memories = db.memories.concat(rows);
    write(db);
    return rows;
  }

  async function updateMemory(id, patch) {
    const db = read();
    const row = db.memories.filter(m => String(m.id) === String(id))[0];
    if (!row) return null;
    Object.assign(row, pick(patch, ['content', 'tier', 'base_weight', 'lock', 'archived',
                                    'last_accessed', 'rescue_count', 'rescue_base0',
                                    'dormant', 'archived_round', 'final_weight',
                                    'rescued_at', 'conversation_id']));
    row.updated_at = nowIso();
    write(db);
    return row;
  }

  async function updateMemoriesMany(updates) {
    if (!updates || !updates.length) return [];
    // 一次读写搞定，不像云端要逐条发请求 —— 本地没有网络成本，
    // 但反复 JSON.stringify 整库仍然是浪费。
    const db = read();
    const out = [];
    const at = nowIso();
    for (const u of updates) {
      const row = db.memories.filter(m => String(m.id) === String(u.id))[0];
      if (!row) continue;
      Object.assign(row, pick(u.patch, ['content', 'tier', 'base_weight', 'lock',
                                        'archived', 'last_accessed', 'rescue_count',
                                        'rescue_base0', 'dormant', 'archived_round',
                                        'final_weight', 'rescued_at', 'conversation_id']));
      row.updated_at = at;
      out.push(row);
    }
    write(db);
    return out;
  }

  async function deleteMemory(id) {
    const db = read();
    db.memories = db.memories.filter(m => String(m.id) !== String(id));
    write(db);
  }

  /* ══ 提案 ═════════════════════════════════════════════════════════════ */

  async function listProposals(conversationId, limit) {
    const db = read();
    return db.proposals
      .filter(r => inConv(r, conversationId))
      .sort(byCreatedDesc)
      .slice(0, limit || 200);
  }

  async function insertProposal(p) {
    const db = read();
    const row = {
      id: nid(db, 'lp'),
      owner_id: OWNER,
      memory_id: p.memory_id == null ? null : p.memory_id,
      title: p.title,
      body: p.body || null,
      action: p.action || null,
      kind: p.kind || null,
      urgency: p.urgency, relevance: p.relevance, novelty: p.novelty,
      actionability: p.actionability, risk: p.risk,
      score: p.score,
      touched: !!p.touched,
      reason: p.reason || null,
      outcome: null,
      conversation_id: p.conversation_id == null ? null : p.conversation_id,
      created_at: nowIso(),
    };
    db.proposals.push(row);
    write(db);
    return row;
  }

  async function updateProposal(id, patch) {
    const db = read();
    const row = db.proposals.filter(p => String(p.id) === String(id))[0];
    if (!row) return null;
    Object.assign(row, pick(patch, ['outcome', 'touched', 'body', 'action', 'title']));
    write(db);
    return row;
  }

  /* ══ 反馈 ═════════════════════════════════════════════════════════════ */

  async function insertFeedback(f) {
    const db = read();
    const row = {
      id: nid(db, 'lf'),
      owner_id: OWNER,
      proposal_id: f.proposal_id == null ? null : f.proposal_id,
      outcome: f.outcome,
      note: f.note || null,
      conversation_id: f.conversation_id == null ? null : f.conversation_id,
      created_at: nowIso(),
    };
    db.feedback.push(row);
    write(db);
    return row;
  }

  async function listFeedback(conversationId, limit) {
    const db = read();
    return db.feedback
      .filter(r => inConv(r, conversationId))
      .sort(byCreatedDesc)
      .slice(0, limit || 100);
  }

  /* ══ 设置（全局，不随对话变化） ══════════════════════════════════════ */

  async function getSettings() {
    return read().user_settings;
  }

  async function saveSettings(patch) {
    const db = read();
    const safe = pick(patch, ['touch_line', 'quiet_start', 'quiet_end',
                              'notify_enabled', 'custom_keywords', 'llm']);
    safe.updated_at = nowIso();
    if (db.user_settings && db.user_settings.owner_id) {
      Object.assign(db.user_settings, safe);
    } else {
      db.user_settings = Object.assign({ owner_id: OWNER, created_at: nowIso() }, safe);
    }
    write(db);
    return db.user_settings;
  }

  /* ══ 同步版本号 ══════════════════════════════════════════════════════
     本地模式没有「别的设备」，这个版本号只有一个用途：
     同浏览器多标签页之间靠 BroadcastChannel 互相通知（见 sync.js）。
     保留它，是为了让 Sync 模块在两种模式下行为一致，不必到处写 if。 */

  async function getSyncState() {
    return read().sync_state;
  }

  async function bumpSync(device) {
    const db = read();
    const rev = Number((db.sync_state && db.sync_state.revision) || 0) + 1;
    db.sync_state = {
      owner_id: OWNER,
      revision: rev,
      device: device || null,
      updated_at: nowIso(),
    };
    write(db);
    return db.sync_state;
  }

  /* ══ 迁移支持 ════════════════════════════════════════════════════════
     登录后要把本地数据搬进账号时用。刻意保持「原始行」形态：
     不在这里做字段映射，映射属于云端写入侧的责任，塞在这里会让两边不一致。 */

  function dump() { return read(); }

  function hasAny(db) {
    const d = db || read();
    return !!(d.conversations.length || d.memories.length ||
              d.proposals.length || d.feedback.length);
  }

  /** 清空本地库。**登录迁移成功后调用** —— 不清的话下次登出再进，
      本地还留着一份旧数据，用户会以为「我的东西双份了」。 */
  function clear() { write(empty()); }

  return {
    listConversations, createConversation, updateConversation, deleteConversation,
    listMemories, adoptOrphans, insertMemories, updateMemory, updateMemoriesMany,
    deleteMemory,
    listProposals, insertProposal, updateProposal,
    insertFeedback, listFeedback,
    getSettings, saveSettings,
    getSyncState, bumpSync,
    dump, hasAny, clear,
  };
})();

if (typeof window !== 'undefined') window.LocalData = LocalData;
