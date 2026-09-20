# AGENTS.md — 知更（zhigeng）v2 项目交接

> 给接手的 AI 编码代理（Codex / Claude Code 等）的完整上下文。读完即可直接干活。

## 这是什么

「知更」是一个个人 AI 伙伴应用：**会先开口、有时间感、有情绪的熟人**，不是有问必答的客服。
v2（2026-09-20 重构）是全新模块化架构；旧版单文件屎山封存在 git tag `v0.11-legacy`。

- 线上：https://aa-agent.app.workbuddy.host/
- 仓库：https://github.com/z9cwwf48w4-lab/zhigeng（main 分支）
- 用户：中国大陆，学生，中文交流，不懂英文，偏好直接可用、不要逐步确认。

## 架构（刻意保持：标准库 only + 零构建前端，不要引入框架）

```
server.py            薄入口：静态服务 + API 分发 + 启动（~100 行）
app/
  config.py          路径与 LLM 配置（读序：data/llm.json → llm.default.json，均 gitignore）
  db.py              SQLite：messages / memories / profile / kv 四张表，WAL，单用户无鉴权
  llm.py             OpenAI 兼容直连客户端：stream() SSE 生成器 + complete()
  mood.py            感受引擎：纯函数，从 DB 推导知更此刻状态
  persona.py         人设：system prompt 组装（时间/称呼/档案/记忆/情绪）+ 上下文窗口
  proactive.py       主动开口：due() 三重节流 + fire() 生成入库（模板兜底）
  api.py             全部 API 路由（JSON + SSE）
web/                 前端：原生 ES Modules，无构建无 CDN
  index.html         骨架（rail + topbar + view）
  css/app.css        设计令牌 + 组件
  js/main.js         入口：路由 + 30s 心跳（心跳顺带触发主动开口检查）
  js/api.js          fetch 封装 + SSE 解析
  js/store.js        全局状态 + 工具
  js/views/          chat.js（流式对话）/ care.js（它在意的）/ settings.js（关于你）
```

- **单用户设计**：无登录无鉴权，数据全在服务端 DB——多设备打开看到同一段对话。
- 对话 `POST /api/chat` 是 SSE 流式（event: delta/error/done）。
- 主动开口挂在 `GET /api/state`（前端 30s 心跳）上：距最后消息 ≥4h、距上次主动 ≥4h、
  每天 ≤2 次；空库首次访问会打第一声招呼。生成失败有模板兜底。
- 感受状态由消息表推导（≥48h 很想你 / ≥20h 有点想你 / ≥4h 在等你回来 / 近期 挺高兴→挺安心；
  23 点后且安心→陪你熬夜），注入 system prompt 并展示在顶栏。

## 本地跑

```bash
PORT=8140 python3 server.py     # http://127.0.0.1:8140
```

- 改前端后浏览器强刷即可（静态响应带 no-cache；入口引用带 ?v=N，大改时升 N）。
- 语法校验：`python3 -c "import ast; ast.parse(open('server.py').read())"`；
  `node --check web/js/main.js`（逐个文件）。

## 已知坑（务必读）

- **`data/` 会被 sites 部署全量上传**：部署前清理测试残留（测试产生的 robin.db / owner 数据）。
- **WKWebView 缓存**：入口 `?v=N` 不变时可能拿旧资源，改完前端升版本号或重启。
- **GitHub 严禁混入**：`llm.default.json`（API key）、`data/`。提交前 `git check-ignore llm.default.json`。
- WorkBuddy 沙箱内跑 codex：先 `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy codex ...`
  （沙箱注入的 127.0.0.1:59003 代理会劫持本地 litellm 4001）。
- 本地 curl 打回环要 `--noproxy '*'`。

## 待办（按优先级）

1. **SMTP 授权码**（16 位，QQ 邮箱）：v2 尚未移植晚间来信（旧版在 `v0.11-legacy` 的
   proactive_mail_loop，移植目标：新 app/mailer.py + 每晚线程）。
2. **记忆衰减权重**：每条记忆一个关心度，久未提起主动问起。
3. **对话分页**：/api/messages 已支持 after 增量，可加 before 向上翻页。
4. **PWA / 移动端适配打磨**：窄屏 rail 已变底 tab，可继续优化触控。

## 代码风格

- 中文注释，注释讲「为什么」不是「是什么」。
- 后端标准库 only；前端原生 ESM、无框架、无打包——别加。
- 前端状态在 store.js 的 S；新视图 = views/ 新文件 + main.js ROUTES 注册一行。
