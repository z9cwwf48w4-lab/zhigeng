"""主动开口：知更的本分，不是彩蛋。

触发点在 GET /api/state（前端心跳），条件三重：
- 距最后一条消息 ≥ PROACTIVE_TALK_GAP
- 距上次主动开口 ≥ PROACTIVE_GAP
- 今天主动次数 < PROACTIVE_DAILY
生成失败落模板兜底，保证「它先开口」永远能落地。
"""
import json
import time

from . import db as dbm
from . import llm, persona

PROACTIVE_TALK_GAP = 4 * 3600 * 1000   # 距上次任何对话
PROACTIVE_GAP = 4 * 3600 * 1000        # 两次主动之间
PROACTIVE_DAILY = 2

_TPL_MEM = "有一阵子没聊了——%s。你记的那句「%s」，最近有进展吗？"
_TPL_PLAIN = "又见面了。隔了%s，最近怎么样？"


def _state():
    return json.loads(dbm.kv_get("proactive", "{}") or "{}")


def _save(st):
    dbm.kv_set("proactive", json.dumps(st))


def _gap_txt(ms):
    h = ms / 3600000
    if h >= 24:
        return "%d 天" % round(h / 24)
    return "%d 个小时" % max(1, round(h))


def due(db):
    """该不该主动开口。"""
    now_ms = time.time() * 1000
    last = db.one("SELECT MAX(ts) AS t FROM messages")
    last_ts = last["t"] or 0
    if last_ts and now_ms - last_ts < PROACTIVE_TALK_GAP:
        return False
    st = _state()
    today = time.strftime("%Y-%m-%d")
    if st.get("day") != today:
        st = {"day": today, "count": 0}
    if st.get("count", 0) >= PROACTIVE_DAILY:
        return False
    if st.get("last_at") and now_ms - st["last_at"] < PROACTIVE_GAP:
        return False
    return True


def _compose(db):
    sys = persona.system_prompt(db) + (
        "\n\n现在的情况：你有一阵子没跟用户说话了，你来主动开一次口。"
        "一到两句话，像熟人随口搭话——从时间、你在意的事、或上次的话题接下去，"
        "或者问他最近怎么样。禁止「有什么可以帮你的吗」这类客服话术。"
        "直接输出要说的话。")
    recent = db.q("SELECT role, content FROM messages "
                  "ORDER BY id DESC LIMIT 4")
    msgs = [{"role": "system", "content": sys}]
    if recent:
        frag = "\n".join(("用户：" if r["role"] == "user" else "知更：") +
                         r["content"][:60] for r in reversed(recent))
        msgs.append({"role": "user",
                     "content": "（最近聊过的片段，供参考，不必逐条回应）\n" + frag})
    try:
        txt = llm.complete(msgs, max_tokens=200)
        if txt:
            return txt[:300]
    except llm.LLMError:
        pass
    # 兜底：没有模型也保证主动开口能落地
    m = db.one("SELECT content FROM memories WHERE archived=0 "
               "ORDER BY id DESC LIMIT 1")
    last = db.one("SELECT MAX(ts) AS t FROM messages")
    gap = _gap_txt(time.time() * 1000 - last["t"]) if last["t"] else "一阵子"
    if m:
        return _TPL_MEM % (gap, m["content"][:24])
    return _TPL_PLAIN % gap


def fire(db):
    """生成一句主动开口，入库。返回消息 dict 或 None。"""
    if not due(db):
        return None
    txt = _compose(db)
    ts = int(time.time() * 1000)
    cur = db.run("INSERT INTO messages(role,content,ts,proactive) "
                 "VALUES('assistant',?,?,1)", (txt, ts))
    st = _state()
    today = time.strftime("%Y-%m-%d")
    if st.get("day") != today:
        st = {"day": today, "count": 0}
    st["count"] = st.get("count", 0) + 1
    st["last_at"] = ts
    _save(st)
    return {"id": cur.lastrowid, "role": "assistant", "content": txt,
            "ts": ts, "proactive": 1}
