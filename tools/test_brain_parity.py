#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""大脑算法等价性校验：aa-agent 的 Python 原版 vs aa-cloud 的 JS 移植版

移植最大的风险不是「跑不起来」，而是「跑起来但悄悄算得不一样」——
那种 bug 在界面上看不出来，只会表现为「AA 的提案越来越怪」。
所以这里用同一组输入喂两边，逐项比对，任何一项不一致就直接失败。

用法：
    python3 tools/test_brain_parity.py
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CLOUD_ROOT = os.path.dirname(HERE)
AA_AGENT = "/Users/a1234/WorkBuddy/2026-09-18-19-49-41/aa-agent"
NODE = "/Users/a1234/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"

sys.path.insert(0, AA_AGENT)
from aa import memory as py_mem       # noqa: E402
from aa import scorer as py_score     # noqa: E402

NOW = datetime(2026, 9, 19, 12, 0, 0)


def iso(dt):
    return dt.isoformat()


# ── 测试用的配置 ─────────────────────────────────────────────────────────
# 关键：JS 版把 goal_keywords + holdings_keywords 合并成了 focus_keywords，
# 所以这里必须显式合并，否则两边词表不同，比对毫无意义。
GOAL = ["盈利", "目标", "持仓", "复盘", "风控", "止损"]
HOLD = ["中核科技", "半导体", "生物医药", "512290", "512480", "000777", "ETF"]

CFG = {
    "touch_line": 38,
    "weights": {"urgency": 0.30, "relevance": 0.25, "novelty": 0.20,
                "actionability": 0.15, "risk": 0.10},
    "risk_keywords": {
        "high": ["下单", "买入", "卖出", "清仓", "满仓", "转账", "付款", "支付",
                 "实盘", "代发", "发消息", "发送邮件", "改密码", "授权"],
        "mid": ["调仓", "调整持仓", "持仓调整", "改配置", "删除", "替换",
                "排期", "预约", "开户"],
    },
    "action_keywords": ["复盘", "检查", "记录", "整理", "看一眼", "核对",
                        "提醒", "总结", "对比", "测算"],
    "urgent_keywords": ["停牌", "复牌", "异动", "公告", "暴跌", "暴涨", "跳水",
                        "涨停", "跌停", "拉升", "大跌", "大涨", "急跌", "急涨",
                        "净流入", "净流出", "创新低", "创新高", "破位"],
    "time_keywords": ["今天", "今日", "立刻", "马上", "立即", "现在", "收盘前",
                      "开盘前", "今晚", "尽快"],
    # Python 侧读这两个键
    "goal_keywords": GOAL,
    "holdings_keywords": HOLD,
    # JS 侧读这两个键（内容等价）
    "focus_keywords": GOAL + HOLD,
    "custom_keywords": [],
}


def mk_item(iid, content, tier="normal", base=0.6, lock=False, days_ago=0):
    t = NOW - timedelta(days=days_ago)
    return {"id": iid, "content": content, "tier": tier, "base_weight": base,
            "lock": lock, "last_accessed": iso(t), "created_at": iso(t)}


# ── ① 衰减向量 ──────────────────────────────────────────────────────────
WEIGHT_CASES = [
    # (tier, lock, base, days_ago)
    ("locked", True, 0.9, 0),
    ("locked", True, 0.9, 100),
    ("locked", False, 0.9, 100),     # λ=0，数学上也不衰减
    ("normal", False, 0.6, 0),
    ("normal", False, 0.6, 10),
    ("normal", False, 0.6, 23),      # 半衰点
    ("normal", False, 0.6, 60),
    ("normal", False, 0.5, 100),
    ("volatile", False, 0.5, 0),
    ("volatile", False, 0.5, 7),     # 半衰点
    ("volatile", False, 0.5, 30),
    ("volatile", True, 0.8, 365),
]

# ── ② 路由向量 ──────────────────────────────────────────────────────────
def mk_mem(items=None, cold=None, proposals=None, last_touch_days=None, rounds=3):
    meta = {"created_at": iso(NOW - timedelta(days=60)), "rounds": rounds,
            "last_run_at": None, "last_touch_at": None}
    if last_touch_days is not None:
        meta["last_touch_at"] = iso(NOW - timedelta(days=last_touch_days))
    return {"items": items or [], "cold": cold or [],
            "proposals": proposals or [], "meta": meta}


MEM_A = mk_mem(items=[
    mk_item("mem_0001", "9 月底前账户盈利 500 元", "locked", 0.9, True, 0),
    mk_item("mem_0002", "每日收盘后做复盘 summary", "normal", 0.6, False, 10),
    mk_item("mem_0003", "半导体板块最近很热", "volatile", 0.5, False, 3),
], last_touch_days=1)

