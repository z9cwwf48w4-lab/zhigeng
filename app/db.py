"""SQLite 访问层。单用户应用：一个库文件，四张表，够用。

messages  对话历史（服务端权威，多设备打开看到的都是同一段对话）
memories  「它在意的」——知更该记住惦记的事
profile   关于你（称呼/介绍/邮箱）
kv        杂项状态（主动开口节流等）
"""
import os
import sqlite3
import threading

from . import config

_local = threading.local()
_schema = """
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,            -- user | assistant
  content TEXT NOT NULL,
  ts INTEGER NOT NULL,           -- 毫秒时间戳
  proactive INTEGER DEFAULT 0    -- 1 = 知更先开口的
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


def conn():
    """每线程一个连接（http.server 是多线程的），WAL 模式。连接不关闭——进程活多久它活多久。"""
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(config.DB_PATH, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=5000")
        _local.conn = c
    return c


def init():
    config.ensure_dirs()
    conn().executescript(_schema)
    conn().commit()


def q(sql, args=()):
    return conn().execute(sql, args).fetchall()


def one(sql, args=()):
    return conn().execute(sql, args).fetchone()


def run(sql, args=()):
    cur = conn().execute(sql, args)
    conn().commit()
    return cur


# ---- profile / kv 小工具 -------------------------------------------------

def profile_get(key, default=None):
    r = one("SELECT value FROM profile WHERE key=?", (key,))
    return r["value"] if r else default


def profile_set(key, value):
    run("INSERT INTO profile(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def kv_get(key, default=None):
    r = one("SELECT value FROM kv WHERE key=?", (key,))
    return r["value"] if r else default


def kv_set(key, value):
    run("INSERT INTO kv(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
