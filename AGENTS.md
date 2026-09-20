# AGENTS.md — 知更（zhigeng）项目交接

> 给接手的 AI 编码代理（Codex / Claude Code 等）的完整上下文。读完即可直接干活。

## 这是什么

「知更」是一个单文件 Python 服务 + 零构建原生前端的个人 AI 伴侣应用。
核心设计目标：**它不是一个有问必答的客服，是一个会先开口、有时间感、有情绪的熟人。**

- 线上：https://aa-agent.app.workbuddy.host/
- 仓库：https://github.com/z9cwwf48w4-lab/zhigeng（main 分支）
- 用户：中国大陆，学生，中文交流，不懂英文，偏好直接可用、不要逐步确认。

## 架构（刻意保持极简，不要引入框架/构建工具）

| 部分 | 文件 | 说明 |
|---|---|---|
| 服务端 | `server.py`（单文件，标准库 only） | HTTP 服务 + SQLite + LLM 中继 |
| 前端 | `static/index.html` + `static/app.js` + `static/app.css` | 无构建、无 CDN、无依赖 |
| 私有配置 | `llm.default.json`（根目录，**已 gitignore**） | 默认 LLM（DeepSeek），读序：`data/llm.json` → `llm.default.json` |
| 运行时数据 | `data/`（**已 gitignore**） | SQLite 库、owner.json、SMTP/短信配置 |

- 前端状态全在 `localStorage`（聊天 `aa.chat.v1`、感受 `aa.mood.v1`、主动开口节流 `aa.proactive.v1`、用户档案 `aa.profile.v1`）。
- CSP 只允许 HTTPS 外发；LLM 调用走同源 `POST /api/llm`（服务端中继，key 不落前端）。

## 本地跑

```bash
PORT=8140 python3 server.py     # 访问 http://127.0.0.1:8140
```

- 改了 `static/app.js` 后**必须重启 server**：静态资源按 `?v=<指纹>` immutable 缓存，不重启浏览器拿的是旧代码（这是排查「改了没生效」的第一件事）。
- 语法校验：`python3 -c "import ast; ast.parse(open('server.py').read())"`；`node --check static/app.js`。

## 功能地图（static/app.js 内的编号分节）

1. **对话**（路由 `chat`）：`chatSystem()` 组装人设（时间/称呼/档案/在意的事/感受），`chatSend/chatComplete` 走 `/api/llm`。
2. **感受引擎**：`moodNow()/moodTick()` —— 知更的实时状态（很想你/有点想你/在等你回来/挺高兴/挺安心/陪你熬夜），由距上次聊天的时间与总回合数推导，注入系统提示词 + 对话页顶部状态行。消息按天分组（`chat-day` 分隔线）。
3. **主动开口**：`maybeProactive()` —— 进场 35s 后 + 每 3 分钟检查；距上次对话 ≥4h 触发；节流：两次间隔 ≥4h、每天 ≤2 次、进场 30s 静默。不在对话页 → 侧栏角标 + 桌面通知。LLM 失败有本地模板兜底。
4. **「关于你」档案**（设置页）：称呼/自我介绍/邮箱；存 localStorage + `POST /api/owner`（服务端 `data/owner.json`）。邮箱变更触发验证码（SMTP 未配置时返回 `needs_smtp:true` 安全降级）。
5. **晚间来信**（服务端线程 `proactive_mail_loop`）：北京时间每晚 21 点后给已验证邮箱写一封信（LLM 撰写，模板兜底，一天一封）；`POST /api/owner/test-mail` 立即来信。
6. 旧账号体系（验证码/密码登录、云同步）**代码保留但登录墙已下线**（`boot()` 直接 `enterLocal()`），多设备需求时再启用。

## 已知坑（务必读）

- **`data/` 会被 sites 部署全量上传**：workbuddy sites 部署是新沙箱时会把本地 `data/` 带上线、覆盖线上库（Phase 11 踩过）。部署前清理 `data/owner.json` 等测试残留；不要把真实用户数据只存服务端。
- **WKWebView immutable 缓存**：本地测试时改前端必须重启 server 换指纹，否则截图/注入测的是旧代码，出现「功能没触发」的假象。
- **GitHub 严禁混入**：`llm.default.json`（含 API key）、`data/`、任何密码。提交前 `git status` + `git check-ignore` 核对。
- 沙箱/后台进程：本地起服务用受管后台任务；shell 退出会清掉 `nohup &` 子进程。
- 代理：本机 curl 走本地回环要加 `--noproxy '*'`。

## 待办（按优先级）

1. **SMTP 授权码**：QQ 邮箱 16 位授权码配到 `data/mail.json`，晚间来信与邮箱验证才真正可用（代码已就绪，`smtplib` 已封装）。
2. **感受引擎深化**：目前状态由时间/回合数推导；可加入「对在意之事的关心度」（每条记忆一个衰减权重，久未提起会主动问起）。
3. **多设备**：启用休眠的账号体系，把 chat/mood/profile 以服务端为准同步。
4. 旧路由 `memory`→`care`、`history`→`timeline` 的兼容别名仍在，可择机清理。

## 代码风格

- 中文注释，注释讲「为什么」不是「是什么」。
- 无框架、无 TypeScript、无打包步骤——别加。
- 前端事件走 `data-act` 委托；新交互优先复用 `--gold/--bg-raise/--line` 设计令牌。
