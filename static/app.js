/* ==========================================================================
   知更 · 应用逻辑
   --------------------------------------------------------------------------
   分层：
     工具 → Toast/Modal → 状态 → 认证 → 数据结算 → 提案流程 → 路由/页面 → 启动

   两条不可动摇的约束：
   1. 任何用户内容进 DOM 前必须过 esc()。
   2. 任何写库调用都不带 owner_id（身份由平台按会话决定）。
   ========================================================================== */

(function () {
'use strict';

/* ══ 1 · 基础工具 ══════════════════════════════════════════════════════ */

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

/** HTML 转义。用户内容进 DOM 的唯一通道。 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 统一绑定事件：容器上委托，data-act 指定动作 */
function delegate(root, evt, handler) {
  root.addEventListener(evt, function (e) {
    const t = e.target.closest('[data-act]');
    if (t && root.contains(t)) handler(e, t);
  });
}

function fmtDay(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fmtTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 相对时间：3 分钟前 / 昨天 / 5 天前 */
function ago(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '—';
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  const days = Math.floor(sec / 86400);
  if (days === 1) return '昨天';
  if (days < 30) return days + ' 天前';
  return fmtDay(iso);
}

/** 把图标注入带 data-icon 的占位元素 */
function injectIcons(root) {
  $$('[data-icon]', root || document).forEach(function (node) {
    if (node.dataset.iconDone) return;
    node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, node.dataset.iconSize ? +node.dataset.iconSize : 20));
    node.dataset.iconDone = '1';
  });
  paintRanges(root || document);
}

/**
 * 把 range 的当前值写进 CSS 变量 --p，滑块轨道就能画出「已填充」的部分。
 *
 * 纯 CSS 做不到这件事：轨道要知道百分比才能分开上色，而百分比只有 JS 算得出。
 * 原生 range 配 accent-color 也能看，但轨道不分段 —— 一眼看不出「现在调到哪了」，
 * 这是滑块最该传达的信息。
 *
 * 挂在这里是因为 injectIcons 是唯一在每次渲染后都会被调用的函数；
 * 单独再散落几个调用点，早晚会漏掉新增的弹窗。
 */
function paintRanges(root) {
  $$('input[type="range"]', root).forEach(paintRange);
}

function paintRange(el) {
  if (!el || el.type !== 'range') return;
  const min = Number(el.min === '' ? 0 : el.min);
  const max = Number(el.max === '' ? 100 : el.max);
  const v = Number(el.value);
  const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', p.toFixed(2) + '%');
}

/* ══ 2 · Toast 与 Modal ═══════════════════════════════════════════════ */

function toast(msg, kind) {
  kind = kind || 'info';
  const map = { ok: 'check', err: 'alert', info: 'info' };
  const node = document.createElement('div');
  node.className = 'toast is-' + kind;
  node.innerHTML = '<span class="ic">' + icon(map[kind] || 'info', 18) + '</span>' +
                   '<span class="grow">' + esc(msg) + '</span>';
  $('#toasts').appendChild(node);
  setTimeout(function () {
    node.classList.add('is-out');
    setTimeout(function () { node.remove(); }, 200);
  }, kind === 'err' ? 5200 : 3200);
}

/**
 * 弹窗。返回 Promise，resolve 为被点击动作的 value（点遮罩/取消则 null）。
 * 焦点管理与 Esc 关闭是基本可用性，不是加分项。
 */
function modal(opts) {
  return new Promise(function (resolve) {
    const root = $('#modal-root');
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(opts.title || '') + '">' +
        (opts.title ? '<h3>' + esc(opts.title) + '</h3>' : '') +
        (opts.sub ? '<p class="sub">' + esc(opts.sub) + '</p>' : '') +
        '<div class="modal-body"></div>' +
        '<div class="modal-actions"></div>' +
      '</div>';

    const body = $('.modal-body', scrim);
    const acts = $('.modal-actions', scrim);
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    (opts.actions || [{ label: '知道了', value: true, kind: 'btn-primary' }]).forEach(function (a) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.kind || 'btn-ghost');
      b.textContent = a.label;
      b.onclick = function () { done(a.value); };
      acts.appendChild(b);
    });

    let settled = false;
    function done(v) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      scrim.remove();
      resolve(v);
    }
    function onKey(e) { if (e.key === 'Escape') done(null); }

    scrim.addEventListener('click', function (e) { if (e.target === scrim) done(null); });
    document.addEventListener('keydown', onKey);
    root.appendChild(scrim);

    const first = scrim.querySelector('input, textarea, button');
    if (first) first.focus();
  });
}

/* ══ 3 · 应用状态 ═════════════════════════════════════════════════════ */

/**
 * esc 提升成全局，供 tasks.js / conversations.js / sync.js 共用。
 * 与其让每个文件各抄一份（迟早会不一致），不如只留一个出口。
 */
window.esc = esc;

const S = {
  user: null,
  conversations: [],  // 全部对话
  convId: null,       // 当前对话 id
  memories: [],       // **当前对话**的记忆行（含已归档）—— 已按对话过滤
  proposals: [],      // **当前对话**的提案
  feedback: [],       // **当前对话**的反馈
  settings: null,     // 全局设置：触达线 / 通知 / 关键词
  cfg: null,          // 合并后的运行配置
  route: 'today',
  busy: false,
  authMode: 'login',
  booted: false,
  cloudOk: true,      // 云服务是否可用。配置/SDK 缺失时为 false —— 此时只能本地模式
  migrated: null,     // 登录后本地数据的迁移结果（null 表示本次登录没触发迁移）
  thinkN: 3,          // 「并行思考」并行度
  useLlm: false,      // 提案文案是否走平台大模型润色（默认关：未认证环境无法实测）
  llmModel: null,
  unreadChat: 0,      // 知更主动开口时你不在对话页 → 角标
  proactiveBusy: false,
  bootedAt: 0,
  profile: null,      // 「关于你」：称呼 / 自我介绍 / 邮箱（localStorage）
  version: { build: '', pending: null, lastCheck: null, error: null, applies: 0 },
};

/* 这几项是「用户偏好」，不是业务数据，放本地就够了 */
try {
  const n = Number(localStorage.getItem('aa.thinkN'));
  if (n === 1 || n === 3 || n === 5) S.thinkN = n;
  S.useLlm = localStorage.getItem('aa.useLlm') === '1';
  S.profile = JSON.parse(localStorage.getItem('aa.profile.v1') || 'null') || {};
} catch (e) { /* localStorage 被禁用时用默认值 */ }

function rememberPref(k, v) {
  try { localStorage.setItem(k, v); } catch (e) {}
}


/** 把 settings 行 + 默认配置合并成运行配置 */
function buildCfg() {
  const base = JSON.parse(JSON.stringify(AA.DEFAULT_CONFIG));
  const st = S.settings || {};
  if (st.touch_line != null) base.touch_line = Number(st.touch_line);
  const custom = String(st.custom_keywords || '')
    .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  base.custom_keywords = custom;
  return base;
}

/**
 * 构造 brain 需要的记忆模型（数据库行 → {items, cold, proposals, meta}）。
 *
 * meta 来自**当前对话**而不是全局设置：轮次、上次运行、上次触达都是「这件事
 * 想到第几轮了」，属于对话的属性。以前挂在 user_settings 上，而 saveSettings
 * 的白名单又把它们过滤掉了，导致轮次永远停在 0 —— 这次一并纠正。
 */
function memModel() {
  const c = Convos.current() || {};
  return {
    items: S.memories.filter(m => !m.archived),
    cold: S.memories.filter(m => m.archived),
    proposals: S.proposals.slice().reverse(),   // brain 期望按时间升序
    meta: {
      created_at: c.created_at || new Date().toISOString(),
      rounds: Number(c.round_count || 0),
      last_touch_at: c.last_touch_at || null,
      last_run_at: c.last_run_at || null,
    },
  };
}

/* ══ 4 · 认证 ═════════════════════════════════════════════════════════ */

const AUTH_COPY = {
  login:    { title: '登录', sub: '用注册时的邮箱继续。' },
  signup:   { title: '创建账户', sub: '先验证邮箱，再设置密码。' },
  otp:      { title: '验证码登录', sub: '不想记密码就用这个。' },
  phone:    { title: '手机号登录', sub: '验证码发到手机，同样不记密码。' },
  forgot:   { title: '重置密码', sub: '验证邮箱后设置新密码。' },
};

function renderAuth(mode) {
  S.authMode = mode || 'login';
  const c = AUTH_COPY[S.authMode] || AUTH_COPY.login;
  const host = $('#auth-form-host');

  let inner = '';

  if (S.authMode === 'login' || S.authMode === 'signup') {
    inner =
      '<div class="seg" role="tablist">' +
        '<button class="seg-btn" role="tab" data-auth-tab="login" aria-selected="' +
          (S.authMode === 'login') + '">登录</button>' +
        '<button class="seg-btn" role="tab" data-auth-tab="signup" aria-selected="' +
          (S.authMode === 'signup') + '">注册</button>' +
      '</div>' +
      '<div class="field">' +
        '<label class="label" for="f-email">邮箱</label>' +
        '<input class="input" id="f-email" type="email" autocomplete="email"' +
        ' inputmode="email" placeholder="you@example.com" spellcheck="false">' +
      '</div>' +
      '<div class="field">' +
        '<label class="label" for="f-pwd">密码</label>' +
        '<input class="input" id="f-pwd" type="password"' +
        ' autocomplete="' + (S.authMode === 'signup' ? 'new-password' : 'current-password') + '"' +
        ' placeholder="' + (S.authMode === 'signup' ? '至少 8 位' : '') + '">' +
      '</div>' +
      '<div class="hint-danger" id="auth-err"></div>' +
      '<button class="btn btn-primary btn-block" id="auth-go">' +
        (S.authMode === 'signup' ? '验证邮箱并创建' : '登录') + '</button>' +
      '<div class="auth-foot">' +
        '<button class="link" data-auth-tab="otp">用验证码登录</button>' +
        '<button class="link" data-auth-tab="phone">用手机号登录</button>' +
        (S.authMode === 'login' ? '<button class="link" data-auth-tab="forgot">忘记密码</button>' : '') +
        '<button class="link" data-act="auth-skip">先不登录，直接逛逛</button>' +
      '</div>';
  } else if (S.authMode === 'phone') {
    inner =
      '<div class="field">' +
        '<label class="label" for="f-phone">手机号</label>' +
        '<input class="input" id="f-phone" type="tel" autocomplete="tel"' +
        ' inputmode="numeric" maxlength="11" placeholder="13 位数的中国大陆手机号">' +
      '</div>' +
      '<button class="btn btn-ghost btn-block" id="auth-send">发送验证码</button>' +
      '<div class="field" id="otp-wrap" hidden>' +
        '<label class="label" for="f-otp">6 位验证码</label>' +
        '<input class="input otp-input" id="f-otp" inputmode="numeric"' +
        ' autocomplete="one-time-code" maxlength="6" placeholder="······">' +
      '</div>' +
      '<div class="hint-danger" id="auth-err"></div>' +
      '<button class="btn btn-primary btn-block" id="auth-go" hidden>登录</button>' +
      '<div class="auth-foot">' +
        '<button class="link" data-auth-tab="login">返回密码登录</button>' +
        '<button class="link" data-act="auth-skip">先不登录，直接逛逛</button>' +
      '</div>';
  } else if (S.authMode === 'otp') {
    inner =
      '<div class="field">' +
        '<label class="label" for="f-email">邮箱</label>' +
        '<input class="input" id="f-email" type="email" autocomplete="email"' +
        ' inputmode="email" placeholder="you@example.com" spellcheck="false">' +
      '</div>' +
      '<button class="btn btn-ghost btn-block" id="auth-send">发送验证码</button>' +
      '<div class="field" id="otp-wrap" hidden>' +
        '<label class="label" for="f-otp">6 位验证码</label>' +
        '<input class="input otp-input" id="f-otp" inputmode="numeric"' +
        ' autocomplete="one-time-code" maxlength="6" placeholder="······">' +
        '<p class="hint">没收到？翻一下垃圾邮件和「订阅邮件」，等一分钟再点重发。' +
        'QQ 邮箱的拦截最常见 —— 收件箱没有就去「垃圾箱」。</p>' +
      '</div>' +
      '<div class="hint-danger" id="auth-err"></div>' +
      '<button class="btn btn-primary btn-block" id="auth-go" hidden>登录</button>' +
      '<div class="auth-foot">' +
        '<button class="link" data-auth-tab="login">返回密码登录</button>' +
        '<button class="link" data-act="auth-skip">先不登录，直接逛逛</button>' +
      '</div>';
  } else {
    inner =
      '<div class="field">' +
        '<label class="label" for="f-email">邮箱</label>' +
        '<input class="input" id="f-email" type="email" autocomplete="email"' +
        ' inputmode="email" placeholder="you@example.com" spellcheck="false">' +
      '</div>' +
      '<button class="btn btn-ghost btn-block" id="auth-send">发送验证码</button>' +
      '<div class="field" id="otp-wrap" hidden>' +
        '<label class="label" for="f-otp">6 位验证码</label>' +
        '<input class="input otp-input" id="f-otp" inputmode="numeric"' +
        ' autocomplete="one-time-code" maxlength="6" placeholder="······">' +
      '</div>' +
      '<div class="field" id="pwd-wrap" hidden>' +
        '<label class="label" for="f-newpwd">新密码</label>' +
        '<input class="input" id="f-newpwd" type="password" autocomplete="new-password"' +
        ' placeholder="至少 8 位">' +
      '</div>' +
      '<div class="hint-danger" id="auth-err"></div>' +
      '<button class="btn btn-primary btn-block" id="auth-go" hidden>设置新密码并登录</button>' +
      '<div class="auth-foot">' +
        '<button class="link" data-auth-tab="login">返回登录</button>' +
        '<button class="link" data-act="auth-skip">先不登录，直接逛逛</button>' +
      '</div>';
  }

  host.innerHTML =
    '<h1>' + esc(c.title) + '</h1>' +
    '<p class="sub">' + esc(c.sub) + '</p>' +
    '<div class="auth-stack">' + inner + '</div>';

  bindAuth();
}

/* 各模式下暂存的验证码会话（内存，不落盘、不进 URL） */
let otpSession = { verificationId: null, isExistingUser: false, email: '' };
let forgotSession = { handle: null, email: '' };