MEM_B = mk_mem(items=[
    mk_item("mem_0001", "9 月底前账户盈利 500 元", "locked", 0.9, True, 0),
], proposals=[
    {"idea": "核对生物医药 ETF 的持仓比例", "score": 55, "decision": "touch"},
    {"idea": "半导体板块资金流向午后解读", "score": 41, "decision": "touch"},
], last_touch_days=5)

MEM_C = mk_mem(items=[], last_touch_days=30)

ROUTE_CASES = [
    # 普通想法 + 世界无信号
    {"idea": "今天做一次复盘，记录一下持仓变化", "world": "", "mem": MEM_A},
    # 高风险想法 → 闸门必须覆盖静默
    {"idea": "建议买入中核科技并立刻下单", "world": "", "mem": MEM_A},
    # 中风险
    {"idea": "调仓半导体 ETF", "world": "", "mem": MEM_A},
    # 世界信号命中持仓 → relevance 应该上涨
    {"idea": "关注一下今天的行情", "world": "半导体板块异动，主力资金净流入，生物医药大涨", "mem": MEM_A},
    # 世界信号含风险词，但 idea 不含 → 不应该触发风险闸门
    {"idea": "看一眼今天的新闻摘要", "world": "有人建议买入半导体，机构调整持仓", "mem": MEM_A},
    # 历史提案相似 → novelty 应该下降
    {"idea": "核对生物医药 ETF 的持仓比例", "world": "", "mem": MEM_B},
    # 全新想法
    {"idea": "整理这个月的读书笔记并写一篇总结", "world": "", "mem": MEM_B},
    # 空记忆 + 长期沉寂 → urgency 靠 silence 拉高
    {"idea": "现在回顾一下目标进度", "world": "", "mem": MEM_C},
    # 临界：接近触达线
    {"idea": "今天记录一下预算使用情况", "world": "", "mem": MEM_A},
]

# ── ③ 沉寂回收向量 ──────────────────────────────────────────────────────
RESCUE_CASE = {
    "mem": {
        "items": [],
        "cold": [
            {"id": "mem_0101", "content": "核对中国核电的公告", "tier": "volatile",
             "base_weight": 0.5, "lock": False,
             "last_accessed": iso(NOW - timedelta(days=40)),
             "created_at": iso(NOW - timedelta(days=40)),
             "archived_at": iso(NOW - timedelta(days=30)),
             "archived_round": 1},
            {"id": "mem_0102", "content": "看盘", "tier": "volatile",
             "base_weight": 0.5, "lock": False,
             "last_accessed": iso(NOW - timedelta(days=40)),
             "created_at": iso(NOW - timedelta(days=40)),
             "archived_at": iso(NOW - timedelta(days=30)),
             "archived_round": 1},
            {"id": "mem_0103", "content": "与本轮信号完全无关的一条旧闻", "tier": "normal",
             "base_weight": 0.5, "lock": False,
             "last_accessed": iso(NOW - timedelta(days=40)),
             "created_at": iso(NOW - timedelta(days=40)),
             "archived_at": iso(NOW - timedelta(days=30)),
             "archived_round": 1},
        ],
        "proposals": [],
        "meta": {"created_at": iso(NOW - timedelta(days=90)), "rounds": 5,
                 "last_run_at": None, "last_touch_at": None},
    },
    # 世界信号同时命中 mem_0101 和极短记忆 mem_0102
    "keywords": ["中国核电", "核电", "公告", "看盘", "核电公告"],
}

# ── ④ 归档向量 ──────────────────────────────────────────────────────────
ARCHIVE_CASE = {
    "mem": {
        "items": [
            mk_item("mem_0001", "永久目标", "locked", 0.9, True, 500),
            mk_item("mem_0002", "很新的常规记忆", "normal", 0.6, False, 1),
            mk_item("mem_0003", "早就该忘的易逝记忆", "volatile", 0.3, False, 90),
            mk_item("mem_0004", "另一个早该忘的", "normal", 0.2, False, 120),
        ],
        "cold": [],
        "proposals": [],
        "meta": {"created_at": iso(NOW - timedelta(days=200)), "rounds": 9,
                 "last_run_at": None, "last_touch_at": None},
    },
    "skip": ["mem_0004"],
}


