"""故障面矩阵测试：GET/POST × 各端点。"""
import json
import os
import urllib.error
import urllib.request

BASE = "https://aa-agent.app.workbuddy.host"


def req(method, path, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, timeout=12) as resp:
            return resp.status, (resp.read().decode() or "")[:120]
    except urllib.error.HTTPError as e:
        return e.code, (e.read().decode() or "")[:120]
    except Exception as e:
        return 0, str(e)[:120]


cases = [
    ("GET", "/api/version", None),
    ("GET", "/cloud.js", None),
    ("GET", "/api/auth/me", None),
    ("POST", "/api/auth/send-otp", {"email": "matrix@test.com"}),
    ("POST", "/api/auth/login", {"email": "3959624468@qq.com", "password": os.environ.get("ZG_TEST_PASS", "")}),
    ("POST", "/api/data", {"op": "getSettings", "args": {}}),
]
for m, p, b in cases:
    st, body = req(m, p, b)
    print("%-4s %-22s -> %s | %s" % (m, p, st, body.replace("\n", " ")))