function bindAuth() {
  $$('[data-auth-tab]').forEach(function (b) {
    b.onclick = function () { renderAuth(b.dataset.authTab); };
  });

  /* 「先不登录，直接逛逛」：回背后已就绪的本地模式。
     首启流程是先 enterLocal 再 openAuth，所以 S.booted 必然为真；
     若真出现未启动的边角情况（理论不可达），点击无副作用即可。 */
  $$('[data-act="auth-skip"]').forEach(function (b) {
    b.onclick = function () { if (S.booted) backToApp(); };
  });

  const errEl = $('#auth-err');
  const setErr = m => { if (errEl) errEl.textContent = m || ''; };
  const busy = (btn, on, label) => {
    if (!btn) return;
    btn.disabled = !!on;
    if (label) btn.textContent = label;
  };

  const goBtn = $('#auth-go');
  const sendBtn = $('#auth-send');

  if (sendBtn) {
    sendBtn.onclick = async function () {
      const email = ($('#f-email').value || '').trim();
      const phone = ($('#f-phone') ? $('#f-phone').value || '' : '').trim();
      setErr('');
      if (S.authMode === 'phone') {
        if (!/^1[3-9]\d{9}$/.test(phone)) { setErr('请输入有效的 11 位手机号。'); return; }
        busy(sendBtn, true, '发送中…');
        try {
          otpSession = { verificationId: null, isExistingUser: false, email: '', phone: phone };
          const r = await Cloud.auth.sendSmsOtp(phone);
          otpSession.verificationId = r && r.verificationId;
          otpSession.isExistingUser = !!(r && r.isExistingUser);
          $('#otp-wrap').hidden = false;
          goBtn.hidden = false;
          busy(sendBtn, false, '重新发送');
          toast('验证码已发到 ' + phone + '。', 'ok');
          const otp = $('#f-otp'); if (otp) otp.focus();
        } catch (e) {
          busy(sendBtn, false, '发送验证码');
          setErr(Cloud.humanize(e));
        }
        return;
      }
      if (!email || email.indexOf('@') < 1) { setErr('请输入有效的邮箱地址。'); return; }
      busy(sendBtn, true, '发送中…');
      try {
        if (S.authMode === 'forgot') {
          const h = await Cloud.auth.resetPasswordForEmail(email);
          forgotSession = { handle: h, email: email };
        } else {
          const r = await Cloud.auth.sendOtp(email);
          otpSession = {
            verificationId: r && r.verificationId,
            isExistingUser: !!(r && r.isExistingUser),
            email: email,
          };
        }
        $('#otp-wrap').hidden = false;
        $('#pwd-wrap') && ($('#pwd-wrap').hidden = false);
        goBtn.hidden = false;
        busy(sendBtn, false, '重新发送');
        setErr('');
        toast('验证码已发到 ' + email + '。没收到就翻翻垃圾邮件和「订阅邮件」。', 'ok');
        const otp = $('#f-otp'); if (otp) otp.focus();
      } catch (e) {
        busy(sendBtn, false, '发送验证码');
        setErr(Cloud.humanize(e));
      }
    };
  }

  if (goBtn) {
    goBtn.onclick = async function () {
      const email = ($('#f-email').value || '').trim();
      setErr('');

      /* 密码登录 / 注册 */
      if (S.authMode === 'login' || S.authMode === 'signup') {
        const pwd = $('#f-pwd').value || '';
        if (!email || email.indexOf('@') < 1) { setErr('请输入有效的邮箱地址。'); return; }
        if (pwd.length < 8) { setErr('密码至少 8 位。'); return; }
        busy(goBtn, true, '处理中…');
        try {
          if (S.authMode === 'login') {
            await Cloud.auth.signInWithPassword(email, pwd);
            await enterApp();
          } else {
            // 注册必须先验证邮箱：发码 → 校验并把密码挂在验证码链上
            const sent = await Cloud.auth.sendOtp(email);
            if (sent && sent.isExistingUser) {
              // 不暴露「已注册」这个事实，统一引导去登录
              setErr('该邮箱无法用于注册，请改用登录（或使用验证码登录）。');
              busy(goBtn, false, '验证邮箱并创建');
              return;
            }
            const code = await modal({
              title: '输入验证码',
              sub: '验证码已发送到 ' + email,
              body: '<div class="field"><input class="input otp-input" id="m-otp"' +
                    ' inputmode="numeric" maxlength="6" placeholder="······"></div>',
              actions: [
                { label: '取消', value: null, kind: 'btn-ghost' },
                { label: '验证并创建', value: 'ok', kind: 'btn-primary' },
              ],
            });
            if (code !== 'ok') { busy(goBtn, false, '验证邮箱并创建'); return; }
            const token = $('#m-otp').value.trim();
            await Cloud.auth.verifyOtp({
              verificationId: sent.verificationId,
              token: token,
              email: email,
              isExistingUser: false,
              password: pwd,
            });
            await enterApp();
          }
        } catch (e) {
          busy(goBtn, false, S.authMode === 'login' ? '登录' : '验证邮箱并创建');
          setErr(Cloud.humanize(e));
        }
        return;
      }

      /* 手机号验证码登录 */
      if (S.authMode === 'phone') {
        const token = ($('#f-otp').value || '').trim();
        if (!token) { setErr('请输入验证码。'); return; }
        busy(goBtn, true, '验证中…');
        try {
          await Cloud.auth.verifySmsOtp({
            verificationId: otpSession.verificationId,
            token: token, phone: otpSession.phone,
          });
          await enterApp();
        } catch (e) {
          busy(goBtn, false, '登录');
          setErr(Cloud.humanize(e));
        }
        return;
      }

      /* 验证码登录 */
      if (S.authMode === 'otp') {
        const token = ($('#f-otp').value || '').trim();
        if (!token) { setErr('请输入验证码。'); return; }
        busy(goBtn, true, '验证中…');
        try {
          await Cloud.auth.verifyOtp({
            verificationId: otpSession.verificationId,
            token: token, email: otpSession.email,
            isExistingUser: otpSession.isExistingUser,
          });
          await enterApp();
        } catch (e) {
          busy(goBtn, false, '登录');
          setErr(Cloud.humanize(e));
        }
        return;
      }

      /* 找回密码 */
      if (S.authMode === 'forgot') {
        const token = ($('#f-otp').value || '').trim();
        const np = ($('#f-newpwd').value || '');
        if (!token) { setErr('请输入验证码。'); return; }
        if (np.length < 8) { setErr('新密码至少 8 位。'); return; }
        busy(goBtn, true, '处理中…');
        try {
          await Cloud.auth.resetPasswordWithNonce(forgotSession.handle, token, np);
          toast('密码已重置，正在进入。', 'ok');
          await enterApp();
        } catch (e) {
          busy(goBtn, false, '设置新密码并登录');
          setErr(Cloud.humanize(e));
        }
      }
    };
  }

  // 回车提交
  $$('#f-email, #f-pwd, #f-otp, #f-newpwd').forEach(function (i) {
    i.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); (sendBtn && !sendBtn.hidden && !goBtn.hidden ? goBtn : (goBtn || sendBtn)).click(); }
    });
  });
}

/* ══ 5 · 加载与结算 ═══════════════════════════════════════════════════ */

/**
 * 只加载「当前对话」的数据。
 *
 * 这是多对话能成立的关键：界面层完全不改 —— viewToday / viewMemory /
 * viewHistory 读的还是 S.memories 和 S.proposals，只是这两个数组里
 * 只剩当前对话的内容。切对话 = 换一份数据 + 重绘，不需要给每个视图
 * 加「按对话过滤」的分支（那种改法迟早会有哪个视图漏掉）。
 */
async function loadConversationData() {
  const cid = S.convId;
  const [mems, props, fbs] = await Promise.all([
    Cloud.data.listMemories(cid),
    Cloud.data.listProposals(cid, 200),
    Cloud.data.listFeedback(cid, 100),
  ]);
  S.memories = mems || [];
  S.proposals = props || [];
  S.feedback = fbs || [];
}

async function loadAll() {
  const [, st] = await Promise.all([
    loadConversationData(),
    Cloud.data.getSettings(),
  ]);
  S.settings = st || null;
  S.cfg = buildCfg();
}

/** 切换对话后重新取数并重绘 */
async function reloadConversation() {
  await loadConversationData();
  render();
}

/** 确保 settings 行存在（新用户没有） */
async function ensureSettings() {
  // 自有后端的设置行主键是 user_id（平台时代是 owner_id），兼容两种
  if (S.settings && (S.settings.owner_id || S.settings.user_id)) return;
  S.settings = await Cloud.data.saveSettings({
    touch_line: AA.DEFAULT_CONFIG.touch_line,
    quiet_start: 22, quiet_end: 8, notify_enabled: true, custom_keywords: '',
  });
  S.cfg = buildCfg();
}

/**
 * 更新当前对话的运行状态（轮次 / 上次运行 / 上次触达）。
 *
 * 落在 conversations 表而不是 user_settings：
 * 「这件事想到第几轮了」是对话的属性，不是账号的属性。以前挂在 settings 上，
 * 而 saveSettings 的白名单又把 rounds / last_run_at 过滤掉了 —— 结果轮次永远
 * 停在 0、自动跑轮次的判重也永远失效。这次连根拔掉。
 */
async function bumpConversation(fields) {
  const c = Convos.current();
  if (!c) return;
  const at = new Date().toISOString();
  const patch = Object.assign({}, fields, { updated_at: at });
  try {
    const row = await Cloud.data.updateConversation(c.id, patch);
    Object.assign(c, row || patch);
  } catch (e) {
    Object.assign(c, patch);   // 落库失败也让本地先一致，别卡住界面
  }
}

/**
 * 结算：把「时间的流逝」真正落到数据上。
 * 没有这一步，衰减就只是界面上的一个数字 —— 记忆永远不会真的进冷库。
 */
async function settle() {
  const at = new Date();
  const mem = memModel();
  const conv = Convos.current() || {};
  const round = Number(conv.round_count || 0);

  // ① 归档已遗忘项
  const archivedIds = AA.archiveForgotten(mem, at, []);
  const updates = archivedIds.map(function (id) {
    const it = (mem.cold || []).filter(c => String(c.id) === String(id))[0] || {};
    return { id: id, patch: {
      archived: true,
      final_weight: it.final_weight,
      archived_round: round,
    } };
  });

  // ② 沉寂回收：以最近 24 小时新增的记忆作为「新信号」
  const fresh = S.memories.filter(function (m) {
    if (m.archived) return false;
    const t = m.created_at ? new Date(m.created_at).getTime() : 0;
    return Date.now() - t < 86400000;
  }).map(m => m.content).join(' ');
  let rescued = [];
  if (fresh) {
    const toks = AA.rescueTokens(fresh, S.cfg);
    rescued = AA.rescue(mem, toks, at) || [];
  }
  rescued.forEach(function (h) {
    updates.push({ id: h.id, patch: {
      archived: false,
      base_weight: h.base_weight,
      last_accessed: at.toISOString(),
      rescued_at: at.toISOString(),
      rescue_count: h.rescue_count,
    } });
  });

  if (updates.length) {
    await Cloud.data.updateMemoriesMany(updates);
    // 本地同步，避免为了几条更新重拉整表
    updates.forEach(function (u) {
      const row = S.memories.filter(m => String(m.id) === String(u.id))[0];
      if (row) Object.assign(row, u.patch);
    });
  }
  return { archived: archivedIds, rescued: rescued };
}

/* ══ 6 · 提案流程 ═════════════════════════════════════════════════════ */

/** 最近 24h 新增记忆 → 作为 world 信号（没有真实外部信号源时的诚实替代） */
function worldSignal() {
  return S.memories.filter(function (m) {
    if (m.archived) return false;
    const t = m.created_at ? new Date(m.created_at).getTime() : 0;
    return Date.now() - t < 86400000;
  }).map(m => m.content).join(' ');
}

/**
 * 落库互斥锁。
 *
 * 数据库写入和内存数组追加都是共享状态，两个任务同时写会互相覆盖
 * （典型的：两条提案都从同一个 S.proposals 快照算 unshift，后写的把先写的挤掉）。
 * 用一条 promise 链把它们排成一队 —— 计算并行、落库串行。
 *
 * 链上的失败不能把链本身弄断，否则后续所有落库都会跟着挂掉，
 * 所以每次都把「失败」吞掉再接到链尾。
 */
let commitChain = Promise.resolve();
function withCommitLock(fn) {
  const run = commitChain.then(fn, fn);
  commitChain = run.then(function () {}, function () {});
  return run;
}

/* ── 自接入大模型（OpenAI 兼容） ─────────────────────────────────────────
   用户填自己的 base_url + api_key + 模型名，像 OpenClaw 接第三方 API 一样用。
   配置存两处：localStorage（本机即时生效）+ user_settings.llm（云端，跨设备跟随）。
   云端有配置时优先 —— 它是用户最近一次在任意设备上保存的版本。 */

const LLM_PRESETS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
              hint: 'platform.deepseek.com 申请 key' },
  moonshot: { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
              hint: 'platform.moonshot.cn 申请 key' },
  zhipu:    { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paip/v4', model: 'glm-4-air',
              hint: 'open.bigmodel.cn 申请 key' },
  custom:   { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', hint: '填到「接口地址」即可，路径会自动补 /chat/completions' },
};

function readLlmPref() {
  if (S.settings && S.settings.llm && S.settings.llm.apiKey && S.settings.llm.baseUrl) {
    return S.settings.llm;
  }
  try {
    const j = JSON.parse(localStorage.getItem('aa.llm') || 'null');
    if (j && j.apiKey && j.baseUrl) return j;
  } catch (e) { /* 坏数据当没配 */ }
  return null;
}

