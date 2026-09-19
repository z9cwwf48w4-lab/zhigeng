/* 大脑等价性校验 · JS 侧探针
 *
 * 从 stdin 读测试向量，用 brain.js 算一遍，结果从 stdout 吐 JSON。
 * 由 test_brain_parity.py 调用并与 Python 原版逐项比对。
 * 单独跑没有意义。
 */
const fs = require('fs');
const path = require('path');

const AA = require(path.join(__dirname, '..', 'static', 'brain.js'));

const raw = fs.readFileSync(0, 'utf8');
const input = JSON.parse(raw);
const cfg = input.cfg;
const now = new Date(input.now);

const out = { weights: [], forgotten: [], routes: [], rescue: [], archived: [] };

/* ① 衰减 */
for (const c of input.weightCases) {
  const item = {
    tier: c.tier,
    lock: c.lock,
    base_weight: c.base,
    last_accessed: c.last_accessed,
    created_at: c.last_accessed,
  };
  out.weights.push(AA.effectiveWeight(item, now));
  out.forgotten.push(AA.isForgotten(item, now));
}

/* ② 评分与路由 */
for (const c of input.routeCases) {
  const mem = JSON.parse(JSON.stringify(c.mem));
  const r = AA.route(c.idea, c.world || '', mem, now, cfg);
  out.routes.push({
    decision: r.decision,
    score: r.score,
    level: r.level,
    gated: r.gated,
    comp: r.comp,
  });
}

/* ③ 沉寂回收 */
if (input.rescueCase) {
  const mem = JSON.parse(JSON.stringify(input.rescueCase.mem));
  const hits = AA.rescue(mem, input.rescueCase.keywords, now, null, 0);
  out.rescue = {
    hits: hits.map(h => ({ id: h.id, base_weight: h.base_weight, coverage: h.coverage })),
    coldIds: (mem.cold || []).map(x => x.id).sort(),
    itemIds: (mem.items || []).map(x => x.id).sort(),
    weights: (mem.items || []).map(x => ({ id: x.id, base_weight: x.base_weight })),
  };
}

/* ④ 归档 */
if (input.archiveCase) {
  const mem = JSON.parse(JSON.stringify(input.archiveCase.mem));
  const archived = AA.archiveForgotten(mem, now, input.archiveCase.skip || []);
  out.archived = {
    archived: archived.slice().sort(),
    itemIds: (mem.items || []).map(x => x.id).sort(),
    coldIds: (mem.cold || []).map(x => x.id).sort(),
  };
}

process.stdout.write(JSON.stringify(out));
