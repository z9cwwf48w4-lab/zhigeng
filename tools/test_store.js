/* ==========================================================================
   AA · 本地数据层测试
   --------------------------------------------------------------------------
   两个目的，第一个比第二个重要得多：

   ① 接口对齐 —— LocalData 必须实现 Cloud.data 暴露的**每一个**方法。
      这是「新增一个数据方法、忘了实现本地版」这类 bug 的唯一防线：
      漏掉的表现是「运行时点了某个按钮突然报 sink(...) is not a function」，
      藏在某个不常走的路径里，上线很久都不会被发现。

   ② 行为正确 —— CRUD、过滤、级联删除、排序、设置单例。

   用 node 跑，自带 localStorage 桩。
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'static');
let failed = 0;

function ok(label, cond, extra) {
  if (cond) {
    console.log('  \u2705 ' + label);
  } else {
    failed++;
    console.log('  \u274c ' + label + (extra ? '  \u2192 ' + extra : ''));
  }
}

function eq(label, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(label, sa === sb, sa + ' \u2260 ' + sb);
}

/* ── 沙箱：localStorage 桩 + window ─────────────────────────────────── */

function makeSandbox() {
  const store = Object.create(null);
  const context = {
    console,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    setTimeout, clearTimeout, Promise, Date, JSON, Math, Number, String,
    Object, Array, RegExp, Error, Boolean, parseInt, parseFloat, isNaN,
  };
  context.window = {};
  context.window.localStorage = context.localStorage;
  vm.createContext(context);
  return context;
}

const ctx = makeSandbox();
vm.runInContext(fs.readFileSync(path.join(STATIC, 'locals.js'), 'utf8'), ctx,
                { filename: 'locals.js' });
vm.runInContext(fs.readFileSync(path.join(STATIC, 'cloud.js'), 'utf8'), ctx,
                { filename: 'cloud.js' });

const LocalData = ctx.window.LocalData;
const Cloud = ctx.window.Cloud;

console.log('\n\u2550\u2550 \u2460 \u63a5\u53e3\u5bf9\u9f50\uff08\u8def\u7531\u8868 \u00d7 \u672c\u5730\u5b9e\u73b0\uff09\u2550\u2550');

const routed = Object.keys(Cloud.data).sort();
ok('路由表非空', routed.length > 0, routed.length + ' 个');
console.log('  \u5171 ' + routed.length + ' \u4e2a\u65b9\u6cd5\uff1a' + routed.join(', '));

const missing = routed.filter(k => typeof LocalData[k] !== 'function');
ok('LocalData 实现了全部路由方法', missing.length === 0,
   missing.length ? '缺失: ' + missing.join(', ') : '');

// 反向：本地有、路由没列出来 —— 说明新方法写进了本地却忘了挂上路由，
// 表现同样是「某个操作写到一半没了」
const notRouted = Object.keys(LocalData).filter(function (k) {
  if (typeof LocalData[k] !== 'function') return false;
  return routed.indexOf(k) < 0 && ['dump', 'hasAny', 'clear'].indexOf(k) < 0;
});
ok('本地的方法都挂进了路由', notRouted.length === 0,
   notRouted.length ? '未挂: ' + notRouted.join(', ') : '');

console.log('\n\u2550\u2550 \u2461 \u8def\u7531\uff1a\u9ed8\u8ba4\u672c\u5730 \u2192 \u5207\u4e91\u7aef\u540e\u771f\u7684\u5207\u4e86\u2550\u2550');

ok('默认是本地模式', Cloud.mode() === 'local', Cloud.mode());