/** 走本进程的中继调外部模型（浏览器直连供应商会被 CORS 拦，中继没有这个问题） */
async function relayLlmComplete({ cfg, system, user, maxChars }) {
  const r = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: cfg.baseUrl, api_key: cfg.apiKey, model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).detail || ''; } catch (e) {}
    throw new Error('HTTP ' + r.status + (detail ? ' · ' + detail.slice(0, 120) : ''));
  }
  const j = await r.json();
  let text = (j.choices && j.choices[0] && j.choices[0].message &&
              j.choices[0].message.content) || '';
  if (maxChars && text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

/**
 * 并行段：算出「第 rank 顺位」的候选提案。**不写任何共享状态**，所以可以并发。
 *
 * 为什么用「顺位」而不是随机或不同的记忆：
 * 同一批候选里，第 1 名大概率会被触达，第 3、第 5 名大概率被静默压在下面 ——
 * 这正是我们想给用户看到的东西：它同时在往几个方向想，但只有够格的才出声。
 * 顺位是确定性的，所以并发跑也不会撞车，不需要任务之间通信。
 */
async function computeDraft(rank, ctx, at) {
  const at_ = at || new Date();
  const mem = memModel();
  const world = worldSignal();

  const cands = AA.proposeCandidates(mem, world, at_, S.cfg);
  const scored = cands.map(function (c) {
    return Object.assign({}, c,
      AA.route(c.title + ' ' + (c.action || ''), world, mem, at_, S.cfg));
  });
  scored.sort((a, b) => b.score - a.score);

  if (ctx) ctx.setDetail('候选 ' + scored.length + ' 条 · 取第 ' + (rank + 1) + ' 顺位');
  const pick = scored[rank];
  if (!pick) return { empty: true, note: '候选不足（只有 ' + scored.length + ' 条）' };

  let body = pick.body;
  let note = '评分 ' + pick.score;
  const reason = pick.gated
    ? '风险闸门：涉及可能造成损失或对外的动作，按规则强制触达，不允许静默。'
    : (pick.decision === 'touch'
        ? '评分 ' + pick.score + ' ≥ 触达线 ' + S.cfg.touch_line + '，达到打断你的标准。'
        : '评分 ' + pick.score + ' < 触达线 ' + S.cfg.touch_line + '，按规则保持静默。');

  /* 自接入配置存在就直接用，不必再手动开「润色」开关 */
  if (S.useLlm || readLlmPref()) {
    const ext = readLlmPref();
    try {
      if (ext) {
        /* 用户接了自己的大模型（OpenAI 兼容），优先用他的 */
        if (ctx) ctx.setDetail('用你接入的模型润色中…');
        const text = await relayLlmComplete({
          cfg: ext,
          system: '你是知更的提案写作助手。知更是一个主动提案器：它替用户想该做什么，' +
                  '而不是回答用户的问题。你的输出要克制、具体、可执行，' +
                  '不要客套话，不要 markdown，不要加引号。',
          user: '用户近期在意的：' + (world || '（暂无）') + '\n' +
                '这条提案的标题：' + pick.title + '\n' +
                '参考写法：' + (pick.body || '') + '\n' +
                '请只输出一段不超过 60 字的中文正文，说清「为什么要现在做这件事」，直接给正文。',
          maxChars: 240,
        });
        const t = String(text || '').trim().replace(/^["「]|["」]$/g, '');
        if (t) { body = t; note += ' · 已润色（自接入）'; }
        else { note += ' · 润色失败'; }
      } else {
        /* 用户没接自己的模型 → 走服务端默认配置（运营者在服务端可选配）。 */
        if (ctx) ctx.setDetail('大模型润色中…');
        const text = await Cloud.llm.complete({
          system: '你是知更的提案写作助手。知更是一个主动提案器：它替用户想该做什么，' +
                  '而不是回答用户的问题。你的输出要克制、具体、可执行，' +
                  '不要客套话，不要 markdown，不要加引号。',
          user: '用户近期在意的：' + (world || '（暂无）') + '\n' +
                '这条提案的标题：' + pick.title + '\n' +
                '参考写法：' + (pick.body || '') + '\n' +
                '请只输出一段不超过 60 字的中文正文，说清「为什么要现在做这件事」，直接给正文。',
          maxChars: 240,
        });
        const t = String(text || '').trim().replace(/^["「]|["」]$/g, '');
        if (t) { body = t; note += ' · 已润色'; }
      }
    } catch (e) {
      note += ' · 润色失败';
    }
  }

  return { draft: pick, body: body, reason: reason, at: at_, note: note };
}

/**
 * 串行段：把算好的草稿落库。
 * 去重放在这里而不是计算段 —— 只有串行的地方才能安全地「看现在库里有什么」。
 */
async function commitDraft(res, ctx) {
  if (!res || res.empty) return { saved: null, note: res ? res.note : '无结果' };
  return withCommitLock(async function () {
    const d = res.draft;
    const recent = Date.now() - 5 * 60 * 1000;

    const dup = S.proposals.filter(function (p) {
      if (String(p.title || '').trim() !== String(d.title || '').trim()) return false;
      const t = p.created_at ? new Date(p.created_at).getTime() : 0;
      return t > recent;
    })[0];
    if (dup) {
      if (ctx) ctx.setDetail('与 5 分钟内已有提案重复，跳过');
      return { saved: null, note: '重复，跳过' };
    }

    if (ctx) ctx.setDetail('落库…');
    const saved = await Cloud.data.insertProposal({
      conversation_id: S.convId,
      memory_id: d.memory_id,
      title: d.title,
      body: res.body,
      action: d.action,
      kind: d.kind,
      urgency: d.comp.urgency,
      relevance: d.comp.relevance,
      novelty: d.comp.novelty,
      actionability: d.comp.actionability,
      risk: d.comp.risk,
      score: d.score,
      touched: d.decision === 'touch',
      reason: res.reason,
    });

    if (saved) S.proposals.unshift(saved);

    // 提案引用了某条记忆 → 视为访问，刷新它的衰减时钟（「被想起过」）
    if (d.memory_id) {
      const ts = (res.at || new Date()).toISOString();
      try {
        await Cloud.data.updateMemory(d.memory_id, { last_accessed: ts });
      } catch (e) { /* 时钟刷新失败不该让提案作废 */ }
      const row = S.memories.filter(m => String(m.id) === String(d.memory_id))[0];
      if (row) row.last_accessed = ts;
    }

    if (saved && d.decision === 'touch') notify(saved);
    if (ctx) ctx.setDetail('评分 ' + d.score + ' · ' + (d.decision === 'touch' ? '触达' : '静默'));
    return { saved: saved, note: res.note };
  });
}

/**
 * 单轮（并行度为 1 时的路径，也用于「自动想一次」）：算完直接落库。
 * 保留这个入口是因为它足够常用，而且比走任务队列少一层跳转。
 */
async function runRound() {
  const res = await computeDraft(0, null);
  const out = await commitDraft(res, null);
  return out.saved;
}

/** 浏览器通知（需用户授权，失败静默 —— 通知不是核心路径） */
function notify(p) {
  try {
    if (!S.settings || !S.settings.notify_enabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification("知更有一个提案", { body: p.title });
  } catch (e) { /* 通知失败不影响主流程 */ }
}

/** 反馈闭环：执行 / 跳过 → 记录 + 回流成一条新记忆 */
async function submitOutcome(proposal, outcome) {
  await Cloud.data.updateProposal(proposal.id, { outcome: outcome });
  await Cloud.data.insertFeedback({
    proposal_id: proposal.id, outcome: outcome, conversation_id: S.convId,
  });
  proposal.outcome = outcome;

  const text = '你对提案「' + AA.short(proposal.title, 26) + '」的决定：' +
               (outcome === 'done' ? '执行' : '跳过');
  const rows = await Cloud.data.insertMemories([{
    content: text, tier: 'normal', base_weight: 0.6, lock: false,
  }], S.convId);
  if (rows && rows[0]) S.memories.push(rows[0]);

  toast(outcome === 'done' ? '已记录：执行。这个选择会影响以后的提案。'
                           : '已记录：跳过。它会据此调整权重。',
        outcome === 'done' ? 'ok' : 'info');
}

/* ══ 7 · 页面渲染 ═════════════════════════════════════════════════════ */

/* 三项导航：今天 / 时间线 / 它在意的。
   「它在想」和「设置」不进导航 —— 前者是内部状态，不该占主屏；
   后者是低频操作，收在顶栏齿轮和移动端顶部按钮里。 */
const ROUTES = [
  { id: 'today',    label: '今天',     icon: 'radar',   nav: true },
  { id: 'chat',     label: '对话',     icon: 'chat',    nav: true },
  { id: 'timeline', label: '时间线',   icon: 'clock',   nav: true },
  { id: 'care',     label: '它在意的', icon: 'layers',  nav: true },
  { id: 'think',    label: '它在想',   icon: 'sparkle', nav: false },
  { id: 'settings', label: '设置',     icon: 'sliders', nav: false },
];

function renderNav() {
  const pending = S.proposals.filter(p => !p.outcome && p.touched).length;
  $('#nav').innerHTML = ROUTES.filter(r => r.nav).map(function (r) {
    const badge = (r.id === 'today' && pending)
      ? '<span class="nav-count">' + pending + '</span>'
      : (r.id === 'chat' && S.unreadChat ? '<span class="nav-dot"></span>' : '');
    return '<button class="nav-item" data-go="' + r.id + '"' +
           (S.route === r.id ? ' aria-current="page"' : '') + '>' +
           icon(r.icon, 17) + '<span>' + r.label + '</span>' + badge + '</button>';
  }).join('');

  $('#tabbar').innerHTML = ROUTES.filter(r => r.nav).map(function (r) {
    const badge = (r.id === 'chat' && S.unreadChat) ? '<span class="nav-dot"></span>' : '';
    return '<button class="tab" data-go="' + r.id + '"' +
           (S.route === r.id ? ' aria-current="page"' : '') + '>' +
           icon(r.icon, 20) + '<span>' + r.label + '</span>' + badge + '</button>';
  }).join('');
}

/* ── 新用户引导：只讲一件事 —— 写下第一件你在意的事。
   以前这页讲衰减公式，用户不关心公式，用户关心「我要干什么」。 ── */
function viewOnboarding() {
  return '' +
  '<div class="one">' +
    '<span class="kind kind-calm">' + icon('sparkle', 14) + '知更刚来</span>' +
    '<h2>先告诉它一件你在意的事</h2>' +
    '<p class="lede">它靠记忆工作：你写下在意的事，它每天掂量哪件最值得说。' +
      '写得不完美没关系 —— 之后随时能改，它也会自己变淡。</p>' +
    '<div class="act-row">' +
      '<button class="btn btn-gold btn-lg" data-act="add-first">' + icon('plus', 17) + '写第一件</button>' +
      '<button class="btn btn-quiet btn-lg" data-act="seed">先拿三条示例试试</button>' +
    '</div>' +
    '<div class="why">' + icon('info', 15) +
      '<span><b>记住</b> · 长期目标标「不会忘」；临时念头约七天就淡了。' +
      '不用登录也能用 —— 东西先存在这台设备上。</span></div>' +
  '</div>';
}

/* ── 今天：一件事占满屏面 ──────────────────────────────────────────── */
function viewToday() {
  const pending = S.proposals.filter(p => !p.outcome && p.touched)[0];
  const silent = S.proposals.filter(p => !p.outcome && !p.touched).slice(0, 5);
  const active = S.memories.filter(m => !m.archived);

  // 任务面板放最上面：并行跑起来之后，「现在在做什么」比任何内容都重要。
  let html = Tasks.panelHTML();

  if (pending) {
    const gated = !!(pending.reason && pending.reason.indexOf('闸门') >= 0);
    html +=
    '<article class="one">' +
      '<span class="kind kind-need">' + icon(gated ? 'shield' : 'bell', 14) + '我需要你</span>' +
      '<h2>' + esc(pending.title) + '</h2>' +
      (pending.body ? '<p class="proposal-body">' + esc(pending.body) + '</p>' : '') +
      (pending.action ? '<div class="step"><span class="step-l">建议这一步</span>' +
        '<span class="step-t">' + esc(pending.action) + '</span></div>' : '') +
      '<div class="act-row">' +
        '<button class="btn btn-gold btn-lg" data-act="done" data-id="' + pending.id + '">' +
          icon('check', 17) + '我做了</button>' +
        '<button class="btn btn-quiet btn-lg" data-act="skip" data-id="' + pending.id + '">今天不做</button>' +
      '</div>' +
      (pending.reason
        ? '<div class="why">' + icon('info', 15) +
          '<span><b>为什么是现在</b> · ' + esc(pending.reason) + '</span></div>'
        : '') +
    '</article>';
  } else {
    html +=
    '<div class="calm">' +
      '<div class="calm-ic">' + icon('radar', 26) + '</div>' +
      '<h2>此刻没有要打扰你的事</h2>' +
      '<p class="lede">规矩是够格的才出声。这不代表没事可做 —— ' +
        '可以让它往几个方向想一想，或者把新冒出来的念头记下来。</p>' +
      '<div class="act-row">' +
        '<button class="btn btn-quiet btn-lg" data-act="think">' + icon('zap', 17) + '让它想一次</button>' +
        '<button class="btn btn-ghost btn-lg" data-go="care">看看它在意的</button>' +
      '</div>' +
    '</div>';
  }

  /* 底账：一行，不是四张统计卡 */
  html +=
  '<div class="ledger">' +
    '<span>等你回应 <b>' + S.proposals.filter(p => !p.outcome && p.touched).length + '</b> 件</span>' +
    '<span class="sep">·</span>' +
    '<span>它在意 <b>' + active.length + '</b> 件事</span>' +
    '<span class="sep">·</span>' +
    '<span><b>' + active.filter(m => !m.lock).length + '</b> 件正在变淡</span>' +
  '</div>';

  /* 被按住的：收成一行，展开才看到「什么被压下去了」。
     「什么被静默了」本身是产品价值，但它不配抢今天的版面。 */
  if (silent.length) {
    html +=
    '<div class="muted-strip">' +
      '<button class="muted-head" onclick="var b=this.nextElementSibling;' +
        'b.hidden=!b.hidden;this.parentNode.classList.toggle(\'open\')">' +
        icon('bellOff', 16) +
        '<span>它按住了 ' + silent.length + ' 件，没打扰你</span>' +
        '<span class="chev">' + icon('chevronRight', 15) + '</span>' +
      '</button>' +
      '<div class="muted-body" hidden>' +
      silent.map(function (p) {
        return '<div class="mrow">' + icon('clock', 16) +
          '<span class="mrow-t">' + esc(p.title) +
            (p.reason ? '<span class="mrow-w" style="display:block;white-space:normal;margin-top:2px">' +
              esc(p.reason) + '</span>' : '') +
          '</span>' +
          '<button class="link" data-act="promote" data-id="' + p.id + '">仍然看它</button>' +
        '</div>';
      }).join('') +
      '</div>' +
    '</div>';
  }

  return html;
}

/* ── 它在意的：记忆，用人话 ────────────────────────────────────────── */
function careRow(m) {
  const at = new Date();
  const w = AA.effectiveWeight(m, at);
  const pct = Math.max(4, Math.min(100, Math.round(w * 100)));
  const fadeW = Math.round(20 + 54 * pct / 100);
  const ic = m.archived ? 'archive' : (m.lock ? 'lock' : 'clock');
  const d = m.created_at ? new Date(m.created_at) : null;
  const day = d && !isNaN(d) ? (d.getMonth() + 1) + '月' + d.getDate() + '日记下' : '';
  const left = m.lock || m.archived ? null : AA.daysUntilForgotten(m, at);

  let sub;
  if (m.lock) sub = '你标的，不会淡';
  else if (m.archived) sub = '自己沉下去了 · 没有删掉，随时能捞回来' + (m.dormant ? ' · 长眠' : '');
  else sub = '大概还能记 ' + (left === Infinity ? '很久' : Math.max(1, Math.round(left)) + ' 天');
  if (day) sub += ' · ' + day;

  return '<div class="mem' + (m.lock ? ' is-locked' : (m.archived ? '' : ' is-fading')) + '">' +
    icon(ic, 17) +
    '<div>' +
      '<div class="mem-x"' + (m.archived ? ' style="color:var(--ink-3)"' : '') + '>' + esc(m.content) + '</div>' +
      '<div class="mem-sub"><span class="fade' + (m.lock ? ' is-lock' : '') +
        '" style="width:' + fadeW + 'px"></span>' + esc(sub) + '</div>' +
    '</div>' +
    '<div class="mem-acts">' +
      '<button class="iconbtn" data-act="edit-mem" data-id="' + m.id + '" title="编辑这条">' +
        icon('edit', 15) + '</button>' +
      '<button class="iconbtn is-danger" data-act="del-mem" data-id="' + m.id + '" title="忘掉这条">' +
        icon('trash', 15) + '</button>' +
    '</div>' +
  '</div>';
}

function viewCare() {
  const items = S.memories.filter(m => !m.archived);
  const locked = items.filter(m => m.lock);
  const fading = items.filter(m => !m.lock);
  const cold = S.memories.filter(m => m.archived);

  if (!S.memories.length) {
    return '<div class="note">' + icon('info', 16) +
      '<span>这里会列出你告诉过它的事。<b>它们会自己变淡</b> —— ' +
      '先去写第一件，它才有东西可想。</span>' +
      '<span class="note-end"><button class="btn btn-quiet btn-sm" data-act="add-mem">' +
      icon('plus', 14) + '写一件</button></span></div>';
  }

  let html =
  '<div class="note">' + icon('info', 16) +
    '<span>这些是你告诉过它的事。<b>它们会自己变淡</b> —— ' +
    '不重要的沉下去，重要的标了「不会忘」。你随时能改。</span>' +
    '<span class="note-end"><button class="btn btn-quiet btn-sm" data-act="add-mem">' +
    icon('plus', 14) + '写一件</button></span></div>';

  if (locked.length) {
    html += '<div class="sec"><div class="sec-h">不会忘<span class="n">' + locked.length + '</span></div>' +
      locked.map(careRow).join('') + '</div>';
  }
  if (fading.length) {
    html += '<div class="sec"><div class="sec-h">还在，但在变淡<span class="n">' + fading.length + '</span></div>' +
      fading.map(careRow).join('') + '</div>';
  }
  if (cold.length) {
    html += '<div class="sec"><div class="sec-h">已经淡出<span class="n">' + cold.length + '</span></div>' +
      cold.map(careRow).join('') + '</div>';
  }

  return html;
}

/* ── 时间线：它说过的、你做过的事 ──────────────────────────────────── */
function tlRow(p) {
  const done = p.outcome === 'done', skip = p.outcome === 'skipped';
  let chip = '', dot = '', src;
  if (p.touched) {
    src = '我找你的';
    if (done) { chip = '<span class="chip chip-done">你做了</span>'; dot = ' is-done'; }
    else if (skip) { chip = '<span class="chip chip-mute">你跳过了</span>'; }
    else { chip = '<span class="chip chip-need">等你回应</span>'; dot = ' is-need'; }
  } else {
    src = '它按住了';
    chip = '<span class="chip chip-mute">没打扰你</span>';
  }
  return '<div class="ev' + dot + '">' +
    '<div class="ev-r"><span class="ev-t">' + esc(p.title) + '</span>' + chip + '</div>' +
    (p.body || p.reason ? '<div class="ev-x">' + esc(p.body || p.reason) + '</div>' : '') +
    '<div class="ev-m">' + esc(fmtTime(p.created_at)) + ' · ' + src + '</div>' +
  '</div>';
}

function viewTimeline() {
  const list = S.proposals.slice(0, 80);
  if (!list.length) {
    return '<div class="calm">' +
      '<div class="calm-ic">' + icon('clock', 26) + '</div>' +
      '<h2>还没有任何记录</h2>' +
      '<p class="lede">它每想一次，无论出声还是沉默，都会留在这里。</p>' +
      '<div class="act-row">' +
        '<button class="btn btn-quiet btn-lg" data-act="think">' + icon('zap', 17) + '让它想一次</button>' +
      '</div></div>';
  }

  const byDay = {};
  list.forEach(function (p) {
    const k = fmtDay(p.created_at);
    (byDay[k] = byDay[k] || []).push(p);
  });
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  const todayK = fmtDay(new Date().toISOString());
  const yK = fmtDay(new Date(Date.now() - 86400000).toISOString());

  return Object.keys(byDay).map(function (k) {
    const d = new Date(k + 'T00:00:00');
    const label = k === todayK ? '今天' : (k === yK ? '昨天' : (d.getMonth() + 1) + '月' + d.getDate() + '日');
    const sub = '周' + wd[d.getDay()];
    return '<div class="day"><div class="day-h"><span class="d">' + label + '</span><span>' + sub + '</span></div>' +
      '<div class="tl">' + byDay[k].map(tlRow).join('') + '</div></div>';
  }).join('');
}

/* ── 它在想：内部状态只在这里，平时不占你的屏 ──────────────────────── */
function viewThink() {
  const spoken = S.proposals.filter(p => p.touched)[0];
  const silent = S.proposals.filter(p => !p.touched).slice(0, 8);

  let html = '<div class="think">' +
    '<div class="think-head"><div>' +
      '<div class="t">它在想什么</div>' +
      '<div class="s">它只打扰你一次 —— 所以它必须挑。</div>' +
    '</div></div>' +
    Tasks.launcherHTML(S.thinkN);

  if (spoken) {
    html += '<div class="sec"><div class="sec-h">今天说了这一件<span class="n">1</span></div>' +
      '<div class="cand">' +
        '<span class="cand-t" style="color:var(--ink)">' + esc(spoken.title) + '</span>' +
        '<span class="cand-tag">已占用<br>今天的额度</span>' +
        '<span class="cand-why">' + esc(spoken.reason || '') + '</span>' +
      '</div></div>';
  }

  if (silent.length) {
    html += '<div class="sec"><div class="sec-h">它考虑过，但没说<span class="n">' + silent.length + '</span></div>' +
      silent.map(function (p) {
        return '<div class="cand">' +
          '<span class="cand-t">' + esc(p.title) + '</span>' +
          '<span class="cand-tag">被按住</span>' +
          '<span class="cand-why">' + esc(p.reason || '没到该说的时候，先保持安静。') + '</span>' +
        '</div>';
      }).join('') + '</div>';
  }

  if (!spoken && !silent.length) {
    html += '<div class="sec"><div class="sec-h">还没想过</div>' +
      '<div class="cand"><span class="cand-why">让它想一次，你会看到它在往哪几个方向想、' +
      '为什么只挑了这一件说。</span></div></div>';
  }

  html += '<div class="note">' + icon('shield', 16) +
    '<span>涉及钱、或者任何对外的动作，它<b>永远只提案、不执行</b>，' +
    '而且必须等你明确点头。这一条在代码里是硬闸门，不是设置项。</span></div>' +
  '</div>';

  return html;
}

/* ── 设置 ──────────────────────────────────────────────────────────── */
function versionCell(k, v) {
  return '<div class="ver-cell"><div class="k">' + esc(k) + '</div>' +
         '<div class="v">' + esc(v) + '</div></div>';
}

function viewSettings() {
  const st = S.settings || {};
  const email = (S.user && S.user.email) || '—';
  const sync = Sync.state();

  // .settings 限制整页宽度。设置项是「标签—控件」的横向关系，
  // 拉到全宽会让标签和数值隔着一整个屏幕对望。
  const prof = S.profile || {};
  const emailHint = prof.email
    ? (prof.verified
        ? '✅ 已验证。每晚它会写一封信到这里 —— 应用没开也会发。'
        : '⚠️ 还没验证：点「验证」，去邮箱收 6 位验证码。')
    : '把邮箱告诉它并验证后，知更想到什么会主动写到这里来 —— 睡前一封，应用没开也会发。';
  return '<div class="settings">' +

  /* ── 关于你：个性化的根。它得知道在跟谁说话、怎么称呼、通过什么联系你。 ── */
  '<section class="section">' +
    '<div class="section-head"><h2>关于你</h2>' +
      '<span class="muted">它知道你是谁，才谈得上主动</span></div>' +
    '<div class="card stack">' +
      '<div class="field">' +
        '<label class="label" for="p-name">称呼</label>' +
        '<input class="input" id="p-name" spellcheck="false" placeholder="它怎么叫你"' +
          ' value="' + esc(prof.name || '') + '">' +
      '</div>' +
      '<div class="field">' +
        '<label class="label" for="p-about">自我介绍</label>' +
        '<textarea class="input" id="p-about" rows="2"' +
          ' placeholder="一句话：你是谁、最近在忙什么">' +
          esc(prof.about || '') + '</textarea>' +
        '<p class="hint">这些会进入它的记忆，聊天和来信时自然用上 —— 它更懂你，而不是每次从零开始。</p>' +
      '</div>' +
      '<div class="field">' +
        '<label class="label" for="p-email">邮箱 · 它主动联系你的通道</label>' +
        '<div class="row" style="gap:8px">' +
          '<input class="input" id="p-email" style="flex:1" spellcheck="false"' +
            ' placeholder="you@example.com" value="' + esc(prof.email || '') + '">' +
          '<button class="btn btn-quiet btn-sm" data-act="profile-verify">' +
            (prof.verified ? '重新验证' : '验证') + '</button>' +
        '</div>' +
        '<p class="hint" id="p-email-hint">' + emailHint + '</p>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end;gap:8px">' +
        '<button class="btn btn-ghost btn-sm" data-act="profile-testmail">让它现在给我写一封</button>' +
        '<button class="btn btn-primary btn-sm" data-act="profile-save">保存档案</button>' +
      '</div>' +
    '</div>' +
  '</section>' +

  '<section class="section">' +
      '<div class="section-head"><h2>' + (Cloud.isCloud() ? '账户' : '存储') + '</h2></div>' +
    (Cloud.isCloud() ?
    '<div class="card">' +
      '<div class="row-between">' +
        '<div class="row" style="gap:var(--s-3)">' +
          '<span class="who-avatar">' + esc(email.slice(0, 1)) + '</span>' +
          '<div><div style="font-weight:var(--fw-sb)">' + esc(email) + '</div>' +
          '<div class="muted" style="font-size:var(--fs-sm)">已登录 · 数据按此身份隔离</div></div>' +
        '</div>' +
        '<button class="btn btn-quiet btn-sm" data-act="change-pwd">修改密码</button>' +
      '</div>' +
    '</div>' :

    /* 本地模式：这里是「存储」，不是「账户」。
       没登录却展示假账户区块（还带「修改密码」）是骗人的。 */
    '<div class="card">' +
      '<div class="row-between">' +
        '<div class="row" style="gap:var(--s-3)">' +
          '<span class="who-avatar">本</span>' +
          '<div><div style="font-weight:var(--fw-sb)">本机存储</div>' +
          '<div class="muted" style="font-size:var(--fs-sm)">' +
            '数据存在这台设备的浏览器里，打开即用。</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<p class="hint">换设备、换浏览器、或清理浏览器数据会让这些记忆消失。</p>' +
    '</div>') +
  '</section>' +

  '<section class="section">' +
    '<div class="section-head"><h2>出声的规矩</h2></div>' +
    '<div class="card stack">' +
      '<div>' +
        '<div class="row-between" style="margin-bottom:var(--s-2)">' +
          '<label class="label" for="s-line">开口的门槛</label>' +
          '<span class="num" id="s-line-val">' + Number(st.touch_line == null ? 38 : st.touch_line) + '</span>' +
        '</div>' +
        '<input class="range" id="s-line" type="range" min="10" max="80" step="1"' +
          ' value="' + Number(st.touch_line == null ? 38 : st.touch_line) + '">' +
        '<p class="hint">分数低于这条线它就保持安静。<b>调大 = 更安静，调小 = 更主动。</b>' +
          '默认值是实测校准的：再高会漏掉真正相关的事，再低噪音会明显变多。</p>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="row-between">' +
        '<div><div style="font-weight:var(--fw-m)">系统通知</div>' +
        '<div class="hint">它开口时发一条桌面通知（需浏览器授权）。</div></div>' +
        '<button class="switch" id="s-notify" role="switch" aria-checked="' +
          (st.notify_enabled === false ? 'false' : 'true') + '"></button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div>' +
        '<label class="label" for="s-kw">我关注的关键词</label>' +
        '<textarea class="input" id="s-kw" rows="3"' +
          ' placeholder="用逗号或空格分隔，例如：项目A, 体检, 房贷">' +
          esc(st.custom_keywords || '') + '</textarea>' +
        '<p class="hint">填上具体的人名、项目名、持仓名 —— 它判断「这件事跟你有关」时靠它。留空则只用通用词表。</p>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end">' +
        '<button class="btn btn-primary" data-act="save-settings">保存设置</button>' +
      '</div>' +
    '</div>' +
  '</section>' +

  '<section class="section">' +
    '<div class="section-head"><h2>思考与数据</h2>' +
      '<span class="muted">当前话题「' + esc(Convos.label(Convos.current())) + '」：' +
        S.memories.length + ' 条记忆 · ' + S.proposals.length + ' 条提案</span>' +
    '</div>' +
    '<div class="card stack">' +
      '<div class="row-between">' +
        '<div><div style="font-weight:var(--fw-m)">并行度</div>' +
        '<div class="hint">一次让它同时往几个方向想。计算并行，落库串行，结果不会互相覆盖。</div></div>' +
        '<div class="seg seg-sm">' +
          [1, 3, 5].map(function (v) {
            return '<button class="seg-btn" data-think-n="' + v + '" aria-selected="' +
              (Number(S.thinkN) === v) + '">' + v + ' 路</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="row-between">' +
        '<div><div style="font-weight:var(--fw-m)">用大模型润色提案文案</div>' +
        '<div class="hint">默认用模板文案（确定性生成）。打开后正文交给大模型重写' +
          '（失败会自动退回模板，不会丢提案）。接入了自选模型时优先用自选的。</div></div>' +
        '<button class="switch" id="s-llm" role="switch" aria-checked="' +
          (S.useLlm ? 'true' : 'false') + '"></button>' +
      '</div>' +
      /* ── 接入自己的大模型（OpenAI 兼容） ── */
      '<div class="divider"></div>' +
      '<div id="llm-config">' +
        '<div style="font-weight:var(--fw-m)">接入自己的大模型</div>' +
        '<div class="hint">像 OpenClaw 接第三方 API 一样：填你的 API Key，' +
          '润色就改用你选的模型。Key 只存在你的账号数据里，别人读不到。</div>' +
        '<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">' +
          Object.keys(LLM_PRESETS).map(function (k) {
            const cur = readLlmPref();
            const on = cur && cur.provider === k;
            return '<button class="seg-btn" data-llm-preset="' + k + '" aria-selected="' + on + '">' +
              esc(LLM_PRESETS[k].label) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="field" style="margin-top:10px">' +
          '<label class="label" for="s-llm-url">接口地址（base_url）</label>' +
          '<input class="input" id="s-llm-url" spellcheck="false"' +
            ' placeholder="https://api.deepseek.com"' +
            ' value="' + esc((readLlmPref() || {}).baseUrl || '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label class="label" for="s-llm-model">模型名</label>' +
          '<input class="input" id="s-llm-model" spellcheck="false" placeholder="deepseek-chat"' +
            ' value="' + esc((readLlmPref() || {}).model || '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label class="label" for="s-llm-key">API Key</label>' +
          '<input class="input" id="s-llm-key" type="password" spellcheck="false"' +
            ' autocomplete="off" placeholder="' +
            (readLlmPref() ? '已保存，重填可覆盖' : 'sk-…（保存后不回显明文）') + '">' +
        '</div>' +
        '<p class="hint" id="s-llm-hint">选一个供应商，会自动填地址和模型名；再贴上你的 Key。' +
          '也可以选「自定义」填任意 OpenAI 兼容端点。</p>' +
        '<div class="row" style="gap:8px">' +
          '<button class="btn btn-primary btn-sm" data-act="llm-save">保存并测试</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="llm-clear">停用自接入</button>' +
          '<span class="hint" id="s-llm-status"></span>' +
        '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="row-between">' +
        '<div><div style="font-weight:var(--fw-m)">立即结算一次</div>' +
        '<div class="hint">按当前时间重新计算所有记忆的衰减，把已淡出的归档、被新信号命中的捞回。</div></div>' +
        '<button class="btn btn-quiet btn-sm" data-act="settle">结算</button>' +
      '</div>' +
    '</div>' +
  '</section>' +

  '<section class="section">' +
    '<div class="section-head"><h2>同步与版本</h2>' +
      '<span class="muted">软件层面的实时状态</span></div>' +
    '<div class="card stack">' +
      '<div class="ver-grid">' +
        versionCell('实时同步', sync.running ? '进行中' : '已停止') +
        versionCell('变更版本号', sync.revision == null ? '—' : String(sync.revision)) +
        versionCell('最近同步', sync.lastAt ? ago(sync.lastAt) : '尚未同步') +
        versionCell('本机来源', sync.device || '—') +
        versionCell('当前构建', S.version.build || '—') +
        versionCell('上次检查更新', S.version.lastCheck ? ago(S.version.lastCheck) : '—') +
      '</div>' +
      (sync.lastError
        ? '<p class="hint" style="color:var(--warn)">同步提示：' + esc(sync.lastError) + '</p>'
        : '') +
      '<div class="divider"></div>' +
      '<div class="row-between">' +
        '<div><div style="font-weight:var(--fw-m)">版本更新</div>' +
        '<div class="hint">页面每 60 秒比对一次构建指纹，发现新版本且界面空闲时自动刷新 —— ' +
          '桌面应用加载的就是这个线上版本，所以它永远是最新的。</div></div>' +
        '<button class="btn btn-quiet btn-sm" data-act="check-version">检查更新</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="row-between">' +
        '<div><div style="font-weight:var(--fw-m)">立即同步一次</div>' +
        '<div class="hint">主动拉取其他设备或标签页的改动。页面重新可见时会自动做一次。</div></div>' +
        '<button class="btn btn-quiet btn-sm" data-act="sync-now">立即同步</button>' +
      '</div>' +
    '</div>' +
  '</section>' +

  '<section class="section">' +
    '<div class="section-head"><h2>关于</h2></div>' +
    '<div class="card">' +
      '<p class="muted" style="font-size:var(--fs-sm);line-height:var(--lh-body)">' +
        '知更。它不回答你的问题，它替你想该做什么。<br>' +
        '它怎么决定说不说：' +
        '<span class="num">0.30·紧迫 + 0.25·相关 + 0.20·新颖 + 0.15·可执行 − 0.10·风险</span>，' +
        '记忆按 <span class="num">base × e^(−λ·Δt)</span> 自然衰减。<br>' +
        '涉及钱或对外动作的提案由风险闸门强制触达，永远要你亲自确认。' +
      '</p>' +
    '</div>' +
  '</section>' +
  '</div>';
}

/* ══ 8 · 路由 ═════════════════════════════════════════════════════════ */

/* ══ 对话：跟它直接聊 ══════════════════════════════════════════════════
   登录下线后知更的第一个「正面能力」：用户说一句，它答一句。
   走同源 /api/llm 中继 —— key 在服务端（llm.default.json）或用户自己
   在设置里填的（readLlmPref），浏览器永不明文保存服务端密钥。
   对话记录只存本机 localStorage（最近 100 条），不参与记忆系统。 */

const CHAT_KEY = 'aa.chat.v1';
const CHAT_SYSTEM_BASE =
  '你是知更，一个替用户想该做什么的助手。现在用户直接跟你对话。\n' +
  '你不是客服，也不敷衍。像熟人那样接话：\n' +
  '- 有自己的判断。用户问该做什么，给一个明确的建议，不罗列一堆选项。\n' +
  '- 接得住情绪和上下文，该追问就追问，别每句都自说自话。\n' +
  '- 偶尔带出用户自己没注意到的角度。\n' +
  '说话克制、具体，不用 markdown，不堆形容词，不用敬语。中文回答。';

/** 组装知更的「自我 + 对眼前这一刻的感知」：时间、称呼、档案、在意的事、上次聊到哪。 */
function chatSystem() {
  const p = S.profile || {};
  const now = new Date();
  const wk = '日一二三四五六'[now.getDay()];
  const hh = now.getHours();
  const period = hh < 5 ? '深夜' : hh < 9 ? '清晨' : hh < 12 ? '上午'
    : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜';
  let s = CHAT_SYSTEM_BASE;
  s += '\n\n现在是 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() +
    ' 日 星期' + wk + ' ' + period + ' ' + hh + ':' +
    String(now.getMinutes()).padStart(2, '0') +
    '。时间感要融进语气里（深夜就低声一点），不要刻意报时。';
  if (p.name) s += '\n用户的称呼是「' + p.name + '」，自然地用，别每句都挂。';
  if (p.about) s += '\n用户的自我介绍：' + p.about;
  const list = chatLog();
  let lastUserTs = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user' && list[i].t) { lastUserTs = list[i].t; break; }
  }
  if (lastUserTs) {
    const gapH = (Date.now() - lastUserTs) / 3600000;
    if (gapH >= 1) {
      const g = gapH >= 24 ? Math.round(gapH / 24) + ' 天' : Math.round(gapH) + ' 个小时';
      s += '\n距离上次说话已经过去约 ' + g + '。重新接上时要体现你记得聊到哪，别装作刚认识。';
    }
  }
  const mem = S.memories.filter(m => !m.archived).slice(0, 8)
    .map(m => '- ' + m.content).join('\n');
  if (mem) s += '\n\n你记着的、用户在意的事（聊到相关话题时自然提起）：\n' + mem;
  return s;
}

function chatLog() {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY) || '[]') || []; }
  catch (e) { return []; }
}

function chatSave(list) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(list.slice(-100))); } catch (e) {}
}

function viewChat() {
  const list = chatLog();
  let msgs;
  if (!list.length) {
    msgs = '<div class="chat-empty">' + icon('chat', 30) +
      '<p>跟它聊点什么。比如：我今天该先做什么？</p></div>';
  } else {
    msgs = list.map(function (m, i) {
      const mark = m.proactive
        ? '<div class="chat-mark">' + icon('sparkle', 12) + '它先开口</div>' : '';
      const rem = (m.role === 'user' && !m.mem)
        ? '<button class="link chat-rem" data-act="chat-remember" data-i="' + i + '">' +
          '记进它在意的</button>' : '';
      return '<div class="chat-row ' + (m.role === 'user' ? 'me' : 'ai') + '">' + mark +
        '<div class="chat-bubble">' + esc(m.content).replace(/\n/g, '<br>') +
        (rem ? '<span class="chat-rem-row">' + rem + '</span>' : '') + '</div></div>';
    }).join('');
  }
  if (S.chatBusy) {
    msgs += '<div class="chat-row ai"><div class="chat-bubble chat-typing">它在想…</div></div>';
  }
  return '' +
  '<div class="chat-wrap">' +
    '<div class="chat-msgs" id="chat-msgs">' + msgs + '</div>' +
    '<div class="chat-input-row">' +
      '<textarea class="input chat-input" id="chat-input" rows="2" ' +
        'placeholder="说点什么…（Enter 发送）"></textarea>' +
      '<button class="btn btn-gold" data-act="chat-send"' + (S.chatBusy ? ' disabled' : '') + '>' +
        icon('zap', 16) + '发送</button>' +
    '</div>' +
    (list.length
      ? '<div class="chat-foot"><button class="link" data-act="chat-clear">清空对话</button></div>'
      : '') +
  '</div>';
}

async function chatSend() {
  if (S.chatBusy) return;
  const inp = $('#chat-input');
  const text = (inp && inp.value || '').trim();
  if (!text) return;
  const list = chatLog();
  list.push({ role: 'user', content: text, t: Date.now() });
  chatSave(list);
  S.chatBusy = true;
  render();
  try {
    const reply = await chatComplete(list);
    list.push({ role: 'assistant', content: reply, t: Date.now() });
    chatSave(list);
  } catch (e) {
    toast(e && e.message ? e.message : '发送失败，请重试。', 'err');
  } finally {
    S.chatBusy = false;
    render();
    const i2 = $('#chat-input');
    if (i2) i2.focus();
  }
}

/** 组装上下文（带它「在意的」几条）并打给中继。cfg 为空 → 服务端默认模型。 */
async function chatComplete(list) {
  const cfg = readLlmPref();
  const sys = chatSystem();
  const msgs = [{ role: 'system', content: sys }]
    .concat(list.map(m => ({ role: m.role, content: m.content })));
  const body = cfg
    ? { base_url: cfg.baseUrl, api_key: cfg.apiKey, model: cfg.model, messages: msgs }
    : { messages: msgs };
  const r = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON 响应按错误处理 */ }
  if (!r.ok) throw new Error((j && j.error) || ('请求失败（' + r.status + '）'));
  const txt = j && j.choices && j.choices[0] && j.choices[0].message &&
              j.choices[0].message.content;
  if (!txt) throw new Error('模型没有返回内容');
  return String(txt).trim();
}

