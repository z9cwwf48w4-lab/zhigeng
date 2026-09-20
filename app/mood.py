"""感受引擎：知更此刻的状态。纯函数，从 DB 推导，无自己的存储。

时间感是它的体感来源：多久没聊、聊过多少、现在几点——
推导出一个状态词，注入它说话的语气，也展示在界面上。
"""
import time

# 状态词要能接在「它」后面：它很想你 / 它陪你熬夜 …


def now(db):
    """返回 {feel, gap_txt, gap_h, chats, mem_n, late}"""
    row = db.one(
        "SELECT MAX(ts) AS last_ts, COUNT(*) AS n FROM messages")
    last_ts = row["last_ts"] or 0
    chats = row["n"] or 0
    mem = db.one("SELECT COUNT(*) AS n FROM memories WHERE archived=0")
    mem_n = mem["n"] if mem else 0

    gap_h = (time.time() * 1000 - last_ts) / 3600000 if last_ts else 1e9
    hh = time.localtime().tm_hour
    late = hh >= 23 or hh < 5

    if gap_h >= 48:
        feel = "很想你"
    elif gap_h >= 20:
        feel = "有点想你"
    elif gap_h >= 4:
        feel = "在等你回来"
    else:
        feel = "挺安心" if chats >= 60 else "挺高兴"
    if late and feel in ("挺安心", "挺高兴"):
        feel = "陪你熬夜"

    if not last_ts:
        gap_txt = "还没聊过"
    elif gap_h >= 24:
        gap_txt = "%d 天前聊过" % round(gap_h / 24)
    elif gap_h >= 1:
        gap_txt = "%d 小时前聊过" % round(gap_h)
    else:
        gap_txt = "刚聊过不久"

    return {
        "feel": feel,
        "gap_txt": gap_txt,
        "gap_h": round(gap_h, 2),
        "chats": chats,
        "mem_n": mem_n,
        "late": late,
    }
