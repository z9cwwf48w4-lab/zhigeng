"""API 路由。全部 JSON（对话是 SSE 流），单用户无鉴权——它就是用户自己的应用。

GET  /api/state                  知更此刻状态 + 未读（顺带检查该不该主动开口）
GET  /api/messages?after=N       增量拉对话
POST /api/chat {content}         说话 → SSE 流式回复，完步入库
GET/POST /api/profile            关于你
GET/POST/DELETE /api/memories    它在意的
"""
import json
import time
from urllib.parse import urlparse, parse_qs

from . import db as dbm
from . import llm, persona, proactive


def _json(handler, obj, status=200):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler):
    n = int(handler.headers.get("Content-Length") or 0)
    if n <= 0 or n > 1 << 20:
        return {}
    try:
        return json.loads(handler.rfile.read(n).decode("utf-8"))
    except ValueError:
        return {}


def _msg_dict(r):
    return {"id": r["id"], "role": r["role"], "content": r["content"],
            "ts": r["ts"], "proactive": r["proactive"]}


# ---- GET /api/state -------------------------------------------------------

def get_state(handler):
    db = dbm
    # 心跳顺带触发主动开口检查（有副作用的 GET，换来的是零线程的简单）
    try:
        proactive.fire(db)
    except Exception:
        pass  # 主动开口失败绝不影响状态返回
    from . import mood
    st = mood.now(db)
    unread = int(dbm.kv_get("unread", "0") or 0)
    _json(handler, {
        "mood": {k: st[k] for k in ("feel", "gap_txt", "chats", "mem_n", "late")},
        "unread": unread,
        "persona": persona.persona(db),
        "now": int(time.time() * 1000),
    })


# ---- GET /api/messages ----------------------------------------------------

def get_messages(handler):
    qs = parse_qs(urlparse(handler.path).query)
    after = int(qs.get("after", ["0"])[0] or 0)
    rows = dbm.q("SELECT * FROM messages WHERE id>? ORDER BY id LIMIT 200",
                 (after,))
    _json(handler, {"messages": [_msg_dict(r) for r in rows]})


# ---- POST /api/chat（SSE 流式）--------------------------------------------

def post_chat(handler, body):
    content = (body.get("content") or "").strip()
    if not content:
        return _json(handler, {"error": "内容不能为空"}, 400)
    if len(content) > 4000:
        content = content[:4000]

    db = dbm
    ts = int(time.time() * 1000)
    db.run("INSERT INTO messages(role,content,ts) VALUES('user',?,?)",
           (content, ts))
    dbm.kv_set("unread", "0")  # 用户开口了，未读清零

    sys = persona.system_prompt(db)
    msgs = [{"role": "system", "content": sys}] + persona.context_messages(db)

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()

    def emit(event, data):
        handler.wfile.write(
            ("event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False)))
            .encode("utf-8"))

    full = []
    try:
        for piece in llm.stream(msgs):
            full.append(piece)
            emit("delta", {"t": piece})
            handler.wfile.flush()
    except llm.LLMError as e:
        if full:
            emit("error", {"message": "（说到一半断了，见谅）"})
        else:
            emit("error", {"message": str(e)})
        handler.wfile.flush()
    text = "".join(full).strip()
    if text:
        db.run("INSERT INTO messages(role,content,ts) VALUES('assistant',?,?)",
               (text, int(time.time() * 1000)))
    emit("done", {"id": None, "len": len(text)})
    handler.wfile.flush()


# ---- /api/profile ----------------------------------------------------------

def get_profile(handler):
    _json(handler, {"persona": persona.persona(dbm)})


def post_profile(handler, body):
    db = dbm
    for k in ("name", "about"):
        if k in body:
            db.profile_set(k, str(body.get(k) or "").strip()[:500])
    _json(handler, {"ok": True, "persona": persona.persona(db)})


# ---- /api/memories ---------------------------------------------------------

def get_memories(handler):
    rows = dbm.q("SELECT * FROM memories WHERE archived=0 ORDER BY id DESC")
    _json(handler, {"memories": [
        {"id": r["id"], "content": r["content"], "created_at": r["created_at"]}
        for r in rows]})


def post_memories(handler, body):
    content = (body.get("content") or "").strip()
    if not content:
        return _json(handler, {"error": "内容不能为空"}, 400)
    cur = dbm.run("INSERT INTO memories(content,created_at) VALUES(?,?)",
                  (content[:300], int(time.time() * 1000)))
    _json(handler, {"ok": True, "id": cur.lastrowid})


def delete_memory(handler, mid):
    dbm.run("UPDATE memories SET archived=1 WHERE id=?", (mid,))
    _json(handler, {"ok": True})


# ---- 分发 ------------------------------------------------------------------

ROUTES_GET = {
    "/api/state": get_state,
    "/api/messages": get_messages,
    "/api/profile": get_profile,
    "/api/memories": get_memories,
}

ROUTES_POST = {
    "/api/chat": post_chat,
    "/api/profile": post_profile,
    "/api/memories": post_memories,
}


def dispatch_get(handler, path):
    fn = ROUTES_GET.get(path)
    if not fn:
        return _json(handler, {"error": "not found"}, 404)
    fn(handler)


def dispatch_post(handler, path):
    fn = ROUTES_POST.get(path)
    if not fn:
        return _json(handler, {"error": "not found"}, 404)
    fn(handler, _read_body(handler))


def dispatch_delete(handler, path):
    # /api/memories/123
    parts = path.rstrip("/").split("/")
    if len(parts) == 4 and parts[2] == "memories" and parts[3].isdigit():
        return delete_memory(handler, int(parts[3]))
    _json(handler, {"error": "not found"}, 404)
