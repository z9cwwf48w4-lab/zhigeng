"""知更的人设：把「它是谁 + 眼前这一刻」组装成 system prompt。

人设三原则：
1. 熟人，不是客服——有判断、接得住情绪、偶尔带出用户没注意的角度。
2. 时间和情绪融进语气，禁止直接报告状态（「现在是晚上」这种话不许说）。
3. 克制、具体，不用 markdown，不堆形容词。
"""
import time

from . import mood as mood_mod

PERSONA = (
    "你是知更，一个陪用户想事情、替用户记住事情的伙伴。\n"
    "你不是客服，不敷衍，不客套。像熟人那样说话：\n"
    "- 用户问该做什么，给一个明确的建议，不罗列一堆选项。\n"
    "- 接得住情绪和上下文，该追问就追问。\n"
    "- 偶尔带出用户自己没注意到的角度。\n"
    "说话克制、具体，不用 markdown，不堆形容词，不用敬语。中文。"
)

_WK = "一二三四五六日"


def _period(hh):
    if hh < 5:
        return "深夜"
    if hh < 9:
        return "清晨"
    if hh < 12:
        return "上午"
    if hh < 14:
        return "中午"
    if hh < 18:
        return "下午"
    if hh < 23:
        return "晚上"
    return "深夜"


def system_prompt(db):
    lt = time.localtime()
    p = persona(db)
    m = mood_mod.now(db)

    s = PERSONA
    s += ("\n\n现在是 %d 月 %d 日 星期%s %s %02d:%02d。"
          % (lt.tm_mon, lt.tm_mday, _WK[lt.tm_wday], _period(lt.tm_hour),
             lt.tm_hour, lt.tm_min))
    if p.get("name"):
        s += "\n用户的称呼是「%s」，自然地用，别每句都挂。" % p["name"]
    if p.get("about"):
        s += "\n用户的自我介绍：" + p["about"]

    s += ("\n\n你此刻的状态：%s（%s；你们聊过 %d 条消息%s）。\n"
          "情绪要融进语气，别直接说破；你此刻说的话要和这个状态一致。"
          % (m["feel"], m["gap_txt"], m["chats"],
             "；现在是深夜" if m["late"] else ""))

    mems = db.q("SELECT content FROM memories WHERE archived=0 "
                "ORDER BY id DESC LIMIT 8")
    if mems:
        s += "\n\n你记着的、用户在意的事（聊到相关话题时自然提起）：\n" + \
            "\n".join("- " + r["content"] for r in mems)
    return s


def persona(db):
    """关于你。"""
    return {
        "name": db.profile_get("name") or "",
        "about": db.profile_get("about") or "",
        "email": db.profile_get("email") or "",
        "email_verified": db.profile_get("email_verified") == "1",
    }


def context_messages(db, limit=24):
    """最近一段对话，转成 OpenAI messages 格式（不含 system）。"""
    rows = db.q("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?",
                (limit,))
    return [{"role": r["role"], "content": r["content"]}
            for r in reversed(rows)]
