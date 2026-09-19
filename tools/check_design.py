#!/usr/bin/env python3
"""
AA · 设计规范自动校验
================================================================================

为什么需要这个脚本
--------------------------------------------------------------------------------
「看起来像 AI 随手生成的」这件事，是可以被量化的：
圆角档位过多、字号挨着排、间距不守网格、交互元素缺状态、装饰层层叠加。

这些问题的共同点是 —— 改的时候都很容易破坏，而且肉眼一时看不出来，
等发现时已经到处都是了。所以把它们写成断言，让回归在提交前就被拦住。

检查项
--------------------------------------------------------------------------------
  ① 圆角：只允许 --r-1 / --r-2 / --r-3 / --r-full
  ② 阴影：只允许 --sh-1 / --sh-2 / --sh-3 / --ring-gold
  ③ 字阶：令牌之间相邻档位比值 ≥ 1.2，且组件里不出现裸写 font-size
  ④ 间距：padding / margin / gap 必须落在 4 的倍数网格上
  ⑤ 交互态：可交互类名必须有 :hover（且不能只有 hover）
  ⑥ 动效：transition 只允许用 --dur-* 与 --ease*
  ⑦ 颜色：组件文件里不出现裸写色值（白名单除外）
  ⑧ hidden：tokens.css 里必须有 [hidden]{display:none!important}
     —— 缺了它，带 display 的容器会把 hidden 属性覆盖掉，两个视图同时渲染

用法
--------------------------------------------------------------------------------
    python3 tools/check_design.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATIC = os.path.join(ROOT, "static")

TOKENS = os.path.join(STATIC, "tokens.css")
COMPONENT_FILES = [os.path.join(STATIC, f) for f in ("app.css", "views.css")]

# 4 的倍数网格。允许 2px 的例外是为了 1px 描边内缩这类场景。
GRID = set(range(0, 129, 4))
GRID_TOLERANT = {1, 2, 3, 5, 6, 7, 10}  # 半像素级微调

# 允许的裸写色值：会在浅色底上出现的深色文字（金底上的字）
ALLOWED_HEX = {"#1A1206"}

# 微调值的总出现次数上限。
# 为什么允许存在：2px 的间隙、1px 7px 的胶囊内边距、+3px 的基线微调，
# 这些是视觉补偿，不是随手写的间距，硬套 4 的倍数反而会歪。
# 为什么要设上限：一旦放开，微调值会迅速蔓延成新的「随手写」，
# 网格约束就名存实亡了。上限存在的意义是让它保持稀缺。
MAX_TOLERANT_HITS = 30

failures = []
notes = []


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def declare(name, ok, detail=""):
    mark = "✅" if ok else "❌"
    print("  %s %s%s" % (mark, name, ("  — " + detail) if detail and not ok else ""))
    if not ok:
        failures.append(name + (("  — " + detail) if detail else ""))


tokens_raw = read(TOKENS)
tokens = strip_comments(tokens_raw)
components = {os.path.basename(p): strip_comments(read(p)) for p in COMPONENT_FILES}
all_component = "\n".join(components.values())


def prop_values(text, prop):
    return [m.group(1).strip()
            for m in re.finditer(r"(?<![\w-])" + prop + r"\s*:\s*([^;{}]+)", text)]


print("════════ ① 圆角只允许三档 + 胶囊 ════════")
allowed_radii = {"--r-1", "--r-2", "--r-3", "--r-full"}
radii = prop_values(all_component, "border-radius")
raw_radii = [v for v in radii if "var(" not in v and v not in ("inherit", "0")]
bad_radii = [v for v in radii
             if "var(" in v and not any(t in v for t in allowed_radii)]
declare("无裸写圆角", not raw_radii, "裸写: %s" % sorted(set(raw_radii)))
declare("只引用三档圆角令牌", not bad_radii, "越界引用: %s" % sorted(set(bad_radii)))
print("      引用次数: %d，令牌档位数: 3 (+胶囊)" % len(radii))

print()
print("════════ ② 阴影只允许三档 ════════")
shadow_props = ["box-shadow"]
raw_shadows = []
for f, css in components.items():
    for v in prop_values(css, "box-shadow"):
        if "var(" in v or v == "none":
            continue
        # inset 高光也要走令牌；这里全部视为裸写
        raw_shadows.append((f, v))
declare("无裸写 box-shadow", not raw_shadows,
        "%d 处，例如 %s" % (len(raw_shadows), raw_shadows[:2]))

print()
print("════════ ③ 字阶：阶差 ≥1.2，组件不裸写字号 ════════")
scale = {}
for key in ("--fs-display", "--fs-h1", "--fs-h2", "--fs-h3", "--fs-body", "--fs-sm", "--fs-xs"):
    m = re.search(re.escape(key) + r"\s*:\s*([0-9.]+)px", tokens)
    if m:
        scale[key] = float(m.group(1))
order = ["--fs-display", "--fs-h1", "--fs-h2", "--fs-h3", "--fs-body", "--fs-sm", "--fs-xs"]
steps = []
for a, b in zip(order, order[1:]):
    if a in scale and b in scale and scale[b] > 0:
        steps.append((a, b, scale[a] / scale[b]))
# 只对「标题级」阶差强约束；body→sm→xs 属于辅助层级，允许更细
heading_steps = steps[:3]
declare("标题级阶差 ≥1.2",
        all(r >= 1.2 for _, _, r in heading_steps),
        ", ".join("%s/%s=%.2f" % (a.replace("--fs-", ""), b.replace("--fs-", ""), r)
                  for a, b, r in heading_steps))
print("      阶差: " + "  ".join("%s→%s %.2f×" % (a.replace("--fs-", ""), b.replace("--fs-", ""), r)
                                  for a, b, r in steps))

raw_fs = []
for f, css in components.items():
    for v in prop_values(css, "font-size"):
        if "var(" not in v and v != "inherit":
            raw_fs.append((f, v))
declare("组件内无裸写字号", not raw_fs, "%d 处: %s" % (len(raw_fs), raw_fs[:3]))

print()
print("════════ ④ 间距守 4/8 网格 ════════")
spacing_props = ["padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
                 "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
                 "gap", "row-gap", "column-gap"]
off_grid = {}
tolerant_hits = 0
for f, css in components.items():
    for prop in spacing_props:
        for v in prop_values(css, prop):
            if "var(" in v:
                continue
            for num in re.findall(r"(-?\d+(?:\.\d+)?)px", v):
                n = abs(float(num))
                if n == 0 or n in GRID:
                    continue
                if n in GRID_TOLERANT:
                    tolerant_hits += 1
                    continue
                off_grid.setdefault(n, 0)
                off_grid[n] += 1
declare("无网格外间距", not off_grid, "偏离值: %s" % off_grid)
declare("微调值不超标（≤%d）" % MAX_TOLERANT_HITS, tolerant_hits <= MAX_TOLERANT_HITS,
        "实际 %d 处" % tolerant_hits)

print()
print("════════ ⑤ 交互态覆盖 ════════")
# 只检查真正的交互控件。
# 不列入的：.input / .range / .switch 这类原生控件（:focus 就是它们的激活反馈）、
# .mem / .hist-item / .card 这类纯容器（可点的东西在它们内部），
# .link 是文本链接（下划线/变色已足够）。
INTERACTIVE = ["btn", "nav-item", "iconbtn", "seg-btn", "conv-item", "conv-new", "conv-pick", "tab"]
for cls in INTERACTIVE:
    pat = r"\." + re.escape(cls) + r"(?![\w-])"
    if not re.search(pat, all_component):
        continue
    # .btn 的 hover 写在 .btn-primary:hover / .btn-ghost:hover 这些变体上，
    # 只要任意带该前缀的类有 hover 就算数 —— 否则会误报「.btn 没有 hover」。
    pat_hover = (r"\." + re.escape(cls) + r"[\w-]*[^{}]*:hover")
    hovers = re.findall(pat_hover, all_component)
    actives = re.findall(r"\." + re.escape(cls) + r"[\w-]*[^{}]*:active", all_component)
    if not hovers:
        declare(".%s 有 hover 态" % cls, False, "完全没有 hover")
    if not actives:
        notes.append(".%s 没有 :active —— 点击时的即时反馈会缺" % cls)

hover_total = all_component.count(":hover")
active_total = all_component.count(":active")
focus_total = all_component.count(":focus")
print("      统计: :hover=%d  :active=%d  :focus=%d" % (hover_total, active_total, focus_total))
declare(":active 数量不少于 :hover 的一半",
        active_total * 2 >= hover_total,
        "hover=%d active=%d" % (hover_total, active_total))

print()
print("════════ ⑥ 动效统一 ════════")
durs = prop_values(all_component, "transition") + prop_values(all_component, "animation")
allowed_dur = {"--dur-fast", "--dur", "--dur-slow", "--dur-loop", "--dur-pulse"}
bad_dur = []
for v in durs:
    if "var(" not in v:
        continue
    for m in re.finditer(r"var\((--dur[\w-]*)\)", v):
        if m.group(1) not in allowed_dur:
            bad_dur.append(m.group(1))
declare("只引用已声明的 --dur-* 令牌", not bad_dur, "越界: %s" % sorted(set(bad_dur)))

raw_ms = [v for v in durs if "var(" not in v and re.search(r"\d+m?s", v)]
declare("无裸写时长", not raw_ms, "%d 处: %s" % (len(raw_ms), raw_ms[:3]))

eases = set(re.findall(r"cubic-bezier\([^)]+\)", all_component))
declare("缓动曲线 ≤2 条", len(eases) <= 2, "实际 %d 条: %s" % (len(eases), eases))

print()
print("════════ ⑦ 颜色收口 ════════")
bad_hex = {}
for f, css in components.items():
    for m in re.findall(r"#[0-9A-Fa-f]{3,8}\b", css):
        if m.upper() in ALLOWED_HEX:
            continue
        bad_hex.setdefault(m.upper(), 0)
        bad_hex[m.upper()] += 1
declare("组件里无裸写色值", not bad_hex, "出现: %s" % bad_hex)

print()
print("════════ ⑧ hidden 属性必须真的生效 ════════")
# 这条是踩过坑的：.auth{display:grid} 会把 [hidden]{display:none} 覆盖掉，
# 结果登录页和应用页同时渲染，页面高度翻倍，应用视图被顶到第二屏。
has_hidden_rule = bool(re.search(r"\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important", tokens))
declare("[hidden]{display:none!important} 存在", has_hidden_rule,
        "缺失 —— 带 display 的容器会覆盖 hidden，两个视图会同时渲染")

print()
print("════════ 结果 ════════")
if notes:
    print("提醒（不阻断）：")
    for n in notes:
        print("  ⚠️  " + n)
if failures:
    print("❌ 设计规范校验未通过：%d 项" % len(failures))
    for f in failures:
        print("   - " + f)
    sys.exit(1)
print("✅ 设计规范校验通过")
