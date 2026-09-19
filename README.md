# 知更 · 替你想该做什么

> 它不回答你的问题。它替你想，该做什么。

**知更（Zhigeng）** 是一个**主动提案助手**：它不像普通 AI 聊天那样等你提问，而是主动观察你「在意的事」，定期给你提出「现在该去做什么」的具体建议。

本项目是**完全自托管的开源版本**：用户系统、数据存储、验证码发信全部运行在你自己的服务器进程里，不依赖任何第三方云账号，用户全程看不到任何平台字样。

线上 Demo：<https://aa-agent.app.workbuddy.host/>

---

## 特性

- **自有账号系统**：邮箱验证码注册/登录、密码登录、找回密码，全部自建（SQLite + 会话 Cookie），不经过任何平台。
- **验证码邮件显示「知更」**：用你自己的邮箱 SMTP 发出，收件人看到的是你的产品名，而不是某个平台。
- **手机号登录（框架已就绪）**：界面与后端接口已通，配置阿里云/腾讯云短信后即时启用。
- **外置大模型接入**：用户可在设置里填自己的 DeepSeek / Kimi / 智谱 / 自定义 API Key；不填则用服务端默认模型。
- **零构建、零 CDN**：纯静态前端（自托管 Open Props / AutoAnimate / Lucide 子集），后端单文件 `server.py`，`python3 server.py` 即可跑。

## 架构

```
浏览器 ──HTTPS──> server.py（Python 单文件）
                    ├─ 静态资源（static/）
                    ├─ /api/auth/*    自建账号：注册 / 登录 / OTP / 会话
                    ├─ /api/data      业务数据（记忆 / 提案 / 反馈 / 设置），按 user_id 隔离
                    ├─ /api/llm       大模型中继（当次转发，不存 key）
                    └─ data/zhigeng.db（SQLite，首次启动自动建库）
```

| 层 | 技术 |
|---|---|
| 前端 | 原生 JS（无框架）+ Open Props 设计令牌 |
| 后端 | Python 3.9+ 标准库（`http.server` + `sqlite3`），单文件 |
| 存储 | SQLite（文件数据库，部署环境磁盘持久即持久化） |
| 认证 | scrypt 密码哈希 + 6 位验证码（`salt$sha256`）+ HttpOnly 会话 Cookie（30 天） |

> 微信扫码 / QQ 扫码 / 苹果登录属于第三方 OAuth，需要企业资质或已备案域名与开发者账号，本项目未内置，但手机号与邮箱验证码已完整可用。

## 目录结构

```
aa-cloud/
├── server.py            # 后端单文件：静态托管 + 认证 + 数据 + 大模型中继
├── static/              # 前端（app.js / cloud.js / brain.js / ...）
├── tools/               # 测试与探针脚本（test_own_backend.py 等）
├── data/                # 运行时生成：zhigeng.db 与 mail.json/sms.json/llm.json（不入库）
├── .gitignore
├── LICENSE
└── README.md
```

## 快速开始

要求 **Python 3.9+**。

```bash
cd aa-cloud
python3 server.py          # 默认监听 0.0.0.0:$PORT（未设则 8080）
# 浏览器打开 http://127.0.0.1:8080
```

首启会自动建库 `data/zhigeng.db`。此时**还没配邮箱 SMTP**，验证码发不出去；本地可用 `tools/test_own_backend.py` 里的 `create_otp` 直接造一个验证码走通流程，或先配好下面的 SMTP 再测真实发信。

## 配置

所有密钥都在**运行时**，不进代码、不下发浏览器。

### 1. 邮箱验证码（让发件人显示「知更」）

二选一：

**环境变量：**

```bash
export ZG_SMTP_HOST=smtp.qq.com
export ZG_SMTP_PORT=465
export ZG_SMTP_USER=your@qq.com
export ZG_SMTP_PASS=你的QQ邮箱授权码   # 注意：不是 QQ 密码
export ZG_SMTP_SENDER_NAME=知更
```

**或写文件 `data/mail.json`：**

```json
{
  "host": "smtp.qq.com",
  "port": 465,
  "user": "your@qq.com",
  "pass": "授权码",
  "sender_name": "知更"
}
```

> QQ 邮箱授权码获取：mail.qq.com → 设置 → 账号 → 开启 POP3/IMAP/SMTP → 发短信验证后获得 16 位授权码。未配置时 `/api/auth/send-otp` 返回 `503 MAIL_NOT_CONFIGURED`。

### 2. 手机号登录（可选）

配置 `data/sms.json`（阿里云 / 腾讯云短信）后即时启用，界面与接口已就绪：

```json
{
  "provider": "aliyun",
  "access_key": "...",
  "secret": "...",
  "sign": "知更",
  "template": "SMS_xxxx"
}
```

未配置时 `/api/auth/send-sms` 返回 `501 SMS_NOT_ENABLED`。

### 3. 服务端默认大模型（可选）

用户没填自己的 Key 时，让服务端用默认模型。写 `data/llm.json`：

```json
{
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "...",
  "model": "deepseek-chat"
}
```

## 部署

本项目是标准 Python HTTP 服务，可部署到任意能跑 `python3 server.py` 的环境（自有服务器、容器、或支持 Python 的托管平台）。**务必用 HTTPS 反代**——CSP 安全头仅在 HTTPS（`X-Forwarded-Proto`）下发送；明文 http 源下为避免个别 WebView 的脚本加载异常，会自动跳过 CSP。

## 安全说明

- 会话 Cookie 为 `HttpOnly` + `SameSite`，30 天有效期。
- 密码用 scrypt 哈希存储；验证码加盐（`salt$sha256`）且 10 分钟过期、限重试次数、限发送频率。
- 所有密钥仅存于服务端环境变量 / 文件，**绝不**出现在前端代码或网络响应里。
- 业务数据严格按 `user_id` 隔离。
- 部署环境需保证磁盘持久（数据存 SQLite 文件）；若用临时文件系统，重启会丢数据。

## License

[MIT](LICENSE) © 知更 Zhigeng contributors
