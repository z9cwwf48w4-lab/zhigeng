#!/usr/bin/env python3
"""按 enterApp 的真实调用序列逐个打线上接口，定位挂起/报错的那一步。"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = os.environ.get("ZG_BASE", "https://aa-agent.app.workbuddy.host")
EMAIL = os.environ.get("ZG_TEST_EMAIL", "3959624468@qq.com")
PASS = os.environ.get("ZG_TEST_PASS", "")


def req(method, path, body=None, cookie=None, timeout=20):
    r = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
        r.data = json.dumps(body).encode()
    if cookie:
        r.add_header("Cookie", cookie)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            dt = time.time() - t0
            return resp.status, resp.read().decode()[:260], dt, resp.headers
    except urllib.error.HTTPError as e:
        dt = time.time() - t0
        return e.code, e.read().decode()[:260], dt, e.headers
    except Exception as e:
        dt = time.time() - t0
        return -1, "%s: %s" % (type(e).__name__, e), dt, None


def show(name, res):
    st, body, dt, _ = res
    flag = "✅" if 200 <= st < 300 else "❌"
    print("%s %-34s HTTP %-4s %5.2fs  %s" % (flag, name, st, dt, body[:160].replace("\n", " ")))


st, body, dt, h = req("POST", "/api/auth/login",
                      {"email": EMAIL, "password": PASS})
show("POST /api/auth/login", (st, body, dt, h))
sc = h.get("Set-Cookie") or ""
CK = sc.split(";")[0] if sc else None
print("   cookie:", "有" if CK else "无")

# enterApp 里 enterApp 之后的所有数据调用
seq = [
    ("GET  /api/auth/me (user)", "GET", "/api/auth/me", None),
    ("POST /api/data listConversations", "POST", "/api/data", {"op": "listConversations", "args": {}}),
    ("POST /api/data saveSettings", "POST", "/api/data",
     {"op": "saveSettings", "args": {"touch_line": 60, "quiet_start": 22, "quiet_end": 8,
                                      "notify_enabled": True, "custom_keywords": ""}}),
    ("POST /api/data listMemories", "POST", "/api/data",
     {"op": "listMemories", "args": {"conversationId": None}}),
    ("POST /api/data listProposals", "POST", "/api/data",
     {"op": "listProposals", "args": {"conversationId": None, "limit": 200}}),
    ("POST /api/data getSyncState", "POST", "/api/data", {"op": "getSyncState", "args": {}}),
]
for name, m, p, b in seq:
    show(name, req(m, p, b, cookie=CK, timeout=25))
