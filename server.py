# -*- coding: utf-8 -*-
"""AA · 主动提案助手 —— 云端服务

一个进程干三件事：

  ① 托管前端（static/）
     认证、对话、记忆库、提案、设置全在这个静态站里跑。
     数据不经过这里 —— 前端直接和平台数据面通信，身份由平台按登录会话
     决定。这个进程没有、也不需要有读取用户数据的能力。

  ② 提供构建指纹（/api/version）
     前端的「自动跟随最新版」靠它：页面把启动时的指纹记下来，之后定期比对，
     不一样就说明发布了新版本，自动刷新。没有这个信号，桌面应用就只能在
     「用户手动重启」和「长期跑旧版」之间二选一。

  ③ 运行环境探针（/api/probe）
     继续记录云端环境的行为，回答三个文档里查不到的问题：
       · 进程能不能 7×24 常驻（心跳空档 = 被挂起；启动次数 +1 = 被杀）
       · 写的文件能不能留住（重启后计数能否累加）
       · 能不能访问外网（公网 / 平台数据面分开记）
     这不是调试残留，是「主动触达」能不能做实时推送的前提。

缓存策略（直接影响「最新版」能不能真的到达用户）：
  · HTML 一律 no-store —— 拿到旧 HTML 就会引用旧的资源指纹，整条链都旧。
  · 资源带 ?v=<构建指纹> 时给一年 immutable —— 指纹变了 URL 就变，不会撞旧的。
  · 资源没带 v 时给 5 分钟 —— 保守兜底，避免某些代理把中间态长期缓存。
  index.html 里所有本地资源都写了 ?v=__AA_BUILD__，由本进程在返回 HTML 时
  替换成真实指纹。这样一次部署 = 一次指纹变化 = 全站资源强制换新。

安全边界：
  · 静态文件路径必须做 realpath 前缀比对 —— 只过滤 "../" 不够，
    URL 编码（%2e%2e）和符号链接都能绕过朴素的字符串检查。
  · 进程不持有任何密钥；publishable key 是公开参数，前端自带。
"""

import hashlib
import json
import os
import platform
import re
import secrets
import smtplib
import sqlite3
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid as uuidlib
from datetime import datetime, timedelta, timezone
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

BUILD_PLACEHOLDER = "__AA_BUILD__"

# ── 探针：两处写入点，对比「项目目录」和「临时目录」哪个能留住 ──────────
STATE_PATHS = [
    ("项目目录", os.path.join(HERE, "probe_data", "state.json")),
    ("临时目录", "/tmp/aa_probe_state.json"),
]

HEARTBEAT_INTERVAL = float(os.environ.get("AA_HB_INTERVAL", "20"))
GAP_THRESHOLD = float(os.environ.get("AA_GAP_THRESHOLD", "90"))
NET_INTERVAL = float(os.environ.get("AA_NET_INTERVAL", "60"))

NET_TARGETS = [
    ("公网连通", "https://www.baidu.com"),
    ("平台数据面", "https://aa-agent.app.workbuddy.host/"),
]

_lock = threading.Lock()

_state = {
    "boot_count": 0,
    "first_boot_ts": None,
    "last_boot_ts": None,
    "pid": None,
    "heartbeat_count": 0,
    "last_heartbeat_ts": None,
    "gaps": [],
    "net": {},
    "disk": {},
    "hostname": None,
    "python": None,
}


def _now():
    return time.time()


def _iso(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def _read_state():
    for _, path in STATE_PATHS:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            continue
    return None


def _write_state():
    ok = {}
    blob = json.dumps(_state, ensure_ascii=False, indent=2)
    for label, path in STATE_PATHS:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(blob)
            os.replace(tmp, path)
            d = _state["disk"].setdefault(
                label, {"path": path, "write_count": 0, "first_write_ts": None})
            d["write_count"] += 1
            d["first_write_ts"] = d["first_write_ts"] or _now()
            d["last_write_ts"] = _now()
            ok[label] = True
        except Exception as e:
            d = _state["disk"].setdefault(
                label, {"path": path, "write_count": 0, "first_write_ts": None})
            d["last_error"] = str(e)
            ok[label] = False
    return ok


def boot():
    prev = _read_state()
    with _lock:
        if prev:
            _state["boot_count"] = int(prev.get("boot_count") or 0) + 1
            _state["first_boot_ts"] = prev.get("first_boot_ts") or _now()
            _state["net"] = prev.get("net") or {}
            _state["disk"] = prev.get("disk") or {}
            _state["gaps"] = (prev.get("gaps") or [])[-50:]
        else:
            _state["boot_count"] = 1
            _state["first_boot_ts"] = _now()
            _state["gaps"] = []
        _state["last_boot_ts"] = _now()
        _state["pid"] = os.getpid()
        _state["hostname"] = platform.node()
        _state["python"] = sys.version.split()[0]
        if prev and prev.get("last_heartbeat_ts"):
            _state["prev_last_heartbeat_ts"] = prev["last_heartbeat_ts"]
    _write_state()
    print("[aa] boot #%d pid=%d port=%s"
          % (_state["boot_count"], os.getpid(), os.environ.get("PORT", "8080")), flush=True)


def heartbeat_loop():
    """抓「冻结」：线程本该每 20 秒醒一次，却隔了很久 → 进程被挂起过。"""
    last = _now()
    while True:
        time.sleep(HEARTBEAT_INTERVAL)
        now = _now()
        gap = now - last
        with _lock:
            if gap > GAP_THRESHOLD:
                _state["gaps"].append({
                    "from": _iso(last), "to": _iso(now), "seconds": round(gap, 1)})
                _state["gaps"] = _state["gaps"][-50:]
            _state["heartbeat_count"] += 1
            _state["last_heartbeat_ts"] = now
            last = now
            _write_state()


def net_loop():
    """探测外网可达性。

    判定口径：**只要拿到 HTTP 响应就算「通」**，哪怕 404 / 403 / 500 ——
    要回答的是「网络能不能出去」，不是「那个地址有没有内容」。
    本地自测时踩过这个坑：平台域名返回 404 被错判成不通，而实际上
    DNS 解析、TLS 握手、HTTP 往返全都成功了。只有连不上才算不通。
    """
    ctx = ssl.create_default_context()
    while True:
        for label, url in NET_TARGETS:
            t0 = _now()
            reachable, detail = False, ""
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "aa/1.0"})
                with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
                    r.read(64)
                    reachable, detail = True, "HTTP %d" % r.status
            except urllib.error.HTTPError as e:
                reachable, detail = True, "HTTP %d（可达）" % e.code
            except Exception as e:
                detail = "%s: %s" % (type(e).__name__, e)
            ms = int((_now() - t0) * 1000)
            with _lock:
                s = _state["net"].setdefault(label, {
                    "ok_count": 0, "fail_count": 0,
                    "last_ok_ts": None, "last_latency_ms": None, "last_error": None})
                if reachable:
                    s["ok_count"] += 1
                    s["last_ok_ts"] = _now()
                    s["last_latency_ms"] = ms
                    s["last_error"] = None
                    s["last_detail"] = detail
                else:
                    s["fail_count"] += 1
                    s["last_error"] = detail
                _write_state()
        time.sleep(NET_INTERVAL)


