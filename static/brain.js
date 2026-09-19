/* ==========================================================================
   AA · 提案大脑（前端移植版）
   --------------------------------------------------------------------------
   从 aa-agent/aa/{memory,scorer}.py 移植，算法逐行对齐，不做「优化改写」。
   移植原则：Python 版已经被 32 项回归测试和一轮 Codex 对抗审查打磨过，
   那些看起来奇怪的常量（RESCUE_KEEP=0.5、FORGET=0.10、touch_line=38）
   每一个都对应一个真实踩过的坑，见下方标注。

   为什么移植到前端而不是留在后端：
   平台托管的数据面只允许「已登录会话」直接访问，后端没有 SDK、也没法安全
   持有用户身份。把确定性算法放前端 = 少一层信任转发，也少一个能被打穿的洞。
   ========================================================================== */

/* ── 常量（与 Python 版逐字对齐） ──────────────────────────────────────── */

const LAMBDA = { locked: 0.0, normal: 0.03, volatile: 0.10 };
const FORGET = 0.10;              // 有效权重低于此值 → 进冷库
const RESCUE_KEEP = 0.5;          // 捞回后权重打折（不许满血复活）
const RESCUE_MIN_HITS = 2;        // 至少命中几个不同片段才算「同一件事」
const RESCUE_MIN_AGE_ROUNDS = 1;  // 刚归档的至少冷藏 1 轮才允许捞回
const MAX_RESCUE_COUNT = 3;       // 同一条最多被捞回几次，之后长眠
const MAX_ITEMS = 500;
const MAX_COLD = 500;
const MAX_PROPOSALS = 200;

/* tier 的中文标签与说明，界面直接引用，避免多处硬编码 */
const TIER_META = {
  locked:   { label: '锁定', desc: '永不衰减。安全边界、硬目标、你的核心偏好。' },
  normal:   { label: '常规', desc: '约 23 天减半。复盘结论、待办、阶段性想法。' },
  volatile: { label: '易逝', desc: '约 7 天减半。临时新闻、一时兴起。' },
};

/* ── 默认配置 ──────────────────────────────────────────────────────────── */

const DEFAULT_CONFIG = {
  touch_line: 38,   // 校准值。旧值 60 基于虚高的假分数，实际等于永不触达
  weights: { urgency: 0.30, relevance: 0.25, novelty: 0.20, actionability: 0.15, risk: 0.10 },

  risk_keywords: {
    high: ['下单', '买入', '卖出', '清仓', '满仓', '转账', '付款', '支付', '实盘',
           '代发', '发消息', '发送邮件', '改密码', '授权', '解绑', '注销'],
    mid: ['调仓', '调整持仓', '改配置', '删除', '替换', '排期', '预约', '开户',
          '报名', '提交', '联系', '打电话', '请假', '辞职'],
  },
  action_keywords: ['复盘', '检查', '记录', '整理', '看一眼', '核对', '提醒', '总结',
                    '对比', '测算', '确认', '回顾', '起草', '列出', '梳理', '更新'],
  focus_keywords: ['目标', '计划', '截止', '承诺', '预算', '账单', '体检', '锻炼',
                   '阅读', '学习', '考试', '项目', '汇报', '家人', '睡眠', '健康'],
  urgent_keywords: ['截止', '逾期', '最后一天', '最后期限', '紧急', '突发', '失败',
                    '错误', '崩溃', '警告', '异常', '取消', '变更', '提前', '延后'],
  time_keywords: ['今天', '今日', '立刻', '马上', '立即', '现在', '今晚', '尽快', '收盘前'],

  /* 用户自定义词表（持仓名、项目名、家人生日…）—— 相关度靠它才算得准 */
  custom_keywords: [],
};

/* ── 基础工具 ──────────────────────────────────────────────────────────── */

/**
 * 银行家舍入（round half to even），与 Python 的 round() 对齐。
 *
 * ⚠️ 这个函数不是多余的。JS 的 Math.round 是 half-up，Python 的 round 是
 *    half-to-even —— 平时看不出区别，但评分公式的权重都是两位小数、五个
 *    分量都是整数，总分**经常正好落在 x.5 上**。实测「现在回顾一下目标进度」
 *    这一条：Python 得 30，改之前 JS 得 31。1 分在 38 的触达线上不是小数，
 *    足以让一条本该静默的提案冒出来。移植必须连舍入规则一起对齐。
 */