/* ── 主动开口 ──────────────────────────────────────────────────────────
   「主动」是知更的本分，不是彩蛋：隔了一阵没聊、或今天第一次露面，
   它先说第一句。节流三重保险：两次主动至少隔 4 小时、一天最多 2 次、
   距上一次任何对话至少 4 小时。你不在对话页 → 顶栏角标 + 桌面通知。 */

const PROACTIVE_KEY = 'aa.proactive.v1';
const PROACTIVE_MIN_GAP = 4 * 3600e3;    // 两次主动开口的最小间隔
const PROACTIVE_TALK_GAP = 4 * 3600e3;   // 距上次任何对话的最小间隔
const PROACTIVE_MAX_PER_DAY = 2;

function proactiveState() {
  try { return JSON.parse(localStorage.getItem(PROACTIVE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function proactiveSave(st) {
  try { localStorage.setItem(PROACTIVE_KEY, JSON.stringify(st)); } catch (e) {}
}

function chatLastTs() {
  const l = chatLog();
  for (let i = l.length - 1; i >= 0; i--) if (l[i].t) return l[i].t;
  return 0;
}

async function maybeProactive(force) {
  if (!S.booted || S.chatBusy || S.proactiveBusy) return;
  const st = proactiveState();
  const now = Date.now();
  const today = new Date().toDateString();
  if (st.day !== today) { st.day = today; st.count = 0; }
  if (!force) {
    if ((st.count || 0) >= PROACTIVE_MAX_PER_DAY) return;
    if (st.lastAt && now - st.lastAt < PROACTIVE_MIN_GAP) return;
    const lastTalk = chatLastTs();
    if (lastTalk && now - lastTalk < PROACTIVE_TALK_GAP) return;
    if (S.bootedAt && now - S.bootedAt < 30e3) return;   // 刚进应用，先让人喘口气
  }
  S.proactiveBusy = true;
  try {
    const txt = await proactiveCompose();
    if (!txt) return;
    const list = chatLog();
    list.push({ role: 'assistant', content: txt, t: now, proactive: true });
    chatSave(list);
    st.lastAt = now; st.count = (st.count || 0) + 1;
    proactiveSave(st);
    if (S.route === 'chat') {
      render();
    } else {
      S.unreadChat = (S.unreadChat || 0) + 1;
      renderNav();
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('知更来找你了', { body: txt.slice(0, 90) }); } catch (e) {}
      }
    }
  } catch (e) { /* 主动开口失败不影响主流程 */ }
  finally { S.proactiveBusy = false; }
}

async function proactiveCompose() {
  const sys = chatSystem() +
    '\n\n现在的情况：你有一阵子没跟用户说话了，你来主动开一次口。' +
    '一到两句话，像熟人随口搭话——从时间、你在意的事、或上次的话题接下去，' +
    '或者问他最近怎么样。禁止「有什么可以帮你的吗」这类客服话术。直接输出要说的话。';
  const recent = chatLog().slice(-4)
    .map(m => (m.role === 'user' ? '用户：' : '知更：') + String(m.content).slice(0, 60));
  const msgs = [{ role: 'system', content: sys }];
  if (recent.length) {
    msgs.push({ role: 'user',
      content: '（最近聊过的片段，供你参考，不必逐条回应）\n' + recent.join('\n') });
  }
  try {
    const cfg = readLlmPref();
    const body = cfg
      ? { base_url: cfg.baseUrl, api_key: cfg.apiKey, model: cfg.model, messages: msgs }
      : { messages: msgs };
    const r = await fetch('/api/llm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const txt = j && j.choices && j.choices[0] && j.choices[0].message &&
                j.choices[0].message.content;
    if (r.ok && txt) return String(txt).trim().slice(0, 300);
  } catch (e) { /* 落到模板兜底 */ }
  // 兜底：没有模型也保证主动开口能落地
  const m = S.memories.filter(x => !x.archived)[0];
  const gap = chatLastTs() ? (Date.now() - chatLastTs()) / 3600000 : 0;
  const gtxt = gap >= 24 ? Math.round(gap / 24) + ' 天'
    : Math.max(1, Math.round(gap)) + ' 个小时';
  return m
    ? ('有一阵子没聊了——' + gtxt + '。你记的那句「' + String(m.content).slice(0, 24) +
       '」，最近有进展吗？')
    : ('又见面了。隔了' + gtxt + '，最近怎么样？');
}

const TITLES = {
  today:    { t: '今天',     s: '只有一件需要你动手' },
  chat:     { t: '对话',     s: '跟它直接聊' },
  timeline: { t: '时间线',   s: '它说过的、你做过的事' },
  care:     { t: '它在意的', s: '会自己变淡' },
  think:    { t: '它在想',   s: '内部状态，平时不占你的屏' },
  settings: { t: '设置',     s: '' },
};

function go(route) {
  /* 旧路由名兼容：记忆库→它在意的，触达历史→时间线 */
  if (route === 'memory') route = 'care';
  if (route === 'history') route = 'timeline';
  S.route = ROUTES.some(r => r.id === route) ? route : 'today';
  if (S.route === 'chat') { S.unreadChat = 0; }
  render();
  const c = $('#content');
  if (c) c.scrollTop = 0;
  window.scrollTo(0, 0);
}

/** 侧栏底部的同步状态。同步是隐形功能，不给指示就等于「不响的警报」。 */
function renderSyncLine() {
  const el = $('#sync-line');
  if (!el) return;
  const s = Sync.state();
  let cls = 'sync-line', text;

  if (s.localOnly) {
    /* 本地模式必须**如实**说清两件事：数据在哪、能同步到哪。
       BroadcastChannel 仍然在跑，同浏览器的多标签页之间是一致的。 */
    cls += ' is-local';
    text = '本地模式 · 仅本机，多标签页同步';
  } else if (!s.running) {
    cls += ' is-idle';
    text = '同步未启动';
  } else if (s.lastError) {
    cls += ' is-warn';
    text = '同步异常：' + s.lastError;
  } else {
    cls += ' is-live';
    text = s.lastAt ? ('已同步 · ' + ago(s.lastAt)) : '正在建立同步…';
  }
  el.className = cls;
  el.innerHTML = '<span class="dot"></span><span>' + esc(text) + '</span>';
}

function render() {
  if (!S.booted) return;
  const meta = TITLES[S.route] || TITLES.today;
  $('#page-title').textContent = meta.t;

  let sub = meta.s;
  if (S.route === 'today') {
    const p = S.proposals.filter(x => !x.outcome && x.touched)[0];
    sub = p ? '有一件事等你回应' : '此刻没有需要打断你的事';
  }
  $('#page-sub').textContent = sub;

  /* 顶栏右侧：它在想 + 设置齿轮。两个固定入口，不跟内容抢注意力。 */
  $('#topbar-actions').innerHTML =
    '<button class="btn btn-ghost btn-sm" data-go="think" title="它在想什么">' +
      icon('sparkle', 15) + '<span class="hide-mobile">它在想</span></button>' +
    '<button class="iconbtn" data-go="settings" title="设置">' + icon('sliders', 17) + '</button>';

  // 话题：桌面走侧栏列表，移动端走顶栏切换按钮（侧栏在窄屏是隐藏的）
  const host = $('#conv-host');
  if (host) host.innerHTML = Convos.sidebarHTML();
  const swHost = $('#conv-switch-host');
  if (swHost) swHost.innerHTML = Convos.switchButtonHTML();

  renderNav();
  renderSyncLine();

  const c = $('#content');
  /* 空状态引导只占「今天」这一页。
     别的页面有自己的空态，不该被引导页盖住 —— 否则导航看起来是坏的。 */
  const empty = !S.memories.length && !S.proposals.length;
  if (S.route === 'today') c.innerHTML = empty ? viewOnboarding() : viewToday();
  else if (S.route === 'chat') {
    c.innerHTML = viewChat();
    const cm = $('#chat-msgs');
    if (cm) cm.scrollTop = cm.scrollHeight;
  }
  else if (S.route === 'timeline') c.innerHTML = viewTimeline();
  else if (S.route === 'care') c.innerHTML = viewCare();
  else if (S.route === 'think') c.innerHTML = viewThink();
  else c.innerHTML = viewSettings();

  injectIcons(c);
  injectIcons(document);
}

/* ══ 9 · 交互绑定 ═════════════════════════════════════════════════════ */

async function withBusy(fn) {
  if (S.busy) return;
  S.busy = true;
  try { await fn(); }
  catch (e) {
    if (Cloud.isAuthError(e)) { await afterSignOut('登录已过期，请重新登录。'); }
    else toast(Cloud.humanize(e), 'err');
  }
  finally { S.busy = false; }
}

function bindApp() {
  // 导航（侧栏 + 标签栏）
  document.addEventListener('click', function (e) {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
  });

  // 对话页：发送 / 清空
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="chat-send"]')) { chatSend(); return; }
    const cl = e.target.closest('[data-act="chat-clear"]');
    if (cl) {
      chatSave([]);
      render();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatSend();
    }
  });

  // 回到前台时看一眼：是不是到它主动开口的时候了
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) maybeProactive(false);
  });

  // 对话相关动作：侧栏与顶栏都在 #content 之外，走 document 级委托
  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-act]');
    if (!t || t.closest('#content')) return;
    const act = t.dataset.act;
    if (act === 'conv-new') return withBusy(newConversation);
    if (act === 'conv-switch') {
      // 选择器是个弹窗，先关掉它（走 Esc 路径，让 modal 自己清理监听）
      closeModal();
      return withBusy(async () => { await Convos.switchTo(t.dataset.id); });
    }
    if (act === 'conv-menu') return openConvMenu(t.dataset.id);
    if (act === 'conv-picker') return openConvPicker();
  });

  // 内容区动作
  delegate($('#content'), 'click', function (e, t) {
    const act = t.dataset.act;
    if (act === 'think')   return withBusy(() => runThinkBatch(S.thinkN));

    if (act === 'settle') {
      return withBusy(async () => {
        const r = await settle();
        await Sync.bump('settle');
        render();
        toast('结算完成：归档 ' + r.archived.length + ' 条，捞回 ' + r.rescued.length + ' 条。', 'ok');
      });
    }

    if (act === 'task-clear')  { Tasks.clearFinished(); render(); return withBusy(async () => {}); }
    if (act === 'task-cancel') { Tasks.cancel(Number(t.dataset.id)); return; }

    if (act === 'check-version') return withBusy(() => checkVersion(true));

    if (act === 'sync-now') {
      return withBusy(async () => {
        await loadConversationData();
        await Convos.load();
        await Sync.poll(true);      // 对齐版本号，免得刚同步完又被判成「有远端变化」
        render();
        toast('已拉取最新数据。', 'ok');
      });
    }

    if (act === 'done' || act === 'skip') {
      const p = S.proposals.filter(x => String(x.id) === String(t.dataset.id))[0];
      if (!p) return;
      return withBusy(async () => {
        await submitOutcome(p, act === 'done' ? 'done' : 'skipped');
        await Sync.bump('outcome');
        render();
      });
    }

    if (act === 'promote') {
      const p = S.proposals.filter(x => String(x.id) === String(t.dataset.id))[0];
      if (!p) return;
      return withBusy(async () => {
        await Cloud.data.updateProposal(p.id, { touched: true });
        p.touched = true;
        await Sync.bump('promote');
        go('today');
      });
    }

    if (act === 'seed') {
      return withBusy(async () => {
        await ensureSettings();
        const rows = await Cloud.data.insertMemories(AA.STARTER_MEMORIES, S.convId);
        (rows || []).forEach(r => S.memories.push(r));
        await Convos.maybeAutoTitle('起步记忆');
        await Sync.bump('seed');
        render();
        toast('已载入 3 条起步记忆，点右侧按钮改成你自己的。', 'ok');
      });
    }

    if (act === 'add-first' || act === 'add-mem') {
      return openMemoryEditor(null);
    }

    if (act === 'edit-mem') {
      const m = S.memories.filter(x => String(x.id) === String(t.dataset.id))[0];
      return openMemoryEditor(m || null);
    }

    if (act === 'del-mem') {
      const m = S.memories.filter(x => String(x.id) === String(t.dataset.id))[0];
      if (!m) return;
      return modal({
        title: '删除这条记忆？',
        sub: '删除不可恢复。如果你只是不想再看到它，其实什么都不用做 —— 它会按时间自己衰减进冷库。',
        body: '<div class="card" style="background:var(--bg-elev-2);font-size:var(--fs-sm)">' + esc(m.content) + '</div>',
        actions: [
          { label: '保留', value: null, kind: 'btn-ghost' },
          { label: '确认删除', value: 'del', kind: 'btn-danger' },
        ],
      }).then(function (v) {
        if (v !== 'del') return;
        return withBusy(async () => {
          await Cloud.data.deleteMemory(m.id);
          S.memories = S.memories.filter(x => String(x.id) !== String(m.id));
          await Sync.bump('del-mem');
          render();
          toast('已删除。', 'ok');
        });
      });
    }

    if (act === 'save-settings') {
      const line = Number($('#s-line').value);
      const notifyOn = $('#s-notify').getAttribute('aria-checked') === 'true';
      const kw = $('#s-kw').value.trim();
      return withBusy(async () => {
        await ensureSettings();
        S.settings = await Cloud.data.saveSettings({
          touch_line: line, notify_enabled: notifyOn, custom_keywords: kw,
        });
        S.cfg = buildCfg();
        await Sync.bump('settings');
        render();
        toast('设置已保存。', 'ok');
      });
    }

    if (act === 'change-pwd') {
      return openChangePassword();
    }

    /* ── 关于你：保存档案（顺带触发邮箱验证码） / 验证 / 立即来信 ── */
    if (act === 'profile-save' || act === 'profile-verify') {
      const name = $('#p-name').value.trim();
      const about = $('#p-about').value.trim();
      const email = $('#p-email').value.trim().toLowerCase();
      if (act === 'profile-verify' && !email) {
        return toast('先填一个邮箱。', 'err');
      }
      return withBusy(async () => {
        S.profile = Object.assign({}, S.profile, { name, about, email });
        try { localStorage.setItem('aa.profile.v1', JSON.stringify(S.profile)); } catch (e) {}
        let j = {};
        try {
          const r = await fetch('/api/owner', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, about, email: email || undefined }),
          });
          j = await r.json();
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        } catch (e) {
          toast('档案已存本机，但服务端没存上：' + e.message, 'err');
          return;
        }
        render();
        if (j.otp_id) {
          if (j.verify_sent) {
            toast('验证码已发到 ' + email + '，去收信。', 'ok');
            openOwnerVerify(j.otp_id);
          } else if (j.needs_smtp) {
            toast('服务端还没配发件邮箱（需 QQ 邮箱 SMTP 授权码），验证码暂时发不出。', 'err');
          } else {
            toast('验证码发送失败：' + (j.detail || '未知原因'), 'err');
          }
        } else if (act === 'profile-verify') {
          toast('这个邮箱已经验证过了。', 'info');
        } else {
          toast('档案已保存。它知道你是谁了。', 'ok');
        }
      });
    }

    if (act === 'profile-testmail') {
      return withBusy(async () => {
        let j;
        try {
          const r = await fetch('/api/owner/test-mail', { method: 'POST' });
          j = await r.json();
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        } catch (e) {
          return toast(e.message, 'err');
        }
        toast(j.message || '已发出。', 'ok');
      });
    }

    /* ── 对话里随手「记住」：把这句话写进它在意的 ── */
    if (act === 'chat-remember') {
      const list = chatLog();
      const m = list[Number(t.dataset.i)];
      if (!m || m.role !== 'user' || m.mem) return;
      return withBusy(async () => {
        const rows = await Cloud.data.insertMemories(
          [{ content: m.content, tier: 'normal', base_weight: 0.6, lock: false }],
          S.convId);
        (rows || []).forEach(r => S.memories.push(r));
        m.mem = true;
        chatSave(list);
        await Sync.bump('remember');
        render();
        toast('已记进「它在意的」。', 'ok');
      });
    }

    if (act === 'signin') {
      if (!S.cloudOk) {
        return toast('账号系统连不上，当前只能用本地模式。检查网络后刷新重试。', 'err');
      }
      return openAuth();
    }
  });

  // 并行度：内容区与设置页各有一处，统一处理
  $('#content').addEventListener('click', function (e) {
    const b = e.target.closest('[data-think-n]');
    if (!b) return;
    S.thinkN = Number(b.dataset.thinkN);
    rememberPref('aa.thinkN', String(S.thinkN));
    render();
  });

  // 自接入大模型：点供应商 → 自动填地址和模型名
  $('#content').addEventListener('click', function (e) {
    const p = e.target.closest('[data-llm-preset]');
    if (!p) return;
    const preset = LLM_PRESETS[p.dataset.llmPreset];
    if (!preset) return;
    if (preset.baseUrl && $('#s-llm-url')) $('#s-llm-url').value = preset.baseUrl;
    if (preset.model && $('#s-llm-model')) $('#s-llm-model').value = preset.model;
    const hint = $('#s-llm-hint');
    if (hint) hint.textContent = preset.label + '：' + preset.hint;
  });

  // 滑杆实时数值
  $('#content').addEventListener('input', function (e) {
    paintRange(e.target);
    if (e.target.id === 's-line') {
      const v = $('#s-line-val');
      if (v) v.textContent = e.target.value;
    }
  });

  // 开关
  $('#content').addEventListener('click', function (e) {
    const sw = e.target.closest('#s-notify');
    if (sw) {
      const on = sw.getAttribute('aria-checked') === 'true';
      sw.setAttribute('aria-checked', on ? 'false' : 'true');
      if (!on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(function () {});
      }
      return;
    }
    const llm = e.target.closest('#s-llm');
    if (llm) {
      S.useLlm = llm.getAttribute('aria-checked') !== 'true';
      llm.setAttribute('aria-checked', S.useLlm ? 'true' : 'false');
      rememberPref('aa.useLlm', S.useLlm ? '1' : '0');
      toast(S.useLlm ? '已开启：提案正文会交给大模型重写。' : '已关闭：使用确定性模板文案。', 'info');
    }
  });

  $('#btn-signout').onclick = function () {
    modal({
      title: '退出登录？',
      body: '<p class="hint">你的对话、记忆和提案都保存在账户里，下次登录还在。' +
            '退出后会回到本地模式，本机的数据不受影响。</p>',
      actions: [
        { label: '取消', value: null, kind: 'btn-ghost' },
        { label: '退出', value: 'out', kind: 'btn-danger' },
      ],
    }).then(function (v) {
      if (v !== 'out') return;
      withBusy(async () => {
        await Cloud.auth.signOut();
        await afterSignOut('已退出登录，现在是本地模式。');
      });
    });
  };

  /* 本地模式下的登录入口。点击后进登录页 —— 登录是**主动动作**，不是进门门槛。 */
  const signin = function () {
    if (!S.cloudOk) {
      toast('账号系统连不上，当前只能用本地模式。检查网络后刷新重试。', 'err');
      return;
    }
    openAuth();
  };
  if ($('#btn-signin')) $('#btn-signin').onclick = signin;
  if ($('#btn-back-app')) $('#btn-back-app').onclick = backToApp;

  // 本地模式横幅上的按钮（用委托，因为横幅会整块重绘）
  const bar = $('#local-bar');
  if (bar) {
    delegate(bar, 'click', function (e, el) {
      const act = el.getAttribute('data-act');
      if (act === 'signin') signin();
      else if (act === 'dismiss-bar') dismissLocalBar();
    });
  }
}

