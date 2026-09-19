# -*- coding: utf-8 -*-
"""知更自有后端 · 本地全链路自测（不依赖真实 SMTP）。

验证码邮件这步在本地用「直接调 create_otp 拿明文码」绕过发信，
其余全部走真实 HTTP（localhost:8123），覆盖：
  send-otp 未配置→503 / verify-otp→会话 / me / login / 改密 / 登出
  /api/data 全部 18 个 op / SMS 未开通→501
"""
import json
import sys
import urllib.request
import http.cookiejar

BASE = "http://127.0.0.1:8132"
sys.path.insert(0, "/Users/a1234/WorkBuddy/2026-09-18-19-49-41/aa-cloud")
import server  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    ok = name not in [f for f in FAIL]
    (PASS if cond else FAIL).append(name + ("" if cond else " | " + str(detail)))
    print(("✅" if cond else "❌") + " " + name + ("" if cond else "  -> " + str(detail)))


def req(method, path, body=None, cookie=None):
    r = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
        r.data = json.dumps(body).encode()
    if cookie:
        r.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}"), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}"), e.headers


jar_cookie = [None]

# 0. 清空验证码表，保证限流测试从干净状态开始
server.db().execute("DELETE FROM otp_codes")
server.db().commit()

# 1. send-otp 未配置 SMTP → 503 MAIL_NOT_CONFIGURED
st, j, _ = req("POST", "/api/auth/send-otp", {"email": "test@example.com"})
check("send-otp 未配置→503", st == 503 and j.get("code") == "MAIL_NOT_CONFIGURED", (st, j))

# 2. send-sms 未开通 → 501 SMS_NOT_ENABLED
st, j, _ = req("POST", "/api/auth/send-sms", {"phone": "13800138000"})
check("send-sms 未开通→501", st == 501 and j.get("code") == "SMS_NOT_ENABLED", (st, j))

# 3. 直接造一个验证码（绕过发信），走真实 verify-otp
#    注意：步骤 1 的 send-otp 即使发信失败也会落一条验证码记录（占冷却），
#    所以这里先清一次再用不同的邮箱，避免撞 60s 冷却。
server.db().execute("DELETE FROM otp_codes")
server.db().commit()
otp_id, code, err = server.create_otp("zhigeng-test@example.com", "email", "login")
check("create_otp 生成", otp_id is not None and len(code) == 6, err)
st, j, h = req("POST", "/api/auth/verify-otp",
               {"verificationId": otp_id, "token": code, "email": "zhigeng-test@example.com",
                "password": "zhigeng-pass-1"})
sc = h.get("Set-Cookie") or ""
jar_cookie[0] = sc.split(";")[0] if sc else None
check("verify-otp 建号+会话", st == 200 and j.get("user", {}).get("email") == "zhigeng-test@example.com"
      and jar_cookie[0] and jar_cookie[0].startswith("zg_session="), (st, j, sc))

CK = jar_cookie[0]

# 4. me
st, j, _ = req("GET", "/api/auth/me", cookie=CK)
check("me 返回用户", st == 200 and j.get("user", {}).get("email") == "zhigeng-test@example.com", (st, j))

# 5. 重复验证码已被消费
st, j, _ = req("POST", "/api/auth/verify-otp",
               {"verificationId": otp_id, "token": code, "email": "test@example.com"})
check("验证码一次性", st == 400, (st, j))

# 6. 密码登录
st, j, h2 = req("POST", "/api/auth/login",
                {"email": "zhigeng-test@example.com", "password": "zhigeng-pass-1"})
check("密码登录", st == 200 and j.get("user", {}).get("id"), (st, j))
st, j, _ = req("POST", "/api/auth/login",
               {"email": "zhigeng-test@example.com", "password": "wrong-pass-xx"})
check("错误密码→401 统一文案", st == 401 and j.get("code") == "invalid_grant", (st, j))

# 7. 数据 RPC 全量
def rpc(op, args=None):
    st, j, _ = req("POST", "/api/data", {"op": op, "args": args or {}}, cookie=CK)
    return st, (j.get("data") if isinstance(j, dict) else None), j

st, d, _ = rpc("createConversation", {"title": "主要想法"})
cid = d.get("id")
check("createConversation", st == 200 and cid, (st, d))

st, d, _ = rpc("insertMemories", {"list": [
    {"content": "测试记忆A", "tier": "normal", "base_weight": 0.6, "lock": False},
    {"content": "测试记忆B", "tier": "locked", "lock": True}], "conversationId": cid})
check("insertMemories", st == 200 and len(d) == 2 and d[0].get("id"), (st, d))
mem_id = d[0]["id"]

st, d, _ = rpc("listMemories", {"conversationId": cid})
check("listMemories", st == 200 and len(d) == 2, (st, len(d) if isinstance(d, list) else d))

st, d, _ = rpc("updateMemory", {"id": mem_id, "patch": {"base_weight": 0.9, "lock": True}})
check("updateMemory", st == 200 and d and d.get("base_weight") == 0.9, (st, d))

st, d, _ = rpc("adoptOrphans", {"conversationId": cid})
check("adoptOrphans", st == 200 and d.get("memories") == 0, (st, d))