function roundHalfEven(x) {
  if (!isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const f = Math.floor(ax);
  const d = ax - f;
  let r;
  if (d > 0.5) r = f + 1;
  else if (d < 0.5) r = f;
  else r = (f % 2 === 0) ? f : f + 1;
  return sign * r;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, roundHalfEven(v)));
}

function round3(v) {
  return roundHalfEven(v * 1000) / 1000;
}

/** 去掉标点与空白，只留字母/数字/汉字 */
function stripNoise(s) {
  return String(s == null ? '' : s).replace(/[^\w\u4e00-\u9fff]+/g, '');
}

/** 二元片段集合（中文按字切，英文数字按字符切，够用且无需分词器） */
function bigrams(text) {
  const s = stripNoise(text);
  const out = new Set();
  if (!s) return out;
  if (s.length < 2) { out.add(s); return out; }
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 三元片段集合（沉寂回收用；2 字太松，会误捞） */
function trigrams(text) {
  const s = stripNoise(text);
  const out = new Set();
  if (!s) return out;
  if (s.length < 3) { out.add(s); return out; }
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 命中了几个关键词（不是命中几次） */
function hits(text, words) {
  if (!text || !words || !words.length) return 0;
  let n = 0;
  for (const w of words) if (w && String(text).includes(w)) n++;
  return n;
}

function parseTs(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  return Math.max(0, (a - b) / 86400000);
}

/* ── 衰减与遗忘 ────────────────────────────────────────────────────────── */

/**
 * 有效权重 = base_weight × e^(−λ × 距上次访问天数)
 *
 * 加锁项恒定返回 base_weight —— 它永不衰减，不该显示成 0。
 * 注意：λ 取的是 tier 的值，而 locked tier 的 λ=0，两者在数学上等价，
 * 但 lock 标志另有语义（`isForgotten` 靠它跳过阈值判定），必须都保留。
 */
function effectiveWeight(item, at) {
  at = at || new Date();
  const base = Number(item.base_weight != null ? item.base_weight : 0.5) || 0;
  if (item.lock) return round3(base);
  const last = parseTs(item.last_accessed) || parseTs(item.created_at) || at;
  const days = daysBetween(at, last);
  const lam = Object.prototype.hasOwnProperty.call(LAMBDA, item.tier) ? LAMBDA[item.tier] : 0.03;
  return round3(base * Math.exp(-lam * days));
}

/** 加锁项永不遗忘；其余按阈值判定 */
function isForgotten(item, at) {
  if (item.lock) return false;
  return effectiveWeight(item, at) < FORGET;
}

/** 距彻底遗忘还有多少天（界面用来给「剩余寿命」一个直观数字） */
function daysUntilForgotten(item, at) {
  at = at || new Date();
  if (item.lock) return Infinity;
  const base = Number(item.base_weight != null ? item.base_weight : 0.5) || 0;
  if (base <= FORGET) return 0;
  const lam = Object.prototype.hasOwnProperty.call(LAMBDA, item.tier) ? LAMBDA[item.tier] : 0.03;
  if (lam <= 0) return Infinity;
  const cur = effectiveWeight(item, at);
  if (cur <= FORGET) return 0;
  return Math.max(0, Math.log(cur / FORGET) / lam);
}

/* ── 五个分量 ──────────────────────────────────────────────────────────── */

/**
 * 时效紧迫度。
 * ⚠️ 必须与「本条想法 / 当前世界」相关，不能只看时钟。
 *    第一版是纯时钟函数（只读 last_touch_at），加上各分量都有地板，
 *    白送 25 分，导致触达线形同虚设。所有地板现在归零。
 */
function urgency(idea, world, mem, at, cfg) {
  const meta = (mem && mem.meta) || {};
  const anchor = parseTs(meta.last_touch_at) || parseTs(meta.created_at) || at;
  const days = daysBetween(at, anchor);

  const silence = Math.min(40, days * 8);                                        // 沉寂度
  const worldUrgent = Math.min(40, 14 * hits(world, cfg.urgent_keywords));       // 世界真有事
  const temporal = Math.min(20, 10 * hits(idea, cfg.time_keywords));             // 想法催你动手
  return clamp(silence + worldUrgent + temporal);
}

/**
 * 相关度：外面发生的事，跟你真正在乎的东西有没有关系。
 *
 * ⚠️ 这里刻意打破「循环自证」：想法是提案器生成的，而模板会把目标原文抄进去，
 *    若只算「想法 ↔ 目标关键词」就是自己给自己刷分（实测恒为 100、极差 0）。
 *    所以权重最大的一层放在**我们控制不了的东西**上 —— 世界信号。
 */
function relevance(idea, world, mem, cfg) {
  const keys = (cfg.focus_keywords || []).concat(cfg.custom_keywords || []);
  const ideaS = idea || '';
  const worldS = world || '';

  // 1) 世界事件命中你在乎的词 —— 外部信号，提案器刷不出来
  const worldPart = Math.min(50, 25 * hits(worldS, keys));

  // 2) 与**活跃**记忆的语义重叠 —— 记忆衰减进冷库后就不再贡献，
  //    遗忘在这一项上第一次有了真实后果
  const activeText = activeItems(mem).map(it => it.content || '').join(' ');
  const overlap = jaccard(bigrams(ideaS + worldS), bigrams(activeText));
  const memPart = Math.min(30, 150 * overlap);

  // 3) 想法自身命中关键词（权重压到最低）
  const ideaPart = Math.min(20, 10 * hits(ideaS, keys));

  return clamp(worldPart + memPart + ideaPart);
}

/**
 * 新颖度：和历史提案越像越不新，避免同一件事反复唠叨。
 * 无历史时给 70（中性），不给满分当奖励 —— 旧版给 85 是白送分。
 */
function novelty(idea, mem) {
  const history = recentProposals(mem, 5);
  if (!history.length) return 70;
  const mine = bigrams(idea);
  let worst = 0;
  for (const r of history) {
    const j = jaccard(mine, bigrams(r.idea));
    if (j > worst) worst = j;
  }
  return clamp(100 * (1 - worst));
}

/** 可执行性：想法里有没有一个你能立刻动手的动作。旧版地板 60 是白送分。 */
function actionability(idea, world, cfg) {
  const text = (idea || '') + ' ' + (world || '');
  return clamp(18 * hits(text, cfg.action_keywords));
}

/**
 * 风险：越高越压分。
 * ⚠️ 只看 idea（AA 自己要提的动作），**不看世界信号**。
 *    第一版把 world 也扫进去，实测外部新闻里只要有「买入 / 调仓」这类字眼，
 *    闸门就被触发 —— 含风险词的新闻池触达率 83.5%，「别人的新闻」把
 *    「我该不该动手」的闸门淹没了。语义必须是：AA 想让我做的事有风险吗。
 */
function risk(idea, cfg) {
  const rk = cfg.risk_keywords || {};
  if (hits(idea, rk.high)) return 85;
  if (hits(idea, rk.mid)) return 55;
  return 10;
}

/** 世界信号里的风险词 —— 仅作提示，不触发闸门、不影响分数 */
function externalRisk(world, cfg) {
  const rk = cfg.risk_keywords || {};
  if (hits(world, rk.high)) return 'high';
  if (hits(world, rk.mid)) return 'mid';
  return 'low';
}

function riskLevel(idea, cfg) {
  const r = risk(idea, cfg);
  return r >= 80 ? 'high' : (r >= 40 ? 'mid' : 'low');
}

function components(idea, world, mem, at, cfg) {
  return {
    urgency: urgency(idea, world, mem, at, cfg),
    relevance: relevance(idea, world, mem, cfg),
    novelty: novelty(idea, mem),
    actionability: actionability(idea, world, cfg),
    risk: risk(idea, cfg),
  };
}

function scoreOf(comp, cfg) {
  const w = cfg.weights || DEFAULT_CONFIG.weights;
  return clamp(
    (w.urgency || 0) * comp.urgency +
    (w.relevance || 0) * comp.relevance +
    (w.novelty || 0) * comp.novelty +
    (w.actionability || 0) * comp.actionability -
    (w.risk || 0) * comp.risk
  );
}

/**
 * 路由：返回 { decision, score, comp, level, gated }
 *
 * ⚠️ 风险闸门：只要涉及钱或对外动作（mid / high），一律强制触达。
 *    风险项权重只有 0.10，最高扣 8.5 分，但恰好足以把高风险提案推下线 ——
 *    实测「建议买入 XX 并立刻下单」得 52 分被静默吞掉，而无害废话 59 分。
 *    真正该让人拍板的东西反而更不吭声。所以风险从「减分项」升级为闸门。
 *    扣分保留（尊重原公式），但不再能压掉决策。
 */
function route(idea, world, mem, at, cfg) {
  const comp = components(idea, world, mem, at, cfg);
  const s = scoreOf(comp, cfg);
  const line = cfg.touch_line != null ? cfg.touch_line : 38;
  const level = riskLevel(idea, cfg);

  let decision = s >= line ? 'touch' : 'silent';
  let gated = false;
  if (level !== 'low' && decision === 'silent') {
    decision = 'touch';
    gated = true;
  }
  return { decision, score: s, comp, level, gated };
}

/* ── 记忆集合操作 ──────────────────────────────────────────────────────── */

function activeItems(mem) {
  return ((mem && mem.items) || []).filter(it => !isForgotten(it));
}

function lockedItems(mem) {
  return ((mem && mem.items) || []).filter(it => it.lock);
}

function recentProposals(mem, limit = 5) {
  const p = (mem && mem.proposals) || [];
  return p.slice(-limit);
}

/* ── 沉寂回收（翻旧账） ────────────────────────────────────────────────── */

/**
 * 把世界信号切成片段，用于在冷库里翻旧账。
 * 同时给 2 字与 3 字：只给 3 字会漏掉短记忆（冷库存着「看盘」这种 ≤3 字的项，
 * 3 字片段里永远不含它 = 死代码）。2 字的误捞风险由覆盖率条件兜住。
 */
function rescueTokens(world, cfg) {
  const s = stripNoise(world);
  const toks = new Set(trigrams(s));
  for (const t of bigrams(s)) toks.add(t);
  if (!toks.size && s) toks.add(s);
  for (const kw of (cfg && cfg.focus_keywords) || []) {
    if (kw && s.includes(kw)) toks.add(kw);
  }
  return Array.from(toks);
}

/**
 * 判定阈值：绝对命中数达标 **且** 覆盖率达标。
 * 只用绝对命中数有两个坑：共享 4 字子串就误捞；≤3 字的短记忆永远捞不回来。
 * 短记忆改为按「≥60% 自身片段命中」判定。
 */
function rescueThreshold(content, minHits) {
  const baseHits = minHits == null ? RESCUE_MIN_HITS : minHits;
  const toks = trigrams(content);
  if (toks.size <= baseHits) return { needHits: 1, needCover: 0.6 };
  return { needHits: baseHits, needCover: 0.4 };
}

/**
 * 沉寂回收：冷库里被新事件命中的条目重新升权回到活跃区。
 *
 * ⚠️ 三个必须同时做对的地方（每个都对应一次真实翻车）：
 *   1) **时钟要重置**。冷库项 last_accessed 已是几十天前，不重置的话
 *      新权重 0.25 × e^(−0.10×30) ≈ 0.001 又低于遗忘线，下一轮立刻被重新归档，
 *      捞回变成空操作。
 *   2) **权重真打折**。旧实现用 max(0.35, x) 兜底，对 0.5 的项等于没降，
 *      捞回来和刚记住时一样强 —— 遗忘白做。但只改这一半也不行，
 *      所以是「时钟重置 + 权重打折」两者缺一不可。
 *   3) **折扣基准钉在首次被捞回前的权重上**。若拿已打过折的当前权重再打折，
 *      第二次就直接掉到遗忘线以下，等于只能捞回一次。
 */
function rescue(mem, keywords, at, minHits, minAgeRounds) {
  at = at || new Date();
  const kws = (keywords || []).filter(Boolean);
  const minAge = minAgeRounds == null ? RESCUE_MIN_AGE_ROUNDS : minAgeRounds;
  const curRound = Number(((mem && mem.meta) || {}).rounds || 0);

  const hitsOut = [];
  const rest = [];

  for (const raw of (mem.cold || [])) {
    const it = Object.assign({}, raw);

    // 刚归档的不许同轮捞回（否则同一轮里既「忘掉」又「捞回」，人根本看不到）
    if (curRound - Number(it.archived_round == null ? -999 : it.archived_round) < minAge) {
      rest.push(raw); continue;
    }

    const text = it.content || '';
    const rc = Number(it.rescue_count || 0);

    if (rc >= MAX_RESCUE_COUNT) {                       // 次数用尽 → 长眠
      raw.dormant = true;
      rest.push(raw); continue;
    }

    const th = rescueThreshold(text, minHits);
    const toks = trigrams(text);
    const matched = kws.filter(k => text.includes(k));
    const cover = toks.size ? (matched.filter(k => toks.has(k)).length / toks.size) : 0;

    if (matched.length >= th.needHits && cover >= th.needCover) {
      delete it.final_weight; delete it.archived_at;
      delete it.archived_round; delete it.dormant;

      const base0 = Number(it.rescue_base0 != null ? it.rescue_base0 : (it.base_weight != null ? it.base_weight : 0.5));
      const newBase = base0 * Math.pow(RESCUE_KEEP, rc + 1);

      if (newBase < FORGET) {                            // 淡到捞不动 → 长眠
        raw.dormant = true;
        raw.rescue_count = rc + 1;
        rest.push(raw); continue;
      }

      it.rescue_base0 = base0;
      it.base_weight = round3(newBase);
      it.last_accessed = at.toISOString();               // 必须重置时钟
      it.tier = it.tier || 'normal';                     // 保留原衰减率
      it.rescued_at = at.toISOString();
      it.rescue_count = rc + 1;

      hitsOut.push({ id: it.id, content: text, matched: matched.slice().sort(),
                     coverage: Math.round(cover * 100) / 100, base_weight: it.base_weight });
      if (!mem.items) mem.items = [];
      mem.items.push(it);
    } else {
      rest.push(raw);
    }
  }

  mem.cold = rest;
  return hitsOut;
}

/** 归档已遗忘项到冷库（归档，不删除）。skipIds：本轮刚被访问过的 id。 */
function archiveForgotten(mem, at, skipIds) {
  at = at || new Date();
  const skip = new Set(skipIds || []);
  const archived = [];
  const keep = [];

  for (const raw of (mem.items || [])) {
    if (!skip.has(raw.id) && isForgotten(raw, at)) {
      const it = Object.assign({}, raw);
      it.archived_at = at.toISOString();
      it.archived_round = Number(((mem.meta || {}).rounds) || 0);
      it.final_weight = effectiveWeight(it, at);
      archived.push(it.id);
      mem.cold.push(it);
    } else {
      keep.push(raw);
    }
  }
  mem.items = keep;
  if (mem.cold.length > MAX_COLD) mem.cold = mem.cold.slice(-MAX_COLD);
  return archived;
}

/* ── 提案器（确定性模板） ──────────────────────────────────────────────── */

/**
 * 生成候选提案。不依赖大模型 —— 保证任何网络状况下都有输出。
 * 每条候选都会走一遍评分闸门，只有够格的那条才会触达。
 */
function proposeCandidates(mem, world, at, cfg) {
  at = at || new Date();
  const items = activeItems(mem);
  const out = [];

  // ① 目标停滞：锁定目标长时间没被访问
  for (const it of items) {
    if (!it.lock) continue;
    const days = daysBetween(at, parseTs(it.last_accessed) || parseTs(it.created_at) || at);
    if (days >= 5) {
      out.push({
        memory_id: it.id,
        kind: 'goal_stalled',
        title: '目标「' + short(it.content) + '」已经 ' + Math.round(days) + ' 天没推进了',
        body: '这条是你亲手锁定、永不衰减的目标。它不会自己过期，但也正因为如此，' +
              '最容易在忙别的事时被悄悄搁置。',
        action: '今天做一件最小的事推进一步：看一眼进度，或定下一个能立刻完成的小动作。',
      });
    }
  }

  // ② 临期任务：含时间词的常规记忆，且已衰减过半
  for (const it of items) {
    if (it.lock) continue;
    const w = effectiveWeight(it, at);
    if (w < 0.35 && hits(it.content, cfg.time_keywords) + hits(it.content, cfg.urgent_keywords) > 0) {
      out.push({
        memory_id: it.id,
        kind: 'deadline',
        title: '「' + short(it.content) + '」快要从记忆里消失了',
        body: '这条记忆的有效权重已经掉到 ' + w.toFixed(2) + '，低于 0.10 就会被归档进冷库。' +
              '它带着时间要求，通常意味着事情还没做完 —— 忘了它就等于漏了。',
        action: '核对一下这件事现在到哪一步了，然后记录结论。',
      });
    }
  }

  // ③ 沉寂唤醒：很久没触达，且有还在意的记忆
  const lastTouch = parseTs((mem.meta || {}).last_touch_at);
  const silenceDays = lastTouch ? daysBetween(at, lastTouch) : 999;
  if (silenceDays >= 2 && items.length) {
    const pick = items.slice().sort((a, b) => effectiveWeight(b, at) - effectiveWeight(a, at))[0];
    out.push({
      memory_id: pick.id,
      kind: 'silence',
      title: '安静了 ' + (silenceDays >= 900 ? '一阵子' : Math.round(silenceDays) + ' 天') + '，回来看看你在意的事',
      body: 'AA 的规矩是只在真正值得打断时才出声。这段时间没有触达，说明没有紧急的事 ——' +
            '但也值得主动确认一次，别让重要的事因为「不紧急」而慢慢沉下去。',
      action: '花两分钟过一遍记忆库，把已经不重要的清掉，把重要的加上锁。',
    });
  }

  // ④ 冷库回捞：旧想法被新信号重新命中
  const toks = rescueTokens(world, cfg);
  if (toks.length) {
    for (const it of (mem.cold || [])) {
      if (it.dormant) continue;
      const text = it.content || '';
      const th = rescueThreshold(text);
      const matched = toks.filter(k => text.includes(k));
      const t3 = trigrams(text);
      const cover = t3.size ? (matched.filter(k => t3.has(k)).length / t3.size) : 0;
      if (matched.length >= th.needHits && cover >= th.needCover) {
        out.push({
          memory_id: it.id,
          kind: 'rescue',
          title: '这件事又出现了：' + short(text),
          body: '它曾经被归档进冷库（当时的权重已经低于 0.10），但现在的信号又把它翻了出来。' +
                'AA 不硬删任何东西，就是为了这一刻。',
          action: '确认它是否还重要：还重要就重新记下并加锁，不重要就让它继续待着。',
        });
      }
    }
  }

  // ⑤ 保底：刚起步或全都很新鲜时，给一条通用的推进提示
  if (!out.length) {
    out.push({
      memory_id: null,
      kind: 'baseline',
      title: '确认一次：你现在最想推进的是哪件事',
      body: '目前没有发现停滞的目标、临期的事或重新浮现的旧想法。' +
            '这种时候最值得做的是校准 —— 把注意力重新对准真正重要的那一件。',
      action: '列出此刻最想推进的一件事，记录进记忆库。',
    });
  }

  return out;
}

function short(s, n = 22) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ── 首跑引导模板 ──────────────────────────────────────────────────────── */

/**
 * 新用户不塞假数据（假数据会让「记忆衰减」看起来像真的但其实毫无意义）。
 * 给三条**可编辑的模板**，用户改写后才是他自己的记忆。
 */
const STARTER_MEMORIES = [
  { content: '我的近期首要目标（点这里改成你自己的）', tier: 'locked', base_weight: 0.9, lock: true },
  { content: '每天花 10 分钟回顾今天做了什么（改成你自己的习惯）', tier: 'normal', base_weight: 0.6, lock: false },
  { content: '一个最近冒出来的念头，不确定要不要做（改成你自己的）', tier: 'volatile', base_weight: 0.5, lock: false },
];

/* ── 导出 ──────────────────────────────────────────────────────────────── */

const AA = {
  LAMBDA, FORGET, RESCUE_KEEP, RESCUE_MIN_HITS, RESCUE_MIN_AGE_ROUNDS,
  MAX_RESCUE_COUNT, MAX_ITEMS, MAX_COLD, MAX_PROPOSALS,
  TIER_META, DEFAULT_CONFIG, STARTER_MEMORIES,
  roundHalfEven, clamp, round3, stripNoise, bigrams, trigrams, jaccard, hits,
  parseTs, daysBetween,
  effectiveWeight, isForgotten, daysUntilForgotten,
  urgency, relevance, novelty, actionability, risk, externalRisk, riskLevel,
  components, scoreOf, route,
  activeItems, lockedItems, recentProposals,
  rescueTokens, rescueThreshold, rescue, archiveForgotten,
  proposeCandidates, short,
};

if (typeof module !== 'undefined' && module.exports) module.exports = AA;
if (typeof window !== 'undefined') window.AA = AA;