/* ── 记忆编辑器 ────────────────────────────────────────────────────── */
function openMemoryEditor(m) {
  const isNew = !m;
  const cur = m || { content: '', tier: 'normal', base_weight: 0.6, lock: false };

  const form = document.createElement('div');
  form.className = 'stack';
  form.innerHTML =
    '<div class="field">' +
      '<label class="label" for="m-text">内容</label>' +
      '<textarea class="input" id="m-text" rows="3" placeholder="用一句你能看懂的话写。越具体，它判断得越准。">' +
        esc(cur.content) + '</textarea>' +
    '</div>' +
    '<div class="field">' +
      '<label class="label">衰减档位</label>' +
      '<div class="seg" id="m-tier">' +
        ['locked', 'normal', 'volatile'].map(function (k) {
          return '<button class="seg-btn" data-tier="' + k + '" aria-selected="' +
            (cur.tier === k) + '">' + AA.TIER_META[k].label + '</button>';
        }).join('') +
      '</div>' +
      '<p class="hint" id="m-tier-desc">' + AA.TIER_META[cur.tier].desc + '</p>' +
    '</div>' +
    '<div class="field">' +
      '<label class="label" for="m-weight">基准权重 <span class="num" id="m-weight-val">' +
        Number(cur.base_weight).toFixed(2) + '</span></label>' +
      '<input class="range" id="m-weight" type="range" min="0.1" max="1" step="0.05" value="' +
        Number(cur.base_weight) + '">' +
      '<p class="hint">权重越高，衰减到遗忘线需要的天数越多。0.60 配合常规档位约 60 天。</p>' +
    '</div>';

  let tier = cur.tier;
  form.addEventListener('click', function (e) {
    const b = e.target.closest('[data-tier]');
    if (!b) return;
    tier = b.dataset.tier;
    $$('#m-tier .seg-btn', form).forEach(function (x) {
      x.setAttribute('aria-selected', String(x.dataset.tier === tier));
    });
    const d = $('#m-tier-desc', form);
    if (d) d.textContent = AA.TIER_META[tier].desc;
  });
  form.addEventListener('input', function (e) {
    paintRange(e.target);
    if (e.target.id === 'm-weight') {
      const v = $('#m-weight-val', form);
      if (v) v.textContent = Number(e.target.value).toFixed(2);
    }
  });

  return modal({
    title: isNew ? '添加记忆' : '编辑记忆',
    sub: isNew ? '它靠这条判断该在什么时候、为了什么打断你。' : null,
    body: form,
    actions: [
      { label: '取消', value: null, kind: 'btn-ghost' },
      { label: isNew ? '添加' : '保存', value: 'save', kind: 'btn-primary' },
    ],
  }).then(function (v) {
    if (v !== 'save') return;
    const text = $('#m-text', form).value.trim();
    const weight = Number($('#m-weight', form).value);
    if (!text) { toast('内容不能为空。', 'err'); return; }

    return withBusy(async () => {
      const patch = { content: text, tier: tier, base_weight: weight, lock: tier === 'locked' };
      if (isNew) {
        const rows = await Cloud.data.insertMemories([patch], S.convId);
        if (rows && rows[0]) S.memories.push(rows[0]);
        await ensureSettings();
        // 新建对话的第一条记忆 → 顺手把它命名了，省掉一次起名动作
        await Convos.maybeAutoTitle(text);
      } else {
        const upd = await Cloud.data.updateMemory(m.id, patch);
        Object.assign(m, upd || patch);
      }
      await Sync.bump(isNew ? 'mem-add' : 'mem-edit');
      Convos.bumpUpdated(S.convId);
      updateWhoState();
      render();
      toast(isNew ? '已添加。' : '已保存。', 'ok');
    });
  });
}

