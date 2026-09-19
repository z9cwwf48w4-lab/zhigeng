/* ==========================================================================
   AA · 实时同步
   --------------------------------------------------------------------------
   要解决的问题：同一个账号可能在三个地方同时开着 —— 桌面应用、手机浏览器、
   电脑浏览器。在任何一处做的改动，其他处几秒内要能看到，而不是「刷新一下才更新」。

   三层机制，各管一段：

     ① 版本号轮询（跨设备） —— sync_state 表里只有一行一列，每 5 秒读一次几乎无成本。
        为什么不用「直接查 memories/proposals 的最新时间」：那是三个表的请求，
        5 秒一次 × N 个端会很浪费；而一个版本号只改一次就能表达「有东西变了」。
     ② BroadcastChannel（同浏览器多标签页） —— 即时、零延迟，不用等轮询。
     ③ 页面重新可见时立即检查 —— 用户切回来最想要「马上是对的」，
        等 5 秒会让人觉得卡。这一步把体验从「定时轮询」变成「看起来是实时的」。

   一条重要的克制规则：**正在弹窗、或光标在输入框里时，不应用远端变化。**
   否则用户打字打到一半，界面被重绘、内容被替换，是比「慢几秒」严重得多的伤害。
   所以冲突时选择**推迟**，等界面空闲再同步。

   关于「谁改的」：版本号里带一个设备标签（浏览器 / 桌面应用），
   用于在提示里说清来源（「另一台设备上的改动」），不是身份认证，仅作提示。
   ========================================================================== */

const Sync = (function () {
  const CHANNEL = 'aa-sync';
  const POLL_MS = 5000;
  const MIN_APPLY_GAP_MS = 1500;   // 两次应用远端变化之间的最小间隔，防抖动
  const DEFER_MS = 2000;           // 界面忙时的重试间隔

  let channel = null;
  let timer = null;
  let running = false;
  let rev = null;
  let lastApplyAt = 0;
  let lastAt = null;               // 最近一次成功同步的时间
  let lastError = null;
  let source = null;
  /* 本地模式：没有远端可轮询，但 BroadcastChannel 仍然有用
     —— 同一浏览器的多个标签页之间依然应该保持一致。
     所以这里只关掉「轮询」，不关掉整个同步。 */
  let localOnly = false;
  const handlers = [];
  const listeners = [];

  function setLocalOnly(v) { localOnly = !!v; }
  function isLocalOnly() { return localOnly; }

  /** 设备标签：只用于在提示里说清「是哪边改的」 */
  function deviceLabel() {
    const ua = String(navigator.userAgent || '');
    if (/AA\b/.test(ua) || window.__AA_DESKTOP__) return '桌面应用';
    if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    return '浏览器';
  }

  /**
   * 界面是否「正忙」——忙着的时候不打断。
   * 判断两件事：有没有开着弹窗、光标在不在可输入元素里。
   */
  function uiBusy() {
    const root = document.getElementById('modal-root');
    if (root && root.children.length) return true;
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function notifyLocal() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function emit(info) {
    handlers.forEach(function (fn) { try { fn(info); } catch (e) {} });
  }

  /** 应用一次远端变化（可能被推迟） */
  async function apply(info) {
    const now = Date.now();
    if (uiBusy() || window.AAApp && window.AAApp.S && window.AAApp.S.busy) {
      setTimeout(function () { apply(info); }, DEFER_MS);
      lastError = '界面正忙，已推迟同步';
      notifyLocal();
      return;
    }
    if (now - lastApplyAt < MIN_APPLY_GAP_MS) {
      setTimeout(function () { apply(info); }, MIN_APPLY_GAP_MS);
      return;
    }
    lastApplyAt = now;
    lastAt = new Date().toISOString();
    lastError = null;
    source = info.source;
    notifyLocal();
    emit(info);
  }

  /** 读一次版本号；变了就通知上层刷新 */
  async function poll(isInitial) {
    if (!running) return;
    // 本地模式没有远端。硬轮询只会让状态行显示「已同步」——那是假话。
    if (localOnly) return;
    try {
      const st = await Cloud.data.getSyncState();
      lastError = null;
      if (st) {
        const r = Number(st.revision || 0);
        if (rev == null || isInitial) {
          rev = r;
        } else if (r !== rev) {
          rev = r;
          await apply({
            source: 'poll',
            device: st.device || '',
            at: st.updated_at || null,
          });
        }
      }
    } catch (e) {
      // 未登录 / 网络抖动都走这里。不弹错 —— 同步失败不该打断用户，
      // 但要在状态里留痕，免得「一声不响地不同步」变成隐形故障。
      lastError = (e && e.message) || String(e);
      notifyLocal();
    }
  }

  function start() {
    if (running) return;
    running = true;
    rev = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = function (ev) {
        const d = ev && ev.data;
        if (!d || d.kind !== 'changed') return;
        if (d.rev != null) rev = Number(d.rev);
        // 同一个标签页自己发的消息不用理会
        if (d.origin === clientId) return;
        apply({ source: 'channel', device: d.device || '', at: d.at || null });
      };
    } catch (e) {
      channel = null;   // 老浏览器没有 BroadcastChannel，靠轮询兜底
    }

    poll(true);
    if (!localOnly) timer = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    notifyLocal();
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (channel) { try { channel.close(); } catch (e) {} channel = null; }
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    rev = null;
    notifyLocal();
  }

  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    poll(false);
  }

  const clientId = Math.random().toString(36).slice(2, 10);

  /**
   * 本地有写入之后调用：把版本号 +1，并广播给同浏览器的其他标签页。
   * 上层不需要关心同步细节，只要在「改完了」之后喊一声。
   */
  async function bump(what) {
    try {
      const st = await Cloud.data.bumpSync(deviceLabel());
      if (st) rev = Number(st.revision || 0);
      lastAt = new Date().toISOString();
      lastError = null;
      if (channel) {
        channel.postMessage({
          kind: 'changed', rev: rev, origin: clientId,
          device: deviceLabel(), at: lastAt, what: what || null,
        });
      }
    } catch (e) {
      lastError = (e && e.message) || String(e);
    }
    notifyLocal();
  }

  return {
    start, stop, bump, poll, setLocalOnly, isLocalOnly,
    onRemote: function (fn) { handlers.push(fn); },
    onChange: function (fn) { listeners.push(fn); },
    deviceLabel,
    state: function () {
      return {
        running: running, revision: rev, lastAt: lastAt,
        lastError: lastError, lastSource: source,
        localOnly: localOnly,
        device: deviceLabel(),
        pollSeconds: POLL_MS / 1000,
      };
    },
  };
})();

if (typeof window !== 'undefined') window.Sync = Sync;