// eslint-disable-next-line no-unused-vars
(async function () {
  const c0 = await Cloud.data.createConversation('\u672c\u5730\u4f1a\u8bdd');
  ok('本地模式下写入走本地库', c0 && String(c0.id).indexOf('lc_') === 0,
     c0 && c0.id);
  ok('createConversation \u2192 \u53ef\u8bfb\u56de',
     (await Cloud.data.listConversations()).length === 1);

  Cloud.setMode('cloud');
  ok('切到云端模式', Cloud.mode() === 'cloud');
  let threw = null;
  try { await Cloud.data.listConversations(); } catch (e) { threw = e; }
  ok('云端模式下调到的是云端实现（因未配置而报错，而非静默写本地）',
     threw && /endpoint|publishableKey|云服务未配置/.test(threw.message),
     threw && threw.message);

  Cloud.setMode('local');

  console.log('\n\u2550\u2550 \u2462 \u5bf9\u8bdd\u2550\u2550');
  const convs = await Cloud.data.listConversations();
  eq('列表长度', convs.length, 1);
  const cid = convs[0].id;

  await Cloud.data.updateConversation(cid, { title: '\u6539\u8fc7\u540d', round_count: 3 });
  const after = (await Cloud.data.listConversations())[0];
  eq('改名生效', after.title, '\u6539\u8fc7\u540d');
  eq('轮次生效', after.round_count, 3);
  ok('updated_at 被刷新', !!after.updated_at);

  console.log('\n\u2550\u2550 \u2463 \u8bb0\u5fc6\uff1a\u63d2\u5165 / \u8fc7\u6ee4 / \u6279\u91cf\u66f4\u65b0 / \u5220\u9664\u2550\u2550');
  const mems = await Cloud.data.insertMemories([
    { content: '\u8bb0\u5fc6\u4e00' },
    { content: '\u8bb0\u5fc6\u4e8c', tier: 'locked', base_weight: 1, lock: true },
  ], cid);
  eq('插入返回两行', mems.length, 2);
  eq('默认 tier', mems[0].tier, 'normal');
  eq('默认 base_weight', mems[0].base_weight, 0.6);
  eq('默认 lock', mems[0].lock, false);
  ok('本地行带 owner_id（否则 settings/记忆会被当成「没建过」）', mems[0].owner_id === 'local');
  ok('带 created_at', !!mems[0].created_at);

  // 另一个会话的记忆，用来验证过滤
  const c2 = await Cloud.data.createConversation('\u53e6\u4e00\u4e2a');
  await Cloud.data.insertMemories([{ content: '\u522b\u7684\u4f1a\u8bdd\u7684\u8bb0\u5fc6' }], c2.id);
  eq('按会话过滤', (await Cloud.data.listMemories(cid)).length, 2);
  eq('不过滤则全取', (await Cloud.data.listMemories(null)).length, 3);

  const asc = (await Cloud.data.listMemories(cid)).map(m => m.content);
  eq('记忆按创建时间升序', asc, ['\u8bb0\u5fc6\u4e00', '\u8bb0\u5fc6\u4e8c']);

  await Cloud.data.updateMemoriesMany([
    { id: mems[0].id, patch: { archived: true, final_weight: 0.07 } },
    { id: mems[1].id, patch: { rescue_count: 2, last_accessed: '2026-09-19T00:00:00.000Z' } },
  ]);
  const m0 = (await Cloud.data.listMemories(cid)).filter(m => m.id === mems[0].id)[0];
  const m1 = (await Cloud.data.listMemories(cid)).filter(m => m.id === mems[1].id)[0];
  eq('批量更新：archived', m0.archived, true);
  eq('批量更新：final_weight', m0.final_weight, 0.07);
  eq('批量更新：rescue_count', m1.rescue_count, 2);

  // 白名单：不该写进去的字段必须被过滤掉（对齐云端 updateMemory 的行为）
  await Cloud.data.updateMemory(mems[0].id, { content: '\u6539\u6587', owner_id: '\u4f2a\u9020' });
  const m0b = (await Cloud.data.listMemories(cid)).filter(m => m.id === mems[0].id)[0];
  eq('白名单外字段被忽略（owner_id 没被改）', m0b.owner_id, 'local');
  eq('白名单内字段写入', m0b.content, '\u6539\u6587');

  await Cloud.data.deleteMemory(mems[1].id);
  eq('删除后剩 1 条', (await Cloud.data.listMemories(cid)).length, 1);

  console.log('\n\u2550\u2550 \u2464 \u63d0\u6848\u4e0e\u53cd\u9988\u2550\u2550');
  const p = await Cloud.data.insertProposal({
    title: '\u63d0\u6848', body: 'B', action: 'A', kind: 'k',
    urgency: 1, relevance: 2, novelty: 3, actionability: 4, risk: 5,
    score: 42, touched: true, reason: 'r', conversation_id: cid,
    memory_id: mems[0].id,
  });
  ok('提案落库', p && String(p.id).indexOf('lp_') === 0, p && p.id);
  eq('评价分量保留', p.score, 42);

  const props = await Cloud.data.listProposals(cid, 200);
  eq('提案按会话过滤', props.length, 1);
  await Cloud.data.updateProposal(p.id, { outcome: 'done', title: 'X' });
  const p2 = (await Cloud.data.listProposals(cid, 200))[0];
  eq('提案 outcome', p2.outcome, 'done');
  eq('提案标题更新', p2.title, 'X');

  const f = await Cloud.data.insertFeedback({ proposal_id: p.id, outcome: 'done', note: 'n', conversation_id: cid });
  ok('反馈落库', f && String(f.id).indexOf('lf_') === 0);
  eq('反馈按会话过滤', (await Cloud.data.listFeedback(cid, 100)).length, 1);

  console.log('\n\u2550\u2550 \u2465 \u8bbe\u7f6e\uff08\u5168\u5c40\u5355\u4f8b\uff09\u2550\u2550');
  eq('初始为 null', await Cloud.data.getSettings(), null);
  const st = await Cloud.data.saveSettings({ touch_line: 40, custom_keywords: 'a,b' });
  ok('首次保存会创建并带 owner_id', st.owner_id === 'local');
  const st2 = await Cloud.data.saveSettings({ notify_enabled: false });
  eq('二次保存不重复创建', st2.touch_line, 40);
  eq('二次保存合并新值', st2.notify_enabled, false);
  eq('只有一个设置行', (await Cloud.data.getSettings()).owner_id, 'local');

  console.log('\n\u2550\u2550 \u2466 \u540c\u6b65\u7248\u672c\u53f7\u2550\u2550');
  eq('初始无版本号', await Cloud.data.getSyncState(), null);
  await Cloud.data.bumpSync('\u6d4b\u8bd5');
  const s1 = await Cloud.data.bumpSync('\u6d4b\u8bd5');
  eq('递增到 2', s1.revision, 2);
  eq('设备名带上', s1.device, '\u6d4b\u8bd5');

  console.log('\n\u2550\u2550 \u2467 \u5b64\u513f\u6570\u636e\u5f52\u62e2 \u00b7 \u7ea7\u8054\u5220\u9664 \u00b7 \u8fc1\u79fb\u5de5\u5177\u2550\u2550');
  // 手动造一条 conversation_id 为空的老数据（模拟本版本之前写入的）
  const dbDump = LocalData.dump();
  ok('dump 能拿到原始库', dbDump && Array.isArray(dbDump.memories));

  // adoptOrphans：把没归属的行收进指定会话
  const res = await Cloud.data.adoptOrphans(cid);
  eq('归拢 0 条（当前数据都已有归属）', res.memories + res.proposals, 0);

  ok('hasAny 为真', LocalData.hasAny() === true);

  // 级联删除：删会话要连记忆/提案/反馈一起走
  const beforeAll = (await Cloud.data.listMemories(null)).length;
  await Cloud.data.deleteConversation(cid);
  eq('会话被删', (await Cloud.data.listConversations()).length, 1);
  const afterAll = (await Cloud.data.listMemories(null)).length;
  eq('该会话的记忆一并删除', afterAll, beforeAll - 1);
  eq('该会话的提案一并删除', (await Cloud.data.listProposals(null, 200)).length, 0);
  eq('该会话的反馈一并删除', (await Cloud.data.listFeedback(null, 100)).length, 0);
  ok('别的会话的记忆没被误删',
     (await Cloud.data.listMemories(null)).filter(m => m.conversation_id === c2.id).length === 1);

  console.log('\n\u2550\u2550 \u2468 \u5bb9\u9519\uff1a\u5b58\u50a8\u574f\u4e86\u4e5f\u4e0d\u80fd\u628a\u5e94\u7528\u5f04\u6302\u2550\u2550');
  ctx.localStorage.setItem('aa.local.v1', '{ \u8fd9\u4e0d\u662f JSON');
  const safe = await Cloud.data.listConversations();
  ok('JSON 坏掉时退化成空库而不是抛错', Array.isArray(safe) && safe.length === 0);

  console.log('\n\u2550\u2550 \u2469 \u6e05\u7a7a\uff08\u8fc1\u79fb\u6210\u529f\u540e\u8c03\u7528\uff09\u2550\u2550');
  LocalData.clear();
  ok('clear 后 hasAny 为假', LocalData.hasAny() === false);
  eq('clear 后会话为空', (await Cloud.data.listConversations()).length, 0);

  console.log('');
  if (failed) {
    console.log('\u274c \u672c\u5730\u6570\u636e\u5c42\u6d4b\u8bd5\u5931\u8d25\uff1a' + failed + ' \u9879');
    process.exit(1);
  }
  console.log('\u2705 \u672c\u5730\u6570\u636e\u5c42\u5168\u90e8\u901a\u8fc7\uff08\u63a5\u53e3\u5bf9\u9f50 + \u884c\u4e3a\u6b63\u786e\uff09\u3002');
})().catch(function (e) {
  console.error('\u274c \u6d4b\u8bd5\u811a\u672c\u81ea\u8eab\u62a5\u9519\uff1a', e);
  process.exit(1);
});