# ── 构建指纹 ─────────────────────────────────────────────────────────────

def compute_build():
    """把所有静态文件的内容哈希成一个短指纹。

    为什么要哈希内容而不是用时间戳：部署可能重放同一份代码（回滚、重试），
    时间戳会变但内容没变 —— 那会让所有客户端白刷一次。内容哈希则精确表示
    「用户实际拿到的东西变了没有」。
    """
    h = hashlib.sha256()
    files = []
    for root, dirs, names in os.walk(STATIC_DIR):
        dirs.sort()
        for n in sorted(names):
            files.append(os.path.join(root, n))
    for path in files:
        rel = os.path.relpath(path, STATIC_DIR)
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        try:
            with open(path, "rb") as f:
                h.update(hashlib.sha256(f.read()).digest())
        except OSError:
            h.update(b"<unreadable>")
        h.update(b"\0")
    return h.hexdigest()[:12]


BUILD = compute_build()

# ── 静态文件 ─────────────────────────────────────────────────────────────

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

_asset_cache = {}          # 无指纹资源的短缓存，避免每次请求都读盘


def _read_file(path):
    st = os.stat(path)
    key = (path, st.st_mtime_ns, st.st_size)
    hit = _asset_cache.get(path)
    if hit and hit[0] == key:
        return hit[1]
    with open(path, "rb") as f:
        data = f.read()
    _asset_cache[path] = (key, data)
    if len(_asset_cache) > 200:
        _asset_cache.clear()
        _asset_cache[path] = (key, data)
    return data


def safe_path(url_path):
    """把 URL 路径安全映射到 static/ 下的真实路径。

    必须用 realpath 做前缀比对：只检查 "../" 会被 URL 编码（%2e%2e%2f）
    和符号链接绕过。返回 None 表示拒绝。
    """
    rel = urllib.parse.unquote(url_path or "/").lstrip("/")
    if not rel:
        rel = "index.html"
    root = os.path.realpath(STATIC_DIR)
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


# ═════════════════════════════════════════════════════════════════════════
# 自有后端：认证 · 数据 · 邮件 · 短信
# --------------------------------------------------------------------------
# 从这一段开始，知更拥有完全属于自己的账号体系和数据存储：
#   · 登录/注册/找回 = 自己的用户表 + 自己的验证码，验证码邮件由知更自己发
#     （SMTP 走运营者自己的邮箱授权码，发件人显示「知更」，与平台无关）；
#   · 业务数据 = 本进程自己的 SQLite（对话/记忆/提案/反馈/设置/同步版本号），
#     每一行都带 user_id，按会话隔离 —— 平台在这里只剩「机房」的角色。
# 密钥边界（有意为之的变更）：SMTP 授权码是运营者的服务端凭据，只存在于
#   服务端配置（环境变量或 data/mail.json），永远不下发到浏览器。
# ═════════════════════════════════════════════════════════════════════════

DATA_DIR = os.path.join(HERE, "data")
DB_PATH = os.path.join(DATA_DIR, "zhigeng.db")
MAIL_CFG_PATH = os.path.join(DATA_DIR, "mail.json")
SMS_CFG_PATH = os.path.join(DATA_DIR, "sms.json")
LLM_CFG_PATH = os.path.join(DATA_DIR, "llm.json")

OTP_TTL = 10 * 60            # 验证码 10 分钟有效
OTP_RESEND_COOLDOWN = 60     # 同一目标 60 秒内只能发一次
OTP_HOURLY_LIMIT = 6
OTP_DAILY_LIMIT = 20
OTP_MAX_ATTEMPTS = 5
SESSION_TTL = 30 * 24 * 3600  # 会话 30 天

_db_lock = threading.RLock()
_db = None