/* ── 修改密码 ──────────────────────────────────────────────────────── */
function openChangePassword() {
  const form = document.createElement('div');
  form.className = 'stack';
  form.innerHTML =
    '<div class="field"><label class="label" for="p-old">当前密码</label>' +
      '<input class="input" id="p-old" type="password" autocomplete="current-password"></div>' +
    '<div class="field"><label class="label" for="p-new">新密码</label>' +
      '<input class="input" id="p-new" type="password" autocomplete="new-password" placeholder="至少 8 位"></div>' +
    '<div class="hint-danger" id="p-err"></div>';

  return modal({
    title: '修改密码',
    body: form,
    actions: [
      { label: '取消', value: null, kind: 'btn-ghost' },
      { label: '保存', value: 'save', kind: 'btn-primary' },
    ],
  }).then(function (v) {
    if (v !== 'save') return;
    const oldP = $('#p-old', form).value;
    const newP = $('#p-new', form).value;
    const err = $('#p-err', form);
    if (newP.length < 8) { err.textContent = '新密码至少 8 位。'; return; }
    return withBusy(async () => {
      try {
        await Cloud.auth.changePassword(oldP, newP);
        toast('密码已修改。', 'ok');
      } catch (e) {
        err.textContent = Cloud.humanize(e);
      }
    });
  });
}

