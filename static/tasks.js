/* ==========================================================================
   知更 · 任务执行器（并行）
   --------------------------------------------------------------------------
   为什么需要它：知更的「想一次」不是瞬间完成的活 —— 要结算衰减、要生成候选、
   要逐条打分、可能要问大模型润色、最后才落库。串行做一个还好，做三个就要等
   三倍时间；而这几步里最慢的是网络往返（大模型 / 数据库），正是并行的甜点。

   设计上刻意分成两段：

     ① 并行段（可以多个同时跑）—— 计算 + 网络。互不依赖，各自算自己的，
        用一个「方向序号」保证结果不重复：第 i 个任务取排名第 i 的候选。
        不需要任务之间互相通信，也就没有锁。
     ② 提交段（必须串行）—— 落库。数据库写入、内存里的列表追加都是共享状态，
        并发写会互相覆盖。所以提交走一把互斥锁（promise 链），一个接一个。

   这个「并行算、串行写」的分法是整个并行能力的核心：
   把并发放在安全的地方，把串行留在必须的地方。

   另外：任务面板存在的意义不只是好看。并行跑起来之后如果不显示进度，
   用户看到的就是「点了没反应」，比串行还糟。
   ========================================================================== */

const Tasks = (function () {
  const MAX_PARALLEL = 3;
  const KEEP = 40;          // 内存里保留的任务记录上限

  let seq = 0;
  let active = 0;
  const items = [];
  const listeners = [];
  let idleWaiters = [];
  let emitTimer = null;

  /* ── 通知（合并高频更新，避免每个任务状态变化都重绘整页） ─────────── */

  function emit() {
    if (emitTimer) return;
    emitTimer = setTimeout(function () {
      emitTimer = null;
      listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    }, 80);
  }

  function onChange(fn) { listeners.push(fn); }

  /* ── 队列 ─────────────────────────────────────────────────────────── */

  /**
   * 入队一个任务。
   * @param {{kind?:string,label:string,run:function}} spec
   *        run(ctx) —— ctx.setDetail(str) 更新进度文字；ctx.signal 用于响应取消
   * @returns {number} 任务 id
   */
  function add(spec) {
    const t = {
      id: ++seq,
      kind: spec.kind || 'task',
      label: spec.label || '任务',
      status: 'queued',
      detail: '排队中',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      error: null,
      result: null,
      cancelled: false,
      run: spec.run,
    };
    items.push(t);
    if (items.length > KEEP) items.splice(0, items.length - KEEP);
    emit();
    pump();
    return t.id;
  }

  function pump() {
    while (active < MAX_PARALLEL) {
      const next = items.filter(t => t.status === 'queued' && !t.cancelled)[0];
      if (!next) break;
      runOne(next);
    }
  }

  async function runOne(t) {
    active++;
    t.status = 'running';
    t.startedAt = Date.now();
    t.detail = '进行中';
    emit();

    const ctx = {
      setDetail: function (s) { t.detail = String(s == null ? '' : s); emit(); },
      signal: { get aborted() { return t.cancelled; } },
    };

    try {
      t.result = await t.run(ctx);
      if (t.cancelled) {
        t.status = 'cancelled';
        t.detail = '已取消';
      } else {
        t.status = 'done';
        const note = t.result && (t.result.note || t.result.summary);
        t.detail = note || '完成';
      }
    } catch (e) {
      if (t.cancelled) {
        t.status = 'cancelled';
        t.detail = '已取消';
      } else {
        t.status = 'error';
        t.error = (e && e.message) || String(e);
        t.detail = t.error;
      }
    } finally {
      t.endedAt = Date.now();
      active--;
      emit();
      pump();
      checkIdle();
    }
  }

  function checkIdle() {
    if (active > 0) return;
    if (items.some(t => t.status === 'queued' && !t.cancelled)) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  /** 等队列跑空。批量任务之后的收尾（更新对话轮次、同步版本号）靠它排序。 */
  function drain() {
    return new Promise(function (resolve) {
      if (active === 0 && !items.some(t => t.status === 'queued' && !t.cancelled)) {
        resolve();
        return;
      }
      idleWaiters.push(resolve);
    });
  }

  function cancel(id) {
    const t = items.filter(x => x.id === id)[0];
    if (!t || t.status === 'done' || t.status === 'error') return;
    t.cancelled = true;
    if (t.status === 'queued') { t.status = 'cancelled'; t.detail = '已取消'; }
    emit();
    checkIdle();
  }

  function cancelAll() {
    items.filter(t => t.status === 'queued' || t.status === 'running')
      .forEach(t => cancel(t.id));
  }

  function clearFinished() {
    for (let i = items.length - 1; i >= 0; i--) {
      const s = items[i].status;
      if (s === 'done' || s === 'error' || s === 'cancelled') items.splice(i, 1);
    }
    emit();
  }

  /* ── 状态查询 ─────────────────────────────────────────────────────── */

  function stats() {
    const by = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };
    items.forEach(function (t) { by[t.status] = (by[t.status] || 0) + 1; });
    return Object.assign({ total: items.length, parallel: MAX_PARALLEL }, by);
  }

  function busy() {
    return active > 0 || items.some(t => t.status === 'queued' && !t.cancelled);
  }

  function recent(n) {
    return items.slice(Math.max(0, items.length - (n || 6)));
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */

  const STATUS_ICON = {
    queued: 'clock', running: 'refresh', done: 'check',
    error: 'alert', cancelled: 'x',
  };

  function dur(t) {
    if (!t.startedAt) return '';
    const end = t.endedAt || Date.now();
    const ms = end - t.startedAt;
    return ms < 1000 ? (ms + ' ms') : ((ms / 1000).toFixed(1) + ' s');
  }

  /**
   * 启动区：并行度选择 + 开始按钮。
   * 并行度默认 3 —— 一次给三个不同方向，比反复点三次更接近「它在替你想」。
   */
  function launcherHTML(n) {
    const opts = [1, 3, 5];
    return '' +
    '<div class="launcher">' +
      '<div class="launcher-row">' +
        '<div class="launcher-label">' + icon('zap', 16) +
          '<span>并行度</span></div>' +
        '<div class="seg seg-sm" id="think-n">' +
          opts.map(function (v) {
            return '<button class="seg-btn" data-think-n="' + v + '" aria-selected="' +
              (Number(n) === v) + '">' + v + ' 路</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="launcher-row">' +
        '<p class="hint" style="margin:0">' +
          '每个方向独立计算、并行跑；落库串行，所以不会互相覆盖。' +
          '排名靠后的方向大概率会被判为「够不上打断你」，这正是它该有的样子。' +
        '</p>' +
        '<button class="btn btn-primary" data-act="think">' +
          icon('play', 16) + '让它想一次</button>' +
      '</div>' +
    '</div>';
  }

  /** 任务队列面板 */
  function panelHTML() {
    const list = recent(6);
    if (!list.length) return '';
    const st = stats();
    const running = st.running + st.queued;

    return '' +
    '<section class="tasks' + (running ? ' is-active' : '') + '" id="task-panel">' +
      '<div class="tasks-head">' +
        '<span class="tasks-title">' + icon('branch', 15) + '任务' +
          '<span class="muted">并行上限 ' + MAX_PARALLEL + '</span></span>' +
        '<span class="tasks-meta">' +
          (st.running ? '运行 ' + st.running : '') +
          (st.queued ? ' · 排队 ' + st.queued : '') +
          (st.done ? ' · 完成 ' + st.done : '') +
          (st.error ? ' · 失败 ' + st.error : '') +
        '</span>' +
        '<button class="link" data-act="task-clear">清空已完成</button>' +
      '</div>' +
      '<div class="tasks-list">' +
        list.map(function (t) {
          return '<div class="task is-' + t.status + '">' +
            '<span class="task-ic">' + icon(STATUS_ICON[t.status] || 'info', 15) + '</span>' +
            '<div class="task-main">' +
              '<div class="task-label">' + esc(t.label) + '</div>' +
              '<div class="task-detail" title="' + esc(t.detail) + '">' + esc(t.detail) + '</div>' +
            '</div>' +
            '<span class="task-time">' + esc(dur(t)) + '</span>' +
            ((t.status === 'running' || t.status === 'queued')
              ? '<button class="task-x" data-act="task-cancel" data-id="' + t.id +
                '" title="取消">' + icon('x', 14) + '</button>'
              : '') +
          '</div>';
        }).join('') +
      '</div>' +
    '</section>';
  }

  return {
    add, drain, cancel, cancelAll, clearFinished,
    stats, busy, recent, onChange, panelHTML, launcherHTML,
    MAX_PARALLEL,
  };
})();

if (typeof window !== 'undefined') window.Tasks = Tasks;
