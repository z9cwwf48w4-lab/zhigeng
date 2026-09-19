/* ==========================================================================
   知更 · 云服务封装（自有后端版）
   --------------------------------------------------------------------------
   认证与数据全部走知更自己的后端（server.py 同源 API）：
   - 认证：验证码登录 / 密码登录 / 找回 / 改密 / 登出 —— 验证码邮件由知更发
   - 数据：对话、记忆、提案、反馈、设置、同步版本号 —— 服务端按会话隔离
   - 会话凭据放在 HttpOnly Cookie 里，JS 拿不到也泄露不了。

   三条铁律（从平台版继承过来，语义不变）：
   1. 只打同源 /api/**，不跨域、不直连任何第三方。
   2. 绝不在请求里带 owner_id —— 身份由服务端按会话决定。
   3. 绝不在 URL 或日志里放令牌。
   ========================================================================== */

const Cloud = (function () {
  let _client = null;

  function client() {
    // 兼容旧调用点（boot 时的可用性探测）。自有后端随进程同生共死，
    // 进程活着 API 就活着，所以这里恒成功。
    if (!_client) _client = {};
    return _client;
  }

  /* ══ 同源 API 请求 ═══════════════════════════════════════════════════ */

  const _authListeners = [];

  function fireAuthEvent(event) {
    _authListeners.forEach(function (cb) {
      try { cb(event); } catch (e) { /* 监听器出错不能影响主流程 */ }
    });
  }

  async function api(path, body, method) {
    let r;
    try {
      r = await fetch(path, {
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (e) {
      throw mkErr('network', '网络不通，请检查网络后重试。');
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* 非 JSON 响应按空处理 */ }
    if (!r.ok) {
      const err = mkErr((j && j.code) || 'http_' + r.status,
        (j && j.error) || ('请求失败（HTTP ' + r.status + '）'));
      err.status = r.status;
      if (r.status === 401) fireAuthEvent('SIGNED_OUT');
      throw err;
    }
    return j;
  }

  function mkErr(kind, message) {
    const e = new Error(message);
    e.kind = kind;
    return e;
  }

  /** 旧接口保留：上层到处在用 Cloud.unwrap / Cloud.normalize / isAuthError */
  async function unwrap(promise) { return promise; }

  function normalize(err) {
    if (!err) return new Error('未知错误');
    if (err instanceof Error) return err;
    const e = new Error(err.message || String(err));
    e.kind = err.kind || err.code || err.name;
    e.status = err.status || err.statusCode;
    return e;
  }

  /** 判断错误是否表示「需要重新登录」 */
  function isAuthError(err) {
    const k = String((err && (err.kind || err.code)) || '');
    return k === 'unauthenticated' || k === 'invalid_grant' ||
           k === 'http_401' || (err && err.status === 401);
  }

  /** 把技术错误翻译成人话。 */
  function humanize(err) {
    const k = String((err && (err.kind || err.code)) || '');
    const m = String((err && err.message) || '');
    if (k === 'unauthenticated' || k === 'invalid_grant') return '邮箱或密码不正确。';
    if (k === 'SMS_NOT_ENABLED') {
      return '手机号登录还没开通（需要先申请短信签名）。请先用邮箱验证码登录。';
    }
    if (k === 'MAIL_NOT_CONFIGURED') {
      return '邮箱服务还没配置好，请联系运营者。';
    }
    if (/rate|too many|throttl|频繁/i.test(m)) return m || '操作太频繁，请稍后再试。';
    if (/network|fetch|timeout|timed out/i.test(m)) return '网络不通，请检查网络后重试。';
    if (/expire|invalid|验证码/i.test(m)) return m || '验证码无效或已过期，请重新获取。';
    if (/password/i.test(m) && /weak|short|least|至少/i.test(m)) return '密码至少 8 位。';
    if (/already|exist|注册/i.test(m)) return '该邮箱已完成注册，请直接登录。';
    return m || '操作失败，请稍后重试。';
  }

  /* ══ 认证（自有后端） ════════════════════════════════════════════════ */

  const auth = {
    /** 会话：HttpOnly Cookie 由浏览器自动带上，这里问服务端「我是谁」 */
    async session() {
      try {
        const j = await api('/api/auth/me');
        return j && j.user ? { user: j.user } : null;
      } catch (e) {
        return null;
      }
    },

    /** 取当前已验证用户（走服务端校验，比缓存可信） */
    async user() {
      const j = await api('/api/auth/me');
      return (j && j.user) || null;
    },

    /** 密码登录。错误文案统一「邮箱或密码不正确」，防账号探测。 */
    async signInWithPassword(email, password) {
      return api('/api/auth/login', { email: email, password: password });
    },

    /** 发送邮箱验证码。返回 { verificationId, isExistingUser } */
    async sendOtp(email, purpose) {
      const j = await api('/api/auth/send-otp',
        { email: email, purpose: purpose === 'reset' ? 'reset' : 'login' });
      return { verificationId: j.verificationId, isExistingUser: !!j.isExistingUser };
    },

    /**
     * 校验邮箱验证码。
     * - 登录：不传 password
     * - 注册：传 password（密码挂在已验证的验证码链上）
     */
    async verifyOtp({ verificationId, token, email, password }) {
      const payload = { verificationId: verificationId, token: token, email: email };
      if (password) payload.password = password;
      return api('/api/auth/verify-otp', payload);
    },

    async signOut() {
      return api('/api/auth/logout', {});
    },

    /** 忘记密码：先发验证码（purpose=reset），再带着 otp_id + 码 + 新密码完成 */
    async resetPasswordForEmail(email) {
      const j = await api('/api/auth/send-otp', { email: email, purpose: 'reset' });
      return j.verificationId;
    },

    async resetPasswordWithNonce(otpId, token, password) {
      return api('/api/auth/reset',
        { verificationId: otpId, token: token, new_password: password });
    },

    /** 已登录状态下改密码 */
    async changePassword(oldPassword, newPassword) {
      return api('/api/auth/change-password',
        { old_password: oldPassword, new_password: newPassword });
    },

    /* ── 手机号登录（框架就绪；短信服务开通后立即可用） ────────────── */

    async sendSmsOtp(phone) {
      const j = await api('/api/auth/send-sms', { phone: phone });
      return { verificationId: j.verificationId, isExistingUser: !!j.isExistingUser };
    },

    async verifySmsOtp({ verificationId, token, phone }) {
      return api('/api/auth/verify-sms',
        { verificationId: verificationId, token: token, phone: phone });
    },

    onChange(cb) {
      _authListeners.push(cb);
      return function () {
        const i = _authListeners.indexOf(cb);
        if (i >= 0) _authListeners.splice(i, 1);
      };
    },

    /** 旧接口保留：自有后端用 Cookie 会话，不需要访问令牌 */
    async accessToken() { return null; },
  };

  /* ══ 数据（自有后端 RPC） ════════════════════════════════════════════ */

  /** 每个调用 = 一次同源 POST /api/data；user_id 由服务端从会话里取。 */
  async function rpc(op, args) {
    const j = await api('/api/data', { op: op, args: args === undefined ? {} : args });
    return j ? j.data : null;
  }

  /** 云端实现。真正的 data 入口在文件末尾按模式路由到它或 LocalData。 */
  const cloudData = {
    /* ── 对话（会话） ─────────────────────────────────────────────── */

    async listConversations() { return rpc('listConversations'); },

    async createConversation(title) { return rpc('createConversation', { title: title }); },

    async updateConversation(id, patch) {
      return rpc('updateConversation', { id: id, patch: patch });
    },

    /** 删对话 = 连同它的记忆与提案一起删。调用方必须先向用户明确这一点。 */
    async deleteConversation(id) { return rpc('deleteConversation', { id: id }); },

    /* ── 记忆 ─────────────────────────────────────────────────────── */

    async listMemories(conversationId) {
      return rpc('listMemories', { conversationId: conversationId });
    },

    /** 把本版本之前写入的孤儿数据（conversation_id 为空）收拢到某个对话 */
    async adoptOrphans(conversationId) {
      return rpc('adoptOrphans', { conversationId: conversationId });
    },

    async insertMemories(list, conversationId) {
      if (!list || !list.length) return [];
      return rpc('insertMemories', { list: list, conversationId: conversationId }) || [];
    },

    async updateMemory(id, patch) {
      return rpc('updateMemory', { id: id, patch: patch });
    },

    async updateMemoriesMany(updates) {
      // 逐条更新：量级（几十条）不值得为它引入批量接口。
      const out = [];
      for (const u of updates) {
        out.push(await cloudData.updateMemory(u.id, u.patch));
      }
      return out;
    },

    async deleteMemory(id) { return rpc('deleteMemory', { id: id }); },

    /* ── 提案 ─────────────────────────────────────────────────────── */

    async listProposals(conversationId, limit) {
      return rpc('listProposals', { conversationId: conversationId, limit: limit });
    },

    async insertProposal(p) { return rpc('insertProposal', p); },

    async updateProposal(id, patch) {
      return rpc('updateProposal', { id: id, patch: patch });
    },

    /* ── 反馈 ─────────────────────────────────────────────────────── */

    async insertFeedback(f) { return rpc('insertFeedback', f); },

    async listFeedback(conversationId, limit) {
      return rpc('listFeedback', { conversationId: conversationId, limit: limit });
    },

    /* ── 设置（全局，不随对话变化） ───────────────────────────────── */

    async getSettings() { return rpc('getSettings'); },

    async saveSettings(patch) {
      const safe = {};
      for (const k of ['touch_line', 'quiet_start', 'quiet_end',
                       'notify_enabled', 'custom_keywords', 'llm']) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) safe[k] = patch[k];
      }
      return rpc('saveSettings', safe);
    },

    /* ── 同步版本号 ───────────────────────────────────────────────── */

    /** 读当前变更版本号。轮询必须便宜：这张表只有一行一列。 */
    async getSyncState() { return rpc('getSyncState'); },

    async bumpSync(device) { return rpc('bumpSync', { device: device }); },
  };

  /* ══ 数据路由：本地 / 云端 ═══════════════════════════════════════════

     为什么用「路由」而不是「两个入口」
     ----------------------------------
     上层有几十处 Cloud.data.* 调用。如果改成「未登录时用另一个对象」，
     就得在每一处写 if —— 迟早会漏一处，而漏掉的表现是「某个操作悄悄写到了
     错误的存储里」，这种 bug 极难发现。

     所以保持 `Cloud.data` 这一个名字不变，只在底下按当前模式分派。
     新增数据方法时，只要在 ROUTED 里列出方法名，路由自动生效。
     ================================================================== */

  let _mode = 'local';   // 'local' | 'cloud'。默认本地：没登录也能用。

  function mode() { return _mode; }
  function setMode(m) { _mode = (m === 'cloud') ? 'cloud' : 'local'; }
  function isCloud() { return _mode === 'cloud'; }

  function sink() {
    if (_mode === 'cloud') return cloudData;
    if (typeof window !== 'undefined' && window.LocalData) return window.LocalData;
    throw new Error('本地数据层未加载。请检查 static/locals.js 是否可访问。');
  }

  const ROUTED = [
    'listConversations', 'createConversation', 'updateConversation', 'deleteConversation',
    'listMemories', 'adoptOrphans', 'insertMemories', 'updateMemory', 'updateMemoriesMany',
    'deleteMemory',
    'listProposals', 'insertProposal', 'updateProposal',
    'insertFeedback', 'listFeedback',
    'getSettings', 'saveSettings',
    'getSyncState', 'bumpSync',
  ];

  const data = {};
  ROUTED.forEach(function (name) {
    data[name] = function () {
      const args = arguments;
      return sink()[name].apply(null, args);
    };
  });

  /* ══ 版本（本项目自己的后端，同源、无凭据） ═════════════════════════ */

  const version = {
    async fetchVersion() {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (!r.ok) throw new Error('版本接口返回 HTTP ' + r.status);
      return r.json();
    },
  };

  /* ══ 大模型（服务端默认配置；用户自接入的走 app.js 的 /api/llm 中继） ══ */

  const llm = {
    async models() { return []; },

    pickModel(list) { return (list && list.length && list[0]) || null; },

    /**
     * 一次性生成文本。用户没接自己的模型时，走服务端默认配置；
     * 服务端也没配 → 后端返回 400，上层 catch 后按「润色失败」处理。
     */
    async complete({ system, user, temperature, maxChars }) {
      const r = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(temperature == null ? {} : { temperature: temperature }),
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      let text = (j.choices && j.choices[0] && j.choices[0].message &&
                  j.choices[0].message.content) || '';
      if (maxChars && text.length > maxChars) text = text.slice(0, maxChars);
      return text;
    },
  };

  return { client, unwrap, normalize, isAuthError, humanize,
           auth, data, cloudData, llm, version,
           mode, setMode, isCloud };
})();

if (typeof window !== 'undefined') window.Cloud = Cloud;