def _iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def db():
    """全局 SQLite 连接 + 互斥锁。

    ThreadingHTTPServer 是多线程的，SQLite 连接不能跨线程并发使用；
    这里的量级（个位数用户）用「一把锁 + 单连接 + WAL」最稳，不需要连接池。
    """
    global _db
    with _db_lock:
        if _db is None:
            os.makedirs(DATA_DIR, exist_ok=True)
            _db = sqlite3.connect(DB_PATH, check_same_thread=False)
            _db.row_factory = sqlite3.Row
            _db.execute("PRAGMA journal_mode=WAL")
            _db.execute("PRAGMA synchronous=NORMAL")
            _db.execute("PRAGMA foreign_keys=ON")
        return _db


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  phone TEXT UNIQUE,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,          -- 邮箱或手机号（统一小写）
  channel TEXT NOT NULL,         -- 'email' | 'sms'
  purpose TEXT NOT NULL,         -- 'login' | 'reset'
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  round_count INTEGER DEFAULT 0,
  last_run_at TEXT,
  last_touch_at TEXT,
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  content TEXT,
  tier TEXT,
  base_weight REAL,
  lock INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  last_accessed TEXT,
  rescue_count INTEGER DEFAULT 0,
  rescue_base0 REAL,
  dormant INTEGER DEFAULT 0,
  archived_round INTEGER,
  final_weight REAL,
  rescued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  memory_id TEXT,
  title TEXT, body TEXT, action TEXT, kind TEXT,
  urgency REAL, relevance REAL, novelty REAL,
  actionability REAL, risk REAL, score REAL,
  touched INTEGER DEFAULT 0,
  reason TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  proposal_id TEXT,
  outcome TEXT, note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  touch_line REAL, quiet_start TEXT, quiet_end TEXT,
  notify_enabled INTEGER, custom_keywords TEXT, llm TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_conv ON memories(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_prop_conv ON proposals(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_fb_conv ON feedback(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_otp_target ON otp_codes(target, created_at);
"""


def init_store():
    with db() as conn:
        conn.executescript(SCHEMA)


def _row_dict(row):
    return dict(row) if row is not None else None


def _hash_password(password):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    return "scrypt$%s$%s" % (salt.hex(), h.hex())


def _check_password(password, stored):
    if not stored:
        return False
    try:
        _, salt_hex, h_hex = stored.split("$")
        h = hashlib.scrypt(password.encode("utf-8"),
                           salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1)
        return secrets.compare_digest(h.hex(), h_hex)
    except Exception:
        return False


def _hash_code(code, salt_hex):
    return hashlib.sha256((salt_hex + ":" + code).encode("utf-8")).hexdigest()

# ── 邮件 ─────────────────────────────────────────────────────────────────

def mail_config():
    """SMTP 配置：优先环境变量，其次 data/mail.json。都没有 = 尚未配置。"""
    env = {k: os.environ.get("ZG_SMTP_" + k) for k in ("HOST", "PORT", "USER", "PASS")}
    if all(env.values()):
        return {"host": env["HOST"], "port": int(env["PORT"]),
                "user": env["USER"], "pass": env["PASS"],
                "sender_name": os.environ.get("ZG_SMTP_SENDER_NAME", "知更")}
    try:
        with open(MAIL_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("host") and cfg.get("user") and cfg.get("pass"):
            cfg.setdefault("port", 465)
            cfg.setdefault("sender_name", "知更")
            cfg["port"] = int(cfg["port"])
            return cfg
    except Exception:
        pass
    return None


_OTP_MAIL_HTML = """<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1c1d21">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
    <div style="width:38px;height:38px;border-radius:11px;background:#0B0C0F;display:inline-flex;align-items:center;justify-content:center">
      <span style="color:#E5B961;font-size:20px;font-weight:700">知</span>
    </div>
    <div><div style="font-size:17px;font-weight:700">知更</div>
    <div style="font-size:12px;color:#8a8b90">替你想，该做什么</div></div>
  </div>
  <p style="font-size:15px;line-height:1.7;margin:0 0 18px">你的登录验证码是：</p>
  <div style="font-size:34px;font-weight:800;letter-spacing:10px;background:#f5f5f7;border-radius:12px;padding:18px 0;text-align:center;margin-bottom:18px">{code}</div>
  <p style="font-size:13px;color:#8a8b90;line-height:1.8;margin:0">10 分钟内有效。不是你本人操作的话，忽略这封邮件即可，账号不会受影响。</p>
</div>"""


def send_otp_mail(to, code):
    cfg = mail_config()
    if not cfg:
        raise RuntimeError("MAIL_NOT_CONFIGURED")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = Header("知更 · 登录验证码 %s" % code, "utf-8")
    msg["From"] = formataddr((str(Header(cfg.get("sender_name", "知更"), "utf-8")), cfg["user"]))
    msg["To"] = to
    msg.attach(MIMEText("你的知更登录验证码是 %s，10 分钟内有效。" % code, "plain", "utf-8"))
    msg.attach(MIMEText(_OTP_MAIL_HTML.replace("{code}", code), "html", "utf-8"))
    ctx = ssl.create_default_context()
    port = int(cfg.get("port") or 465)
    if port == 465:
        smtp = smtplib.SMTP_SSL(cfg["host"], port, timeout=15, context=ctx)
    else:
        smtp = smtplib.SMTP(cfg["host"], port, timeout=15)
        smtp.starttls(context=ctx)
    try:
        smtp.login(cfg["user"], cfg["pass"])
        smtp.sendmail(cfg["user"], [to], msg.as_string())
    finally:
        try:
            smtp.quit()
        except Exception:
            pass


# ── 验证码 ───────────────────────────────────────────────────────────────

def _otp_rate_check(target):
    now = time.time()
    conn = db()
    last = conn.execute(
        "SELECT created_at FROM otp_codes WHERE target=? ORDER BY created_at DESC LIMIT 1",
        (target,)).fetchone()
    if last:
        prev = datetime.strptime(last["created_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
        prev_ts = prev.replace(tzinfo=timezone.utc).timestamp()
        if now - prev_ts < OTP_RESEND_COOLDOWN:
            return "发送太频繁，请 1 分钟后再试。"
    hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    n = conn.execute("SELECT COUNT(*) c FROM otp_codes WHERE target=? AND created_at>?",
                     (target, hour_ago)).fetchone()["c"]
    if n >= OTP_HOURLY_LIMIT:
        return "今天的验证码发送次数太多了，请稍后再试。"
    day_ago = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    n = conn.execute("SELECT COUNT(*) c FROM otp_codes WHERE target=? AND created_at>?",
                     (target, day_ago)).fetchone()["c"]
    if n >= OTP_DAILY_LIMIT:
        return "今天的验证码发送次数已达上限，请明天再试。"
    return None


def create_otp(target, channel, purpose):
    """生成并持久化一个验证码。返回 (otp_id, 明文code, 限流错误)。"""
    limit_err = _otp_rate_check(target)
    if limit_err:
        return None, None, limit_err
    code = "%06d" % secrets.randbelow(1000000)
    otp_id = uuidlib.uuid4().hex
    salt = secrets.token_hex(8)
    conn = db()
    with conn:
        conn.execute(
            "INSERT INTO otp_codes (id,target,channel,purpose,code_hash,expires_at,created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (otp_id, target, channel, purpose,
             salt + "$" + _hash_code(code, salt),
             time.time() + OTP_TTL, _iso_now()))
    return otp_id, code, None


def consume_otp(otp_id, target, purpose, code):
    """校验并消费验证码。成功返回 True，失败返回中文错误。"""
    conn = db()
    row = _row_dict(conn.execute("SELECT * FROM otp_codes WHERE id=?", (otp_id,)).fetchone())
    if not row or row["target"] != target or row["purpose"] != purpose:
        return "验证码无效或已过期，请重新获取。"
    if row["consumed"]:
        return "验证码已被使用，请重新获取。"
    if time.time() > row["expires_at"]:
        return "验证码已过期，请重新获取。"
    if row["attempts"] >= OTP_MAX_ATTEMPTS:
        return "尝试次数过多，请重新获取验证码。"
    try:
        salt_hex, stored_hash = row["code_hash"].split("$", 1)
    except ValueError:
        return "验证码无效或已过期，请重新获取。"
    ok = secrets.compare_digest(_hash_code(code, salt_hex), stored_hash)
    with conn:
        if ok:
            conn.execute("UPDATE otp_codes SET consumed=1 WHERE id=?", (otp_id,))
        else:
            conn.execute("UPDATE otp_codes SET attempts=attempts+1 WHERE id=?", (otp_id,))
    return True if ok else "验证码不正确，请重新输入。"


# ── 会话 ─────────────────────────────────────────────────────────────────

def create_session(user_id):
    token = secrets.token_urlsafe(32)
    conn = db()
    with conn:
        conn.execute("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
                     (hashlib.sha256(token.encode()).hexdigest(), user_id,
                      time.time() + SESSION_TTL, _iso_now()))
    return token


def session_user(cookie_header):
    """从 Cookie 头解析会话。返回 (user_row, token) 或 (None, None)。"""
    if not cookie_header:
        return None, None
    token = None
    for part in cookie_header.split(";"):
        k, _, v = part.strip().partition("=")
        if k == "zg_session":
            token = v
            break
    if not token:
        return None, None
    th = hashlib.sha256(token.encode()).hexdigest()
    conn = db()
    row = conn.execute("SELECT s.user_id, s.expires_at, u.* FROM sessions s"
                       " JOIN users u ON u.id = s.user_id WHERE s.token_hash=?",
                       (th,)).fetchone()
    if not row or time.time() > row["expires_at"]:
        return None, None
    return dict(row), token


def drop_session(token):
    if not token:
        return
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash=?",
                     (hashlib.sha256(token.encode()).hexdigest(),))


def _set_cookie_header(token, delete=False):
    if delete:
        return "zg_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    return ("zg_session=%s; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=%d"
            % (token, SESSION_TTL))


# ── 用户 ─────────────────────────────────────────────────────────────────

def find_user_by_email(email):
    return _row_dict(db().execute("SELECT * FROM users WHERE email=?",
                                  (email.lower(),)).fetchone())


def find_user_by_phone(phone):
    return _row_dict(db().execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone())


def upsert_user_by_email(email, password=None):
    email = email.lower().strip()
    u = find_user_by_email(email)
    now = _iso_now()
    conn = db()
    if u:
        if password:
            with conn:
                conn.execute("UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
                             (_hash_password(password), now, u["id"]))
        return find_user_by_email(email)
    uid = uuidlib.uuid4().hex
    with conn:
        conn.execute("INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)",
                     (uid, email, _hash_password(password) if password else None, now, now))
    return find_user_by_email(email)


def public_user(u):
    if not u:
        return None
    return {"id": u["id"], "email": u.get("email"), "phone": u.get("phone")}


# ── 业务数据 RPC ─────────────────────────────────────────────────────────

def _json_dumps_col(v):
    if v is None or isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False)


def rpc_data(user_id, op, args):
    """前端 Cloud.data 的全部 18 个方法的私有实现。args 由前端路由层原样透传。"""
    conn = db()
    a = args or {}

    if op == "listConversations":
        rows = conn.execute(
            "SELECT * FROM conversations WHERE user_id=? AND COALESCE(archived,0)=0"
            " ORDER BY updated_at DESC", (user_id,)).fetchall()
        return [_row_dict(r) for r in rows]

    if op == "createConversation":
        cid = uuidlib.uuid4().hex
        now = _iso_now()
        with conn:
            conn.execute("INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
                         (cid, user_id, a.get("title") or "新对话", now, now))
        return _row_dict(conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone())

    if op == "updateConversation":
        allowed = ["title", "updated_at", "round_count", "last_run_at", "last_touch_at", "archived"]
        patch = a.get("patch") or {}
        sets, vals = [], []
        for k in allowed:
            if k in patch:
                sets.append(k + "=?")
                vals.append(patch[k])
        if sets:
            vals.append(user_id)
            vals.append(a["id"])
            with conn:
                conn.execute("UPDATE conversations SET %s WHERE user_id=? AND id=?" % ",".join(sets), vals)
        return _row_dict(conn.execute("SELECT * FROM conversations WHERE user_id=? AND id=?",
                                      (user_id, a["id"])).fetchone())

    if op == "deleteConversation":
        cid = a.get("id")
        with conn:
            conn.execute("DELETE FROM memories WHERE user_id=? AND conversation_id=?", (user_id, cid))
            conn.execute("DELETE FROM proposals WHERE user_id=? AND conversation_id=?", (user_id, cid))
            conn.execute("DELETE FROM feedback WHERE user_id=? AND conversation_id=?", (user_id, cid))
            conn.execute("DELETE FROM conversations WHERE user_id=? AND id=?", (user_id, cid))
        return True

    if op == "listMemories":
        if a.get("conversationId") is not None:
            rows = conn.execute("SELECT * FROM memories WHERE user_id=? AND conversation_id=?"
                                " ORDER BY created_at ASC", (user_id, a["conversationId"])).fetchall()
        else:
            rows = conn.execute("SELECT * FROM memories WHERE user_id=? AND conversation_id IS NULL"
                                " ORDER BY created_at ASC", (user_id,)).fetchall()
        return [_row_dict(r) for r in rows]

    if op == "adoptOrphans":
        cid = a.get("conversationId")
        with conn:
            m = conn.execute("UPDATE memories SET conversation_id=? WHERE user_id=? AND conversation_id IS NULL",
                             (cid, user_id)).rowcount
            p = conn.execute("UPDATE proposals SET conversation_id=? WHERE user_id=? AND conversation_id IS NULL",
                             (cid, user_id)).rowcount
        return {"memories": m, "proposals": p}

    if op == "insertMemories":
        out = []
        now = _iso_now()
        for m in (a.get("list") or []):
            mid = uuidlib.uuid4().hex
            with conn:
                conn.execute(
                    "INSERT INTO memories (id,user_id,conversation_id,content,tier,base_weight,lock,created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (mid, user_id, a.get("conversationId"), m.get("content"),
                     m.get("tier") or "normal",
                     0.6 if m.get("base_weight") is None else m.get("base_weight"),
                     1 if m.get("lock") else 0, now))
            out.append(_row_dict(conn.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()))
        return out

    if op == "updateMemory":
        allowed = ["content", "tier", "base_weight", "lock", "archived", "last_accessed",
                   "rescue_count", "rescue_base0", "dormant", "archived_round", "final_weight",
                   "rescued_at", "conversation_id"]
        sets, vals = [], []
        for k in allowed:
            if k in a["patch"]:
                sets.append(k + "=?")
                vals.append(a["patch"][k])
        if sets:
            vals.append(user_id)
            vals.append(a["id"])
            with conn:
                conn.execute("UPDATE memories SET %s WHERE user_id=? AND id=?" % ",".join(sets), vals)
        return _row_dict(conn.execute("SELECT * FROM memories WHERE user_id=? AND id=?",
                                      (user_id, a["id"])).fetchone())

    if op == "deleteMemory":
        with conn:
            conn.execute("DELETE FROM memories WHERE user_id=? AND id=?", (user_id, a.get("id")))
        return True

    if op == "listProposals":
        q = "SELECT * FROM proposals WHERE user_id=?"
        vals = [user_id]
        if a.get("conversationId") is not None:
            q += " AND conversation_id=?"
            vals.append(a["conversationId"])
        q += " ORDER BY created_at DESC LIMIT ?"
        vals.append(int(a.get("limit") or 200))
        return [_row_dict(r) for r in conn.execute(q, vals).fetchall()]

    if op == "insertProposal":
        pid = uuidlib.uuid4().hex
        now = _iso_now()
        with conn:
            conn.execute(
                "INSERT INTO proposals (id,user_id,conversation_id,memory_id,title,body,action,kind,"
                "urgency,relevance,novelty,actionability,risk,score,touched,reason,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (pid, user_id, a.get("conversation_id"), a.get("memory_id"),
                 a.get("title"), a.get("body"), a.get("action"), a.get("kind"),
                 a.get("urgency"), a.get("relevance"), a.get("novelty"),
                 a.get("actionability"), a.get("risk"), a.get("score"),
                 1 if a.get("touched") else 0, a.get("reason"), now, now))
        return _row_dict(conn.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone())

    if op == "updateProposal":
        allowed = ["outcome", "touched", "body", "action", "title"]
        sets, vals = [], []
        for k in allowed:
            if k in a["patch"]:
                sets.append(k + "=?")
                vals.append(a["patch"][k])
        if sets:
            vals.append(user_id)
            vals.append(a["id"])
            with conn:
                conn.execute("UPDATE proposals SET %s WHERE user_id=? AND id=?" % ",".join(sets), vals)
        return _row_dict(conn.execute("SELECT * FROM proposals WHERE user_id=? AND id=?",
                                      (user_id, a["id"])).fetchone())

    if op == "insertFeedback":
        fid = uuidlib.uuid4().hex
        with conn:
            conn.execute("INSERT INTO feedback (id,user_id,conversation_id,proposal_id,outcome,note,created_at)"
                         " VALUES (?,?,?,?,?,?,?)",
                         (fid, user_id, a.get("conversation_id"), a.get("proposal_id"),
                          a.get("outcome"), a.get("note"), _iso_now()))
        return _row_dict(conn.execute("SELECT * FROM feedback WHERE id=?", (fid,)).fetchone())

    if op == "listFeedback":
        q = "SELECT * FROM feedback WHERE user_id=?"
        vals = [user_id]
        if a.get("conversationId") is not None:
            q += " AND conversation_id=?"
            vals.append(a["conversationId"])
        q += " ORDER BY created_at DESC LIMIT ?"
        vals.append(int(a.get("limit") or 100))
        return [_row_dict(r) for r in conn.execute(q, vals).fetchall()]

    if op == "getSettings":
        row = _row_dict(conn.execute("SELECT * FROM user_settings WHERE user_id=?", (user_id,)).fetchone())
        if row and row.get("llm") and not isinstance(row["llm"], dict):
            try:
                row["llm"] = json.loads(row["llm"])
            except Exception:
                row["llm"] = None
        return row

    if op == "saveSettings":
        allowed = ["touch_line", "quiet_start", "quiet_end", "notify_enabled", "custom_keywords", "llm"]
        now = _iso_now()
        cur = conn.execute("SELECT user_id FROM user_settings WHERE user_id=?", (user_id,)).fetchone()
        if cur:
            sets, vals = [], []
            for k in allowed:
                if k in a:
                    sets.append(k + "=?")
                    vals.append(_json_dumps_col(a[k]))
            sets.append("updated_at=?")
            vals.append(now)
            vals.append(user_id)
            with conn:
                conn.execute("UPDATE user_settings SET %s WHERE user_id=?" % ",".join(sets), vals)
        else:
            cols = ["user_id"] + [k for k in allowed if k in a]
            vals = [user_id] + [_json_dumps_col(a[k]) for k in allowed if k in a]
            with conn:
                conn.execute("INSERT INTO user_settings (%s,created_at,updated_at) VALUES (%s,?,?)"
                             % (",".join(cols), ",".join("?" * len(cols))),
                             vals + [now, now])
        return rpc_data(user_id, "getSettings", {})

    if op == "getSyncState":
        return _row_dict(conn.execute("SELECT * FROM sync_state WHERE user_id=?", (user_id,)).fetchone())

    if op == "bumpSync":
        now = _iso_now()
        cur = conn.execute("SELECT revision FROM sync_state WHERE user_id=?", (user_id,)).fetchone()
        rev = int(cur["revision"] or 0) + 1 if cur else 1
        with conn:
            if cur:
                conn.execute("UPDATE sync_state SET revision=?, device=?, updated_at=? WHERE user_id=?",
                             (rev, a.get("device"), now, user_id))
            else:
                conn.execute("INSERT INTO sync_state (user_id,revision,device,updated_at) VALUES (?,?,?,?)",
                             (user_id, rev, a.get("device"), now))
        return _row_dict(conn.execute("SELECT * FROM sync_state WHERE user_id=?", (user_id,)).fetchone())

    raise ValueError("unknown op: %s" % op)


# ── 短信（框架已就绪，等短信服务开通后填 data/sms.json 即启用） ────────────

def sms_config():
    """短信服务商配置。支持阿里云（sign/template/ak/sk）。
    申请流程（需要）：域名备案 → 阿里云开通短信服务 → 申请签名「知更」+ 模板 → 拿到密钥。
    """
    try:
        with open(SMS_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("provider") and cfg.get("access_key_id") and cfg.get("access_key_secret") \
                and cfg.get("sign_name") and cfg.get("template_code"):
            return cfg
    except Exception:
        pass
    return None


def send_otp_sms(phone, code):
    """发短信。当前仅接入阿里云国内短信（HTTP API，无 SDK 依赖）。
    未配置时抛 SMS_NOT_CONFIGURED，由调用方转成友好的 501。"""
    cfg = sms_config()
    if not cfg:
        raise RuntimeError("SMS_NOT_CONFIGURED")
    if cfg["provider"] != "aliyun":
        raise RuntimeError("SMS_PROVIDER_UNSUPPORTED")
    import base64
    import hashlib as _h
    import hmac as _hmac

    # 阿里云短信 API（RPC 签名 v1.0）
    params = {
        "PhoneNumbers": phone,
        "SignName": cfg["sign_name"],
        "TemplateCode": cfg["template_code"],
        "TemplateParam": json.dumps({"code": code}, ensure_ascii=False),
        "AccessKeyId": cfg["access_key_id"],
        "Action": "SendSms",
        "Format": "JSON",
        "RegionId": cfg.get("region", "cn-hangzhou"),
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": uuidlib.uuid4().hex,
        "SignatureVersion": "1.0",
        "Version": "2017-05-25",
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    sorted_q = "&".join(
        "%s=%s" % (k, urllib.parse.quote(str(params[k]), safe="-_.~"))
        for k in sorted(params))
    string_to_sign = "GET&%2F&" + urllib.parse.quote(sorted_q, safe="-_.~")
    sig = base64.b64encode(_hmac.new(
        (cfg["access_key_secret"] + "&").encode(), string_to_sign.encode(), _h.sha1).digest()).decode()
    url = ("https://dysmsapi.aliyuncs.com/?" + sorted_q + "&Signature=" +
           urllib.parse.quote(sig, safe="-_.~"))
    req = urllib.request.Request(url, headers={"User-Agent": "zhigeng/1.0"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
        result = json.loads(resp.read(4096).decode("utf-8"))
    if result.get("Code") != "OK":
        raise RuntimeError("SMS_UPSTREAM_ERROR: %s %s" % (result.get("Code"), result.get("Message")))


def default_llm_config():
    """服务端默认大模型（可选）。用户没在设置里接自己的模型时，润色走这里。"""
    try:
        with open(LLM_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("base_url") and cfg.get("api_key"):
            cfg.setdefault("model", "deepseek-chat")
            return cfg
    except Exception:
        pass
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "AA"
    protocol_version = "HTTP/1.1"

    # ── 响应 helper ──────────────────────────────────────────────────
    def _is_https(self):
        """部署在 TLS 代理后面时靠 X-Forwarded-Proto 判断；直连 http 没有。"""
        return (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"

    def _headers(self, code, ctype, length, cache=None, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        if os.environ.get("ZG_NO_CSP") != "1" and self._is_https():
            # CSP 只在 HTTPS 上发。实测（2026-09-19）：WKWebView 在 http 明文源
            # 上收到这条 CSP 会让同源脚本随机双重执行/加载失败（黑屏），
            # 而线上 HTTPS + 同一 CSP 一直正常（旧版已验证数日）。
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; "
                "font-src 'self'; "
                "connect-src 'self' https: wss:; "
                "object-src 'none'; base-uri 'self'; form-action 'self'; "
                "frame-ancestors 'self'")
        self.send_header("Cache-Control", cache or "no-store, must-revalidate")
        self.end_headers()

    def _send(self, code, body, ctype="application/json; charset=utf-8", cache=None,
              extra_headers=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self._headers(code, ctype, len(data), cache, extra_headers)
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, code, obj, extra_headers=None):
        return self._send(code, json.dumps(obj, ensure_ascii=False),
                          extra_headers=extra_headers)

    def _json_body(self):
        """读 JSON 请求体。失败抛 ValueError，由各端点统一转 400。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > self.RELAY_LIMIT:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _serve_static(self, url_path, versioned=False):
        full = safe_path(url_path)
        if full is None:
            self._send(403, json.dumps({"error": "forbidden"}))
            return True   # ⚠️ 必须返回真值：_send 返回 None，若直接 return self._send(...)
        if not os.path.isfile(full):
            return None   # 交给调用方决定回退
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        try:
            data = _read_file(full)
        except OSError as e:
            self._send(500, json.dumps({"error": "read failed: %s" % e}))
            return True

        if ext == ".html":
            # 把构建指纹注入 HTML：资源 URL 上的 ?v=__AA_BUILD__ 换成真实值，
            # 同时塞一个 meta 供前端做版本比对。
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                self._send(500, json.dumps({"error": "index not utf-8"}))
                return True
            text = text.replace(BUILD_PLACEHOLDER, BUILD)
            data = text.encode("utf-8")
            cache = "no-store, must-revalidate"
        elif versioned:
            # 带指纹的资源：指纹变则 URL 变，可以放心永久缓存
            cache = "public, max-age=31536000, immutable"
        else:
            cache = "public, max-age=300"
        self._send(200, data, ctype, cache)
        return True

    # ── 路由 ─────────────────────────────────────────────────────────
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        versioned = "v" in query

        if path == "/healthz":
            return self._send(200, json.dumps({
                "ok": True, "boot": _state["boot_count"], "build": BUILD,
                "service": "aa"}))

        if path == "/api/version":
            return self._send(200, json.dumps({
                "build": BUILD,
                "boot": _state["boot_count"],
                "started_iso": _iso(_state.get("last_boot_ts")),
                "now_iso": _iso(_now()),
            }), cache="no-store, must-revalidate")

        if path == "/api/probe":
            with _lock:
                snap = json.loads(json.dumps(_state))
            now = _now()
            snap["now_iso"] = _iso(now)
            snap["build"] = BUILD
            snap["first_boot_iso"] = _iso(snap.get("first_boot_ts"))
            snap["last_boot_iso"] = _iso(snap.get("last_boot_ts"))
            snap["last_heartbeat_iso"] = _iso(snap.get("last_heartbeat_ts"))
            snap["prev_last_heartbeat_iso"] = _iso(snap.pop("prev_last_heartbeat_ts", None))
            snap["uptime_seconds"] = round(now - (snap.get("last_boot_ts") or now), 1)
            snap["since_first_boot_seconds"] = round(
                now - (snap.get("first_boot_ts") or now), 1)
            snap["heartbeat_age_seconds"] = (
                round(now - snap["last_heartbeat_ts"], 1)
                if snap.get("last_heartbeat_ts") else None)
            for d in snap.get("disk", {}).values():
                d["first_write_iso"] = _iso(d.get("first_write_ts"))
                d["last_write_iso"] = _iso(d.get("last_write_ts"))
            for s in snap.get("net", {}).values():
                s["last_ok_iso"] = _iso(s.get("last_ok_ts"))
            return self._send(200, json.dumps(snap, ensure_ascii=False))

        if path == "/api/auth/me":
            u, _tok = session_user(self.headers.get("Cookie"))
            if not u:
                return self._json(401, {"error": "未登录", "code": "unauthenticated"})
            return self._json(200, {"user": public_user(u)})

        # 静态资源（含 / → index.html）
        res = self._serve_static(path, versioned)
        if res is not None:
            return res

        # 未命中任何文件 → 交给前端路由（本项目是单页，回退到首页）
        if "." not in os.path.basename(path):
            res = self._serve_static("/index.html")
            if res is not None:
                return res

        return self._send(404, json.dumps({"error": "not found"}))

    def do_HEAD(self):
        return self.do_GET()

    # ── POST：目前只有一个用途 —— LLM 中继 ────────────────────────────
    # 用户接入自己的大模型 API（DeepSeek / Kimi / 智谱 / 任意 OpenAI 兼容端点）。
    # 为什么由本进程中继而不是浏览器直连：
    #   ① CORS —— 多数供应商不欢迎浏览器跨域直呼，直连必挂；
    #   ② 桌面壳 —— 知更.app 加载的是同源页面，中继对它同样成立。
    # 密钥永远只存在用户自己的设置里（user_settings.llm，RLS 隔离），
    # 本进程不存储任何密钥，只做当次转发 —— 与「进程不持有密钥」的边界一致。
    RELAY_LIMIT = 64 * 1024   # 请求体上限，防滥用

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path
        if p == "/api/llm":
            return self._relay_llm()
        if p in ("/api/auth/send-otp", "/api/auth/send-sms"):
            return self._auth_send_otp(p == "/api/auth/send-sms")
        if p == "/api/auth/verify-otp":
            return self._auth_verify_otp()
        if p == "/api/auth/verify-sms":
            return self._auth_verify_sms()
        if p == "/api/auth/login":
            return self._auth_login()
        if p == "/api/auth/logout":
            return self._auth_logout()
        if p == "/api/auth/reset":
            return self._auth_reset()
        if p == "/api/auth/change-password":
            return self._auth_change_password()
        if p == "/api/data":
            return self._api_data()
        return self._send(405, json.dumps({"error": "method not allowed"}))

    # ── 认证端点 ─────────────────────────────────────────────────────

    def _auth_send_otp(self, is_sms):
        try:
            body = self._json_body()
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        if is_sms:
            phone = str(body.get("phone") or "").strip()
            if not re.match(r"^1[3-9]\d{9}$", phone):
                return self._json(400, {"error": "请输入有效的 11 位手机号。",
                                        "code": "BAD_PHONE"})
            if not sms_config():
                return self._json(501, {
                    "error": "手机号登录还未开通：需要先完成短信签名申请（签名「知更」）。"
                             "界面已经准备好了，开通后立即可用。",
                    "code": "SMS_NOT_ENABLED"})
            otp_id, code, limit_err = create_otp(phone, "sms", "login")
            if limit_err:
                return self._json(429, {"error": limit_err, "code": "rate_limited"})
            try:
                send_otp_sms(phone, code)
            except RuntimeError as e:
                return self._json(502, {"error": "短信发送失败：%s" % e, "code": "sms_failed"})
            except Exception as e:
                return self._json(502, {"error": "短信发送失败：%s: %s"
                                        % (type(e).__name__, e), "code": "sms_failed"})
            return self._json(200, {"verificationId": otp_id,
                                    "isExistingUser": find_user_by_phone(phone) is not None})

        email = str(body.get("email") or "").strip().lower()
        purpose = "reset" if body.get("purpose") == "reset" else "login"
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            return self._json(400, {"error": "请输入有效的邮箱地址。", "code": "BAD_EMAIL"})
        otp_id, code, limit_err = create_otp(email, "email", purpose)
        if limit_err:
            return self._json(429, {"error": limit_err, "code": "rate_limited"})
        try:
            send_otp_mail(email, code)
        except RuntimeError:
            return self._json(503, {
                "error": "邮箱服务尚未配置：需要运营者在服务端填入 SMTP 授权码。",
                "code": "MAIL_NOT_CONFIGURED"})
        except Exception as e:
            return self._json(502, {"error": "验证码邮件发送失败：%s: %s"
                                    % (type(e).__name__, e), "code": "mail_failed"})
        return self._json(200, {"verificationId": otp_id,
                                "isExistingUser": find_user_by_email(email) is not None})

    def _auth_verify_otp(self):
        try:
            body = self._json_body()
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        email = str(body.get("email") or "").strip().lower()
        code = str(body.get("token") or "").strip()
        password = body.get("password") or None
        if not email or not code:
            return self._json(400, {"error": "缺少邮箱或验证码。"})
        if password and len(password) < 8:
            return self._json(400, {"error": "密码至少 8 位。", "code": "weak_password"})
        res = consume_otp(str(body.get("verificationId") or ""), email, "login", code)
        if res is not True:
            return self._json(400, {"error": res, "code": "invalid_code"})
        u = upsert_user_by_email(email, password)
        token = create_session(u["id"])
        return self._json(200, {"user": public_user(u)},
                          extra_headers=[("Set-Cookie", _set_cookie_header(token))])

    def _auth_verify_sms(self):
        try:
            body = self._json_body()
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        phone = str(body.get("phone") or "").strip()
        code = str(body.get("token") or "").strip()
        if not re.match(r"^1[3-9]\d{9}$", phone):
            return self._json(400, {"error": "请输入有效的 11 位手机号。"})
        if not sms_config():
            return self._json(501, {"error": "手机号登录还未开通。", "code": "SMS_NOT_ENABLED"})
        res = consume_otp(str(body.get("verificationId") or ""), phone, "login", code)
        if res is not True:
            return self._json(400, {"error": res, "code": "invalid_code"})
        conn = db()
        u = find_user_by_phone(phone)
        if not u:
            uid = uuidlib.uuid4().hex
            now = _iso_now()
            with conn:
                conn.execute("INSERT INTO users (id,phone,phone_verified,created_at,updated_at)"
                             " VALUES (?,?,1,?,?)", (uid, phone, now, now))
            u = find_user_by_phone(phone)
        token = create_session(u["id"])
        return self._json(200, {"user": public_user(u)},
                          extra_headers=[("Set-Cookie", _set_cookie_header(token))])

    def _auth_login(self):
        try:
            body = self._json_body()
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        email = str(body.get("email") or "").strip().lower()
        password = str(body.get("password") or "")
        u = find_user_by_email(email)
        # 统一错误文案：不区分「邮箱不存在」和「密码不对」，
        # 否则等于免费送一个「这个邮箱注册过没有」的探测器。
        if not u or not _check_password(password, u.get("password_hash")):
            return self._json(401, {"error": "邮箱或密码不正确。", "code": "invalid_grant"})
        token = create_session(u["id"])
        return self._json(200, {"user": public_user(u)},
                          extra_headers=[("Set-Cookie", _set_cookie_header(token))])

    def _auth_logout(self):
        _u, token = session_user(self.headers.get("Cookie"))
        drop_session(token)
        return self._json(200, {"ok": True},
                          extra_headers=[("Set-Cookie", _set_cookie_header(None, delete=True))])

    def _auth_reset(self):
        try:
            body = self._json_body()
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        email = str(body.get("email") or "").strip().lower()
        code = str(body.get("token") or "").strip()
        new_password = str(body.get("new_password") or "")
        if len(new_password) < 8:
            return self._json(400, {"error": "新密码至少 8 位。", "code": "weak_password"})
        res = consume_otp(str(body.get("verificationId") or ""), email, "reset", code)
        if res is not True:
            return self._json(400, {"error": res, "code": "invalid_code"})
        u = upsert_user_by_email(email, new_password)
        token = create_session(u["id"])
        return self._json(200, {"user": public_user(u)},
                          extra_headers=[("Set-Cookie", _set_cookie_header(token))])

    def _auth_change_password(self):
        try:
            body = self._json_body()
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        u, _tok = session_user(self.headers.get("Cookie"))
        if not u:
            return self._json(401, {"error": "未登录", "code": "unauthenticated"})
        old_p = str(body.get("old_password") or "")
        new_p = str(body.get("new_password") or "")
        if len(new_p) < 8:
            return self._json(400, {"error": "新密码至少 8 位。", "code": "weak_password"})
        # 纯验证码登录的账号可能从未设过密码：老密码留空即允许直接设置
        if u.get("password_hash") and not _check_password(old_p, u["password_hash"]):
            return self._json(401, {"error": "当前密码不正确。", "code": "invalid_grant"})
        with db() as conn:
            conn.execute("UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
                         (_hash_password(new_p), _iso_now(), u["id"]))
        return self._json(200, {"ok": True})

    # ── 业务数据 RPC ─────────────────────────────────────────────────

    def _api_data(self):
        u, _tok = session_user(self.headers.get("Cookie"))
        if not u:
            return self._json(401, {"error": "未登录", "code": "unauthenticated"})
        try:
            body = self._json_body()
            op = str(body.get("op") or "")
            out = rpc_data(u["id"], op, body.get("args") or {})
            return self._json(200, {"ok": True, "data": out})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def _relay_llm(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > self.RELAY_LIMIT:
                return self._send(413, json.dumps({"error": "request body too large"}))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            return self._send(400, json.dumps({"error": "bad request: %s" % e}))

        base = str(payload.get("base_url") or "").strip()
        key = str(payload.get("api_key") or "").strip()
        messages = payload.get("messages") or []

        # 用户没接自己的模型 → 落到服务端默认配置（可选，data/llm.json）。
        # 都没有时明确报错，引导去设置页接入。
        if not base or not key:
            dflt = default_llm_config()
            if not dflt:
                return self._send(400, json.dumps(
                    {"error": "还没有接入大模型：请在设置里填入你自己的 API Key。"},
                    ensure_ascii=False))
            base, key = dflt["base_url"], dflt["api_key"]
            if not payload.get("model"):
                payload["model"] = dflt.get("model") or "deepseek-chat"

        if not re.match(r"^https://[A-Za-z0-9.\-]+", base):
            return self._send(400, json.dumps({"error": "base_url 必须是 https 地址"}))
        if not key or not messages:
            return self._send(400, json.dumps({"error": "缺少 api_key 或 messages"}))

        upstream = base.rstrip("/") + "/chat/completions"
        body = json.dumps({
            "model": str(payload.get("model") or "deepseek-chat"),
            "messages": messages,
            "stream": False,
        }).encode("utf-8")
        req = urllib.request.Request(upstream, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        })
        ctx = ssl.create_default_context()
        try:
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                data = resp.read(512 * 1024)
                return self._send(resp.status, data)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(500).decode("utf-8", "replace")
            except Exception:
                pass
            return self._send(e.code, json.dumps(
                {"error": "upstream HTTP %d" % e.code, "detail": detail},
                ensure_ascii=False))
        except Exception as e:
            return self._send(502, json.dumps({"error": "%s: %s" % (type(e).__name__, e)}))

    def log_message(self, fmt, *args):
        # 只在真正的错误上出声，正常运行不打日志（避免噪声淹没探针输出）
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write("[aa] %s %s\n" % (self.address_string(), fmt % args))


def main():
    boot()
    try:
        init_store()
        print("[aa] own store ready: %s" % DB_PATH, flush=True)
    except Exception as e:
        print("[aa] store init FAILED: %s" % e, flush=True)
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=net_loop, daemon=True).start()

    port = int(os.environ.get("PORT", "8080"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    # 首屏 10 个资源并发拉取，默认 backlog(5) 会拒连接 → 客户端重试 →
    # 脚本被双重执行（实测表现为随机「duplicate variable」黑屏）。
    srv.request_queue_size = 128
    srv.daemon_threads = True
    print("[aa] build=%s listening on 0.0.0.0:%d  static=%s"
          % (BUILD, port, STATIC_DIR), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