st, d, _ = rpc("insertProposal", {
    "title": "测试提案", "body": "正文", "urgency": 0.5, "relevance": 0.6,
    "novelty": 0.4, "actionability": 0.7, "risk": 0.1, "score": 62,
    "touched": True, "reason": "测试", "conversation_id": cid})
prop_id = d.get("id")
check("insertProposal", st == 200 and prop_id, (st, d))

st, d, _ = rpc("updateProposal", {"id": prop_id, "patch": {"outcome": "done", "body": "改过"}})
check("updateProposal", st == 200 and d.get("outcome") == "done", (st, d))

st, d, _ = rpc("listProposals", {"conversationId": cid, "limit": 10})
check("listProposals", st == 200 and len(d) == 1, (st, d))

st, d, _ = rpc("insertFeedback", {"proposal_id": prop_id, "outcome": "good",
                                  "note": "n", "conversation_id": cid})
check("insertFeedback", st == 200 and d.get("id"), (st, d))

st, d, _ = rpc("listFeedback", {"conversationId": cid, "limit": 5})
check("listFeedback", st == 200 and len(d) == 1, (st, d))

st, d, _ = rpc("getSettings", {})
check("getSettings 空", st == 200 and d is None, (st, d))

st, d, _ = rpc("saveSettings", {"touch_line": 60, "quiet_start": 22, "quiet_end": 8,
                                "notify_enabled": True, "custom_keywords": "",
                                "llm": {"baseUrl": "https://api.deepseek.com/v1",
                                        "apiKey": "sk-test", "model": "deepseek-chat"}})
check("saveSettings 建行+llm 对象", st == 200 and isinstance(d.get("llm"), dict)
      and d.get("touch_line") == 60, (st, d))

st, d, _ = rpc("getSettings", {})
check("getSettings 回读 llm 对象", st == 200 and isinstance(d.get("llm"), dict), (st, d))

st, d, _ = rpc("updateConversation", {"id": cid, "patch": {"round_count": 3, "title": "改名"}})
check("updateConversation", st == 200 and d.get("round_count") == 3, (st, d))

st, d, _ = rpc("listConversations", {})
check("listConversations", st == 200 and len(d) == 1, (st, d))

st, d, _ = rpc("bumpSync", {"device": "test-mac"})
check("bumpSync rev=1", st == 200 and d.get("revision") == 1, (st, d))
st, d, _ = rpc("getSyncState", {})
check("getSyncState", st == 200 and d.get("revision") == 1, (st, d))

# 8. 未登录访问数据 → 401
st, j, _ = req("POST", "/api/data", {"op": "listConversations", "args": {}})
check("未登录 /api/data→401", st == 401, (st, j))

# 9. 改密码 + 新密码登录
st, j, _ = req("POST", "/api/auth/change-password",
               {"old_password": "zhigeng-pass-1", "new_password": "zhigeng-pass-2"}, cookie=CK)
check("change-password", st == 200, (st, j))
st, j, _ = req("POST", "/api/auth/login",
               {"email": "zhigeng-test@example.com", "password": "zhigeng-pass-2"})
check("新密码可登录", st == 200, (st, j))

# 10. 找回密码链路（先清验证码表，避开步骤 3 留下的 60s 冷却）
server.db().execute("DELETE FROM otp_codes")
server.db().commit()
otp_id, code, err = server.create_otp("zhigeng-test@example.com", "email", "reset")
check("reset 验证码生成", otp_id is not None, err)
st, j, _ = req("POST", "/api/auth/reset",
               {"verificationId": otp_id, "token": code, "email": "zhigeng-test@example.com",
                "new_password": "zhigeng-pass-3"})
check("reset 完成并登录", st == 200, (st, j))

# 11. 登出
st, j, h = req("POST", "/api/auth/logout", {}, cookie=CK)
check("logout", st == 200, (st, j))
st, j, _ = req("GET", "/api/auth/me", cookie=CK)
check("logout 后 me→401", st == 401, (st, j))

# 12. 删对话级联
st, j, h = req("POST", "/api/auth/login",
               {"email": "zhigeng-test@example.com", "password": "zhigeng-pass-3"})
sc = h.get("Set-Cookie") or ""
CK = sc.split(";")[0]
check("reset 后新密码可登录", st == 200 and CK, (st, j))
st, d, _ = rpc("deleteConversation", {"id": cid})
st, d, _ = rpc("listMemories", {"conversationId": cid})
check("删对话级联清空记忆", st == 200 and isinstance(d, list) and len(d) == 0, (st, d))
st, d, _ = rpc("listProposals", {"conversationId": cid, "limit": 10})
check("删对话级联清空提案", st == 200 and len(d) == 0, (st, d))

# 13. 验证码限流（连发触发 60s 冷却）
server.db().execute("DELETE FROM otp_codes")
server.db().commit()
otp_id, code, err = server.create_otp("rl@example.com", "email", "login")
check("第一次发送成功", otp_id is not None, err)
otp_id2, _, err2 = server.create_otp("rl@example.com", "email", "login")
check("60s 冷却生效", otp_id2 is None and "频繁" in (err2 or ""), err2)

print("\n──── %d 通过 / %d 失败 ────" % (len(PASS), len(FAIL)))
if FAIL:
    print("失败项:", *FAIL, sep="\n  ")
    sys.exit(1)
