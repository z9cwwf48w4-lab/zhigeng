#!/usr/bin/env python3
# 从 lucide-static（ISC 许可）抓取图标子集，合成一个 <symbol> sprite。
# 为什么不用整包：lucide 有 1700+ 图标，AA 只需要几十个；自托管整个包
# 会让这个 72KB 的应用膨胀十倍。这里按名字精确取，产出一个 ~12KB 的 sprite。
#
# 用法：python3 build_icons.py
import os, re, sys, json, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
VER = "0.544.0"
BASE = "https://cdn.jsdelivr.net/npm/lucide-static@%s/icons/%s.svg" % (VER, "%s")

# 名字 → 用途（注释留档，便于以后增删）
WANTED = {
    # 导航 / 骨架
    "target": "今天那一件事", "clock": "时间线", "layers": "它在意的",
    "sliders-horizontal": "偏好设置", "menu": "移动端抽屉",
    # 消息类型：两种关系
    "search": "我查到了（自主探索）", "hand": "我需要你（呼唤人类）",
    "sparkle": "AA 在想", "brain": "思考中",
    # 行动
    "check": "做到了", "x": "跳过", "plus": "添加", "arrow-right": "继续",
    "chevron-right": "进入", "chevron-down": "展开", "rotate-ccw": "重来",
    # 记忆状态
    "lock": "锁定不衰减", "leaf": "正在变淡", "archive": "已归档",
    "pencil": "编辑", "trash-2": "删除", "eye": "查看",
    # 账户 / 状态
    "user": "账户", "log-out": "退出", "bell": "通知", "shield": "确认闸门",
    "info": "提示", "alert-triangle": "警告", "wifi-off": "离线",
    "refresh-cw": "同步", "calendar": "日期", "loader": "载入中",
    "sun": "浅色", "moon": "深色", "external-link": "外部打开",
    "corner-down-right": "追问", "hourglass": "等待中",
    "hash": "话题标签（中性的标签符号，不要用 sparkle —— 那是 AA 在想）",
    "bell-off": "按住了没打扰你",
}

def fetch(name):
    req = urllib.request.Request(BASE % name, headers={"User-Agent": "aa-icon-builder"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8")

def main():
    symbols, failed = [], []
    for name in WANTED:
        try:
            svg = fetch(name)
        except Exception as e:
            failed.append((name, str(e)))
            continue
        # 抽出 <svg> 内部内容，去掉 width/height/class 等外层属性
        m = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S)
        if not m:
            failed.append((name, "no <svg> body"))
            continue
        # lucide 的 SVG 是多行缩进的。必须把换行/缩进压成单空格 ——
        # 否则写进 JS 单引号字符串时会变成裸换行，整份 icons.js 直接语法错误，
        # 结果是全站图标静默消失（踩过一次）。
        body = re.sub(r"\s+", " ", m.group(1)).strip()
        # 统一成 24 视框、currentColor、线宽 2 —— lucide 原始即是如此，这里只做断言校验
        assert 'stroke="currentColor"' in svg, name + " 不是 currentColor"
        symbols.append('<symbol id="i-%s" viewBox="0 0 24 24" fill="none" '
                       'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
                       'stroke-linejoin="round">%s</symbol>' % (name, body))

    if failed:
        print("⚠️ 失败：", failed)
    if not symbols:
        print("❌ 一个都没拿到，中止"); sys.exit(1)

    icons = "".join(symbols)
    assert "\n" not in icons and "\r" not in icons, "sprite 里还有裸换行"

    sprite = ("/* 由 build_icons.py 生成，勿手改。图标来源：lucide-static v%s（ISC 许可）。\n"
              "   许可证全文见同目录 LICENSE-lucide.txt */\n" % VER)
    # 用 json.dumps 生成 JS 字面量：换行、引号、反斜杠全部按 JS 规则转义。
    # 手写 "'" + s.replace("'", "\\'") + "'" 只挡得住引号，挡不住换行。
    literal = json.dumps(icons, ensure_ascii=False)
    sprite += "window.AA_ICONS = " + literal + ";\n"

    # 自检：产物必须能在 JS 里解析出正确的图标数量。
    # 这一步是补上那个坑 —— 图标静默消失时页面不会报任何错，只会一片空白。
    assert "\n" not in literal and "\r" not in literal, "JS 字面量里有裸换行"
    assert len(json.loads(literal)) == len(icons), "字面量往返不一致"
    assert literal.count("<symbol ") == len(symbols), "symbol 数量不符"

    # 如果本机有 node，再让真正的 JS 引擎解析一遍（可选，失败不影响产物）。
    # 注意：node 里没有 window，所以这里用普通变量接，别写 window.AA_ICONS。
    try:
        import subprocess, shutil
        node = shutil.which("node")
        if node:
            probe = ("var s = " + literal +
                     ";if (typeof s !== 'string') throw new Error('not a string');"
                     "if (s.length !== %d) throw new Error('长度不符: ' + s.length);"
                     "process.stdout.write('ok ' + s.length)" % len(icons))
            r = subprocess.run([node, "-e", probe], capture_output=True, text=True, timeout=20)
            if r.returncode != 0 or not r.stdout.startswith("ok "):
                print("❌ node 自检失败：", (r.stderr or r.stdout).strip()[-400:])
                sys.exit(1)
            print("   node 自检通过（%s 字符）" % r.stdout.split()[1])
        else:
            print("   （跳过 node 自检：PATH 里没有 node，Python 侧断言已通过）")
    except Exception as e:
        print("   （跳过 node 自检：%s）" % e)

    out = os.path.join(HERE, "icons.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write(sprite)

    total = sum(len(s) for s in symbols)
    print("✅ %d 个图标 → %s（%.1f KB）" % (len(symbols), out, total / 1024))
    print("   清单：" + ", ".join(sorted(WANTED.keys())))

if __name__ == "__main__":
    main()
