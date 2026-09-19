"""线上实测：预置账号密码登录 / 会话校验 / 错误密码防御。"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = "https://aa-agent.app.workbuddy.host"


def req(method, path, body=None, cookie=None):
    r = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
        r.data = json.dumps(body).encode()
    if cookie:
        r.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            raw = resp.read().decode() or "{}"
            try:
                return resp.status, json.loads(raw), resp.headers
            except ValueError:
                return resp.status, {"_raw": raw[:200]}, resp.headers
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or "{}"
        try:
            return e.code, json.loads(raw), e.headers
        except ValueError:
            return e.code, {"_raw": raw[:200]}, e.headers
    except Exception as e:
        return 0, {"_err": str(e)}, None


def retry(method, path, body=None, want=200, tries=5, gap=4):
    for i in range(tries):
        st, j, h = req(method, path, body)
        if st == want:
            return st, j, h
        print("  第 %d 次: %s %s" % (i + 1, st, j))
        time.sleep(gap)
    return st, j, h


st, j, h = retry("POST", "/api/auth/login",
                 {"email": "3959624468@qq.com", "password": os.environ.get("ZG_TEST_PASS", "")})
print("密码登录:", st, "->", j.get("user", {}).get("email") if st == 200 else j)
sc = (h.get("Set-Cookie") if h else "") or ""
ck = sc.split(";")[0] if sc else None
print("会话Cookie:", "已签发 ✅" if ck and ck.startswith("zg_session=") else "❌ 未签发")

if st == 200:
    st2, j2, _ = req("GET", "/api/auth/me", cookie=ck)
    print("会话校验 /me:", st2, "->", j2.get("user", {}).get("email") if st2 == 200 else j2)

st3, j3, _ = req("POST", "/api/auth/login",
                 {"email": "3959624468@qq.com", "password": "wrong-pass"})
print("错误密码防御:", st3, "->", j3)