/** 邮箱验证码弹窗：拿到 /api/owner 返回的 otp_id 后调。 */
function openOwnerVerify(otpId) {
  const form = document.createElement('div');
  form.className = 'stack';
  form.innerHTML =
    '<p class="hint">验证码已发到你刚填的邮箱（可能在订阅/垃圾邮件里）。</p>' +
    '<div class="field">' +
      '<label class="label" for="ov-code">6 位验证码</label>' +
      '<input class="input" id="ov-code" inputmode="numeric" maxlength="6"' +
        ' autocomplete="one-time-code" placeholder="123456">' +
    '</div>';
  return modal({
    title: '验证你的邮箱',
    body: form,
    actions: [
      { label: '取消', value: null, kind: 'btn-ghost' },
      { label: '确认', value: 'ok', kind: 'btn-primary' },
    ],
  }).then(async function (v) {
    if (v !== 'ok') return;
    const code = $('#ov-code', form).value.trim();
    if (!code) return;
    return withBusy(async () => {
      try {
        const r = await fetch('/api/owner/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ otp_id: otpId, code }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        S.profile = Object.assign({}, S.profile, { verified: true });
        try { localStorage.setItem('aa.profile.v1', JSON.stringify(S.profile)); } catch (e) {}
        render();
        toast('邮箱验证完成。它现在可以主动给你写信了。', 'ok');
      } catch (e) {
        toast('验证没通过：' + e.message, 'err');
        openOwnerVerify(otpId);   // 没过就再给一次输入机会
      }
    });
  });
}

/* ══ 10 · 并行思考与对话操作 ══════════════════════════════════════════ */

/** 关掉当前弹窗（走 Esc 路径，让 modal 自己清理监听并 resolve） */
function closeModal() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

/**
 * 并行思考：一次让 AA 往 n 个方向想。
 *
 * 流程刻意分成三段，顺序不能换：
 *   ① 并发算（computeDraft）—— 纯计算 + 网络，各跑各的，互不干扰
 *   ② 串行写（commitDraft）—— 落库走互斥锁，避免互相覆盖
 *   ③ 统一收尾 —— 等队列跑空再更新对话轮次和同步版本号
 * 第 ③ 步必须等 drain，否则会在任务还没写完时就把轮次 +1。
 */
async function runThinkBatch(n) {
  const count = Math.max(1, Math.min(5, Number(n) || 1));
  if (!S.memories.length) {
    toast('先写几条记忆，AA 才有东西可想。', 'err');
    return;
  }
  await ensureSettings();

  const at = new Date();
  const before = S.proposals.length;

  for (let i = 0; i < count; i++) {
    Tasks.add({
      kind: 'think',
      label: count === 1 ? '思考' : ('方向 ' + (i + 1) + ' / ' + count),
      run: async function (ctx) {
        const res = await computeDraft(i, ctx, at);
        const out = await commitDraft(res, ctx);
        return { note: out.note || res.note };
      },
    });
  }

  await Tasks.drain();

  const added = S.proposals.length - before;
  if (added > 0) {
    const touched = S.proposals.slice(0, added).filter(p => p.touched).length;
    const now = new Date().toISOString();
    await bumpConversation({
      round_count: Number((Convos.current() || {}).round_count || 0) + 1,
      last_run_at: now,
      ...(touched ? { last_touch_at: now } : {}),
    });
    await Sync.bump('think');
    render();
    toast('这一轮想了 ' + count + ' 个方向，新增 ' + added + ' 条，其中 ' +
          touched + ' 条达到触达线。', touched ? 'ok' : 'info');
  } else {
    render();
    toast('这一轮没有产生新提案（候选不足或与近期重复）。', 'info');
  }
}

async function newConversation() {
  await ensureSettings();
  const c = await Convos.create('新对话');
  await Sync.bump('conv-new');
  toast('已新建对话「' + Convos.label(c) + '」。它有独立的记忆和提案，不会和别的事互相干扰。', 'ok');
  go('today');
}

function openConvMenu(id) {
  const c = S.conversations.filter(x => String(x.id) === String(id))[0];
  if (!c) return;
  return modal({
    title: Convos.label(c),
    sub: '这个对话的记忆与提案跟着它一起走。',
    actions: [
      { label: '取消', value: null, kind: 'btn-ghost' },
      { label: '重命名', value: 'rename', kind: 'btn-ghost' },
      { label: '删除对话', value: 'del', kind: 'btn-danger' },
    ],
  }).then(function (v) {
    if (v === 'rename') return renameConversation(c);
    if (v === 'del') return deleteConversation(c);
  });
}

function renameConversation(c) {
  const form = document.createElement('div');
  form.className = 'stack';
  form.innerHTML =
    '<div class="field"><label class="label" for="c-name">对话名称</label>' +
    '<input class="input" id="c-name" maxlength="40" value="' + esc(Convos.label(c)) + '">' +
    '<p class="hint">名字只影响你自己怎么看它。</p></div>';

  return modal({
    title: '重命名对话',
    body: form,
    actions: [
      { label: '取消', value: null, kind: 'btn-ghost' },
      { label: '保存', value: 'save', kind: 'btn-primary' },
    ],
  }).then(function (v) {
    if (v !== 'save') return;
    const name = $('#c-name', form).value.trim();
    if (!name) { toast('名称不能为空。', 'err'); return; }
    return withBusy(async () => {
      await Convos.rename(c.id, name);
      await Sync.bump('conv-rename');
      render();
      toast('已重命名。', 'ok');
    });
  });
}

function deleteConversation(c) {
  return modal({
    title: '删除对话「' + Convos.label(c) + '」？',
    sub: '这个对话里的记忆和提案会一起删除，不可恢复。其他对话不受影响。',
    actions: [
      { label: '取消', value: null, kind: 'btn-ghost' },
      { label: '确认删除', value: 'del', kind: 'btn-danger' },
    ],
  }).then(function (v) {
    if (v !== 'del') return;
    return withBusy(async () => {
      await Convos.remove(c.id);
      await Sync.bump('conv-del');
      render();
      toast('对话已删除。', 'ok');
    });
  });
}

function openConvPicker() {
  return modal({
    title: '切换对话',
    body: Convos.pickerBody(),
    actions: [{ label: '关闭', value: null, kind: 'btn-ghost' }],
  });
}

/* ══ 11 · 版本自动更新 ════════════════════════════════════════════════ */

let versionTimer = null;
let lastRemoteToastAt = 0;

function readBuildFromMeta() {
  const m = document.querySelector('meta[name="aa-build"]');
  const v = m ? String(m.getAttribute('content') || '') : '';
  // 没被后端替换过（例如直接打开本地文件）时，占位符不算有效指纹
  if (!v || v.indexOf('__AA_BUILD__') >= 0) return '';
  return v;
}

/**
 * 检查有没有新版本。
 *
 * 手动检查立刻刷新（用户明确要求了，打断他是预期的）；
 * 自动检查则要先等界面空闲 —— 正在打字或者弹窗开着的时候刷新页面
 * 是不可接受的，宁可晚几分钟。
 */
async function checkVersion(manual) {
  try {
    const info = await Cloud.version.fetchVersion();
    S.version.lastCheck = new Date().toISOString();
    S.version.error = null;
    const current = S.version.build;
    if (!current) S.version.build = info.build || '';
    if (info.build && current && info.build !== current) {
      S.version.pending = info.build;
      if (manual) {
        toast('发现新版本（' + info.build + '），正在刷新…', 'ok');
        setTimeout(function () { location.reload(); }, 900);
      } else {
        applyUpdate(info.build);
      }
    } else if (manual) {
      toast('已是最新版本（' + (info.build || current || '未知') + '）。', 'ok');
    }
  } catch (e) {
    S.version.error = (e && e.message) || String(e);
    if (manual) toast('检查更新失败：' + S.version.error, 'err');
  }
  if (S.route === 'settings' && S.booted) render();
}

function applyUpdate(build) {
  const modalRoot = $('#modal-root');
  const el = document.activeElement;
  const tag = el && el.tagName;
  const busyInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                    (el && el.isContentEditable);
  const blocked = S.busy || busyInput || Tasks.busy() ||
                  (modalRoot && modalRoot.children.length);
  if (blocked) {
    setTimeout(function () { applyUpdate(build); }, 3000);
    return;
  }
  S.version.applies++;
  toast('已发布新版本，正在更新到 ' + build + '…', 'ok');
  setTimeout(function () { location.reload(); }, 1000);
}

function startVersionWatch() {
  S.version.build = S.version.build || readBuildFromMeta();
  if (versionTimer) return;
  checkVersion(false);
  versionTimer = setInterval(function () { checkVersion(false); }, 60000);
}

/* ══ 12 · 视图切换与启动 ══════════════════════════════════════════════ */

/* 登录页不是入口，是**按需打开的一层**。
   openAuth 刻意不重置 booted、不清状态：用户点「返回」时要能原样回到刚才那页，
   而不是重走一遍启动流程（重走会丢掉当前对话、滚动位置、未提交的输入）。 */
function openAuth() {
  renderAuth('login');
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  injectIcons(document);
  const host = $('#auth-form-host');
  const first = host && host.querySelector('input');
  if (first) { try { first.focus(); } catch (e) {} }
}

/** 从登录页返回应用。只有已经进过应用才成立 —— 没进过就没有「返回」可言。 */
function backToApp() {
  if (!S.booted) return;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  go(S.route || 'today');
}

/** 兼容旧调用点：语义已从「回到登录页」变为「主动打开登录页」。 */
function showAuth() { return openAuth(); }

/**
 * 退出登录 = 回到本地模式，**不是**回到登录页。
 * 本地的数据留着不动 —— 退出登录不该顺手删掉别人攒的东西。
 */
async function afterSignOut(msg) {
  try { Sync.stop(); } catch (e) {}
  if (versionTimer) { clearInterval(versionTimer); versionTimer = null; }
  Tasks.clearFinished();

  Cloud.setMode('local');
  S.user = null; S.conversations = []; S.convId = null;
  S.memories = []; S.proposals = []; S.feedback = [];
  S.settings = null; S.cfg = null; S.booted = false; S.migrated = null;

  await enterLocal();
  if (msg) toast(msg, 'info');
}

function updateWhoState() {
  const el = $('#who-state');
  if (!el) return;
  const active = S.memories.filter(m => !m.archived).length;
  const c = Convos.current();
  el.textContent = active + ' 条活跃记忆' + (c ? ' · ' + Convos.label(c) : '');
}

/* ══ 13 · 本地模式与数据迁移 ══════════════════════════════════════════ */

/**
 * 进应用（未登录 / 本地模式）。
 *
 * 这是**默认入口**。理由：AA 的核心能力（记忆衰减、评分、提案）全部由本地算法
 * brain.js 算出来，大模型只负责把文案润色得更顺，而且默认关闭。
 * 也就是说 —— 不登录，功能是完整的，不是残缺的试用版。
 * 把登录页挡在前面，等于把一个能用的东西伪装成不能用。
 */
async function enterLocal() {
  Cloud.setMode('local');
  S.user = null;
  S.bootedAt = Date.now();

  await Convos.ensure();
  await loadAll();
  await ensureSettings();
  await settle();
  await loadAll();

  S.booted = true;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  paintIdentity();
  updateWhoState();

  /* 档案与服务端对一次表：验证状态、发件配置只有服务端知道 */
  (async function () {
    try {
      const r = await fetch('/api/owner');
      if (!r.ok) return;
      const j = await r.json();
      S.ownerInfo = j;
      if (S.profile && S.profile.email === j.email && S.profile.verified !== j.email_verified) {
        S.profile.verified = j.email_verified;
        try { localStorage.setItem('aa.profile.v1', JSON.stringify(S.profile)); } catch (e) {}
        if (S.route === 'settings') render();
      }
    } catch (e) { /* 服务端不在也无所谓，档案在本地 */ }
  })();

  /* 主动开口：进应用让它先坐 35 秒（别一开门就搭话），再看时机开口；
     之后每 3 分钟看一眼 —— 隔了 4 小时以上没聊才算够格。 */
  setTimeout(function () { maybeProactive(false); }, 35e3);
  setInterval(function () { maybeProactive(false); }, 3 * 60e3);

  Sync.setLocalOnly(true);
  Sync.start();
  startVersionWatch();
  go('today');
}

/** 登录成功后的统一入口：建/选对话 → 迁移本地数据 → 拉数据 → 结算 → 进应用 */
async function enterApp() {
  // 先切模式，后面所有 Cloud.data 调用（包括迁移本身）才会打到云端
  Cloud.setMode('cloud');

  let u = null;
  try { u = await Cloud.auth.user(); } catch (e) { u = null; }
  if (!u) {
    // getUser 走服务端校验；拿不到说明会话还没落稳
    const s = await Cloud.auth.session();
    u = s && s.user ? s.user : null;
  }
  S.user = u || {};
  try { S.user.email = S.user.email || (await Cloud.auth.session() || {}).user?.email || ''; } catch (e) {}

  /* ⚡ 身份确认即进场，数据同步转后台。
   * 旧版把全部数据加载完才切屏：登录链路上 7-8 个请求串行，网络稍慢
   * 按钮就停在「处理中」十几秒，看起来像卡死。现在先让用户进来看到界面，
   * 同步在背后继续，完成后再刷新一次视图。 */
  S.booted = true;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  paintIdentity();
  updateWhoState();
  go(S.route || 'today');
  toast('已登录，正在同步数据…', 'info');

  // ── 后台同步：失败只提示，不把用户挡在外面 ──
  let mig = null;
  try {
    // 本地模式攒下的东西：只有在账号是空的时候才搬（见 migrateLocalToCloud）
    mig = await migrateLocalToCloud();
    S.migrated = mig;

    await Convos.ensure();
    await loadAll();
    await ensureSettings();
    await settle();
    await loadAll();

    // 今天还没跑过 → 自动想一次（没有未决提案时）
    const hasPending = S.proposals.some(p => !p.outcome && p.touched);
    const today = new Date().toDateString();
    const conv = Convos.current() || {};
    const lastRun = conv.last_run_at ? new Date(conv.last_run_at).toDateString() : null;
    if (!hasPending && lastRun !== today && S.memories.length) {
      try { await runThinkBatch(1); } catch (e) { /* 自动跑失败不该挡住进入 */ }
    }

    Sync.setLocalOnly(false);
    Sync.start();
    startVersionWatch();
    go(S.route || 'today');
  } catch (e) {
    toast('数据同步出了点问题：' + (e && e.message ? e.message : '未知错误') +
          '。界面先用着，稍后在设置里重试。', 'err');
  }

  // 迁移结果必须**明说**，不能让用户猜自己的数据在哪
  if (mig && mig.moved) {
    toast('已把本地攒下的 ' + mig.counts.conversations + ' 个对话、' +
          mig.counts.memories + ' 条记忆搬到你的账号，现在可以跨设备同步了。', 'ok');
  } else if (mig && mig.reason === 'account-not-empty') {
    toast('这个账号里已经有数据，所以本机的本地数据没有被上传，仍然留在本机。', 'info');
  } else if (mig && mig.reason === 'failed') {
    toast('本地数据搬家没成功，已留在本机未动。可以稍后在设置里重试。', 'err');
  }
}

/**
 * 把本地模式的数据搬进当前账号。
 *
 * 规则只有一条，但必须刻死：**账号里已经有数据就不搬。**
 * 理由：合并两份来源不同的数据集，出错时无法回滚，用户也看不懂到底发生了什么。
 * 「空账号才搬」是唯一不会让用户丢东西的规则。
 *
 * id 需要重映射 —— 本地 id（lc_1/lm_3）与云端 uuid 不是一套体系，
 * 提案和反馈上的外键必须跟着换，否则搬过去就是一堆孤儿行。
 */
async function migrateLocalToCloud() {
  if (!window.LocalData || !LocalData.hasAny()) return { moved: false, reason: 'no-local-data' };

  // 账号是不是空的？探两次就够，不必全表扫
  let convs = [], mems = [];
  try {
    convs = await Cloud.cloudData.listConversations();
    mems = await Cloud.cloudData.listMemories(null);
  } catch (e) {
    return { moved: false, reason: 'failed', error: e };
  }
  if ((convs && convs.length) || (mems && mems.length)) {
    return { moved: false, reason: 'account-not-empty' };
  }

  const dump = LocalData.dump();
  const convMap = {}, memMap = {}, propMap = {};

  try {
    // ① 对话
    for (const c of dump.conversations) {
      const row = await Cloud.cloudData.createConversation(c.title);
      if (!row) continue;
      convMap[c.id] = row.id;
      const convPatch = {};
      for (const k of ['round_count', 'last_run_at', 'last_touch_at', 'archived']) {
        if (c[k] != null) convPatch[k] = c[k];
      }
      if (Object.keys(convPatch).length) {
        await Cloud.cloudData.updateConversation(row.id, convPatch);
      }
    }

    // ② 记忆（content/tier/base_weight/lock 由 insertMemories 统一收口）
    const byConv = {};
    dump.memories.forEach(function (m) {
      const cid = convMap[m.conversation_id];
      if (!cid) return;
      (byConv[cid] = byConv[cid] || []).push(m);
    });
    for (const cid of Object.keys(byConv)) {
      const src = byConv[cid];
      const rows = await Cloud.cloudData.insertMemories(
        src.map(m => ({ content: m.content, tier: m.tier, base_weight: m.base_weight,
                        lock: m.lock })), cid);
      (rows || []).forEach(function (row, i) { memMap[src[i].id] = row.id; });
    }

    // ③ 记忆的衰减状态：insertMemories 只带四个字段，其余得回填，
    //    否则搬过去所有记忆都变成「刚创建、从未访问」，衰减进度全丢
    for (const m of dump.memories) {
      const nid2 = memMap[m.id];
      if (!nid2) continue;
      const patch = {};
      for (const k of ['archived', 'dormant', 'rescue_count', 'rescue_base0',
                       'last_accessed', 'final_weight', 'archived_round', 'rescued_at']) {
        if (m[k] != null) patch[k] = m[k];
      }
      if (Object.keys(patch).length) await Cloud.cloudData.updateMemory(nid2, patch);
    }

    // ④ 提案
    for (const p of dump.proposals) {
      const cid = convMap[p.conversation_id];
      if (!cid) continue;
      const row = await Cloud.cloudData.insertProposal(Object.assign({}, p, {
        conversation_id: cid,
        memory_id: p.memory_id == null ? null : (memMap[p.memory_id] || null),
      }));
      if (row) {
        propMap[p.id] = row.id;
        if (p.outcome) await Cloud.cloudData.updateProposal(row.id, { outcome: p.outcome });
      }
    }

    // ⑤ 反馈
    for (const f of dump.feedback) {
      const cid = convMap[f.conversation_id];
      if (!cid) continue;
      await Cloud.cloudData.insertFeedback({
        proposal_id: f.proposal_id == null ? null : (propMap[f.proposal_id] || null),
        outcome: f.outcome, note: f.note, conversation_id: cid,
      });
    }

    // ⑥ 设置
    if (dump.user_settings) {
      await Cloud.cloudData.saveSettings(dump.user_settings);
    }
  } catch (e) {
    // 中途失败：本地数据**不清**，宁可留一份多余的，也不能两边都没有
    return { moved: false, reason: 'failed', error: e };
  }

  LocalData.clear();
  return {
    moved: true,
    counts: {
      conversations: dump.conversations.length,
      memories: dump.memories.length,
      proposals: dump.proposals.length,
    },
  };
}

/** 侧栏底部 / 本地横幅：按当前模式刷新身份显示 */
function paintIdentity() {
  const local = !Cloud.isCloud();
  const av = $('#who-avatar'), mail = $('#who-mail');
  if (av) av.textContent = local ? '本' : (S.user && S.user.email || 'A').slice(0, 1).toUpperCase();
  if (mail) mail.textContent = local ? '本地模式' : (S.user && S.user.email) || '已登录';

  const btnIn = $('#btn-signin'), btnOut = $('#btn-signout');
  if (btnIn) btnIn.hidden = true;   /* 登录已下线 */
  if (btnOut) btnOut.hidden = true;

  const bar = $('#local-bar');
  if (bar) bar.hidden = true;       /* 「登录后同步」横幅随登录一起下线 */
}

function readLocalBarDismissed() {
  try { return localStorage.getItem('aa.localBarDismissed') === '1'; } catch (e) { return false; }
}

function dismissLocalBar() {
  try { localStorage.setItem('aa.localBarDismissed', '1'); } catch (e) {}
  const bar = $('#local-bar');
  if (bar) bar.hidden = true;
}

async function boot() {
  if (!$('#app-view').hidden && S.booted) return;

  /* 云 SDK / 配置缺失时**不再白屏也不再拦人** ——
     应用在本地模式下功能是完整的，云不可用只是「不能登录」而已。
     以前这里直接把人挡在登录页并说「无法初始化」，等于把能跑的东西锁起来了。 */
  try {
    Cloud.client();
    S.cloudOk = true;
  } catch (e) {
    S.cloudOk = false;
  }

  try {
    /* 登录已下线（当前阶段它不是重点）：打开即用，数据存本机。
       账号/同步相关代码保留在文件里休眠，之后要做多设备时再启用。 */
    await enterLocal();
  } catch (e) {
    // 连本地模式都进不去（例如 localStorage 被彻底禁用）才算真正的启动失败
    $('#auth-view').hidden = false;
    $('#auth-form-host').innerHTML =
      '<h1>无法启动</h1><p class="sub">' + esc(e && e.message || e) + '</p>' +
      '<p class="hint">如果浏览器禁用了本地存储，知更无法保存任何记忆。</p>';
    return;
  }

  bindApp();
  injectIcons(document);

  // 任务状态变化 → 只重绘任务面板，不重绘整页。
  // 整页重绘会重置滚动位置，并行跑任务时看起来像页面在抽搐。
  Tasks.onChange(function () {
    if (!S.booted || S.route !== 'today') return;
    const host = $('#content');
    if (!host) return;
    const html = Tasks.panelHTML();
    const cur = $('#task-panel');
    if (cur) {
      if (html) cur.outerHTML = html;
      else cur.remove();
    } else if (html) {
      host.insertAdjacentHTML('afterbegin', html);
    }
  });

  // 远端发生变化（另一台设备 / 另一个标签页改的）→ 重新取数并重绘
  Sync.onRemote(async function (info) {
    if (!S.booted) return;
    try {
      await loadConversationData();
      await Convos.load();
      render();
    } catch (e) { return; }
    // 提示要有节制：同步本身是预期行为，每次弹一下反而变成噪声
    const fromOtherDevice = info.device && info.device !== Sync.deviceLabel();
    if (fromOtherDevice && Date.now() - lastRemoteToastAt > 25000) {
      lastRemoteToastAt = Date.now();
      toast('已同步来自「' + info.device + '」的改动。', 'info');
    }
  });

  // 同步状态变化 → 只重绘状态行
  Sync.onChange(function () {
    if (S.booted) renderSyncLine();
  });

  Cloud.auth.onChange(function (event) {
    if (event === 'SIGNED_OUT' && S.booted) afterSignOut('登录已过期，请重新登录。');
  });
}

/**
 * 跨模块出口。
 *
 * tasks.js / conversations.js / sync.js 需要读状态、触发重绘、弹提示，
 * 但 app.js 是个 IIFE，内部不可见。与其把每个模块都塞进一个文件，
 * 不如显式开一个窄接口 —— 想暴露什么写什么，比全局变量安全得多。
 */
window.AAApp = {
  S, render, go, toast, modal, esc, withBusy, closeModal,
  loadConversationData, loadAll, ensureSettings, settle, reloadConversation,
  runThinkBatch, bumpConversation, checkVersion,
  buildCfg, memModel, worldSignal, updateWhoState,
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