def run_python():
    out = {"weights": [], "forgotten": [], "routes": [], "rescue": [], "archived": []}

    for tier, lock, base, days in WEIGHT_CASES:
        item = mk_item("x", "测试", tier, base, lock, days)
        out["weights"].append(py_mem.effective_weight(item, NOW))
        out["forgotten"].append(py_mem.is_forgotten(item, NOW))

    for c in ROUTE_CASES:
        mem = json.loads(json.dumps(c["mem"]))
        decision, s, comp, level, gated = py_score.route(
            c["idea"], c["world"] or "", mem, NOW, CFG)
        out["routes"].append({"decision": decision, "score": s, "level": level,
                              "gated": gated, "comp": comp})

    mem = json.loads(json.dumps(RESCUE_CASE["mem"]))
    hits = py_mem.rescue(mem, RESCUE_CASE["keywords"], NOW, None, 0)
    out["rescue"] = {
        "hits": [{"id": h["id"], "base_weight": h["base_weight"],
                  "coverage": h["coverage"]} for h in hits],
        "coldIds": sorted(x["id"] for x in mem["cold"]),
        "itemIds": sorted(x["id"] for x in mem["items"]),
        "weights": [{"id": x["id"], "base_weight": x["base_weight"]} for x in mem["items"]],
    }

    mem = json.loads(json.dumps(ARCHIVE_CASE["mem"]))
    archived = py_mem.archive_forgotten(mem, NOW, ARCHIVE_CASE["skip"])
    out["archived"] = {
        "archived": sorted(archived),
        "itemIds": sorted(x["id"] for x in mem["items"]),
        "coldIds": sorted(x["id"] for x in mem["cold"]),
    }
    return out


def run_js():
    payload = {
        "cfg": CFG,
        "now": iso(NOW),
        "weightCases": [{"tier": t, "lock": l, "base": b, "last_accessed": iso(NOW - timedelta(days=d))}
                        for t, l, b, d in WEIGHT_CASES],
        "routeCases": ROUTE_CASES,
        "rescueCase": RESCUE_CASE,
        "archiveCase": ARCHIVE_CASE,
    }
    p = subprocess.run([NODE, os.path.join(HERE, "brain_probe.js")],
                       input=json.dumps(payload), text=True,
                       capture_output=True)
    if p.returncode != 0:
        print("❌ JS 侧执行失败：\n" + p.stderr[-3000:])
        sys.exit(2)
    return json.loads(p.stdout)


def main():
    py = run_python()
    js = run_js()

    fails = []

    def check(name, a, b, tol=None):
        if tol is not None and isinstance(a, (int, float)) and isinstance(b, (int, float)):
            ok = abs(a - b) <= tol
        else:
            ok = a == b
        print(("  ✅ " if ok else "  ❌ ") + name +
              ("" if ok else "   Python=%r  JS=%r" % (a, b)))
        if not ok:
            fails.append(name)

    print("══ ① 衰减 effective_weight ══")
    for i, (tier, lock, base, days) in enumerate(WEIGHT_CASES):
        check("tier=%-8s lock=%-5s base=%.1f %3d天" % (tier, lock, base, days),
              py["weights"][i], js["weights"][i], tol=1e-9)
    print("══ ①′ 遗忘判定 isForgotten ══")
    for i, (tier, lock, base, days) in enumerate(WEIGHT_CASES):
        check("tier=%-8s lock=%-5s %3d天" % (tier, lock, days),
              py["forgotten"][i], js["forgotten"][i])

    print("\n══ ② 评分与路由 ══")
    for i, c in enumerate(ROUTE_CASES):
        label = c["idea"][:18]
        check("score  「%s」" % label, py["routes"][i]["score"], js["routes"][i]["score"], tol=1e-9)
        check("决策   「%s」" % label, py["routes"][i]["decision"], js["routes"][i]["decision"])
        check("风险级 「%s」" % label, py["routes"][i]["level"], js["routes"][i]["level"])
        check("闸门   「%s」" % label, py["routes"][i]["gated"], js["routes"][i]["gated"])
        for k in ("urgency", "relevance", "novelty", "actionability", "risk"):
            check("  %-13s 「%s」" % (k, label),
                  py["routes"][i]["comp"][k], js["routes"][i]["comp"][k], tol=1e-9)

    print("\n══ ③ 沉寂回收 rescue ══")
    check("捞回的 id", [h["id"] for h in py["rescue"]["hits"]],
          [h["id"] for h in js["rescue"]["hits"]])
    for a, b in zip(py["rescue"]["hits"], js["rescue"]["hits"]):
        check("  %s 权重" % a["id"], a["base_weight"], b["base_weight"], tol=1e-9)
        check("  %s 覆盖率" % a["id"], a["coverage"], b["coverage"], tol=1e-9)
    check("冷库剩余", py["rescue"]["coldIds"], js["rescue"]["coldIds"])
    check("活跃区", py["rescue"]["itemIds"], js["rescue"]["itemIds"])

    print("\n══ ④ 归档 archiveForgotten ══")
    check("归档 id", py["archived"]["archived"], js["archived"]["archived"])
    check("活跃区剩余", py["archived"]["itemIds"], js["archived"]["itemIds"])
    check("冷库内容", py["archived"]["coldIds"], js["archived"]["coldIds"])

    print()
    if fails:
        print("❌ 不一致 %d 项：\n   %s" % (len(fails), "\n   ".join(fails)))
        return 1
    print("✅ 全部一致：Python 原版与 JS 移植版算法等价。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
