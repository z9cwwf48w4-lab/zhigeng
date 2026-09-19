#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""前端一致性静态检查

浏览器渲染没法在这个环境里验（沙箱拦住 Chrome 的 IPC），
但「引用了不存在的东西」这类错误不需要浏览器就能抓出来，
而且它们恰恰是最常见的白屏原因：

  ① 用了 icons.js 里没定义的图标名   → 该处渲染成空白
  ② 用了 tokens.css 里没定义的变量   → 该处样式整块失效
  ③ index.html 引用了不存在的文件     → 资源 404
  ④ 生成 data-act="X" 但没有处理分支  → 按钮点了没反应
  ⑤ 跨模块接口对不上                  → 运行到那一行才崩，最难查
  ⑥ 危险模式                          → 安全底线

第 ⑤ 项是这次新加的：功能被拆成 app.js / sync.js / tasks.js / conversations.js /
cloud.js 五个文件之后，「A 调了 B 里不存在的方法」是最容易犯也最难当场发现的错
—— 页面能开，点下去才崩。静态查一遍成本极低。

用法：
    python3 tools/check_consistency.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATIC = os.path.join(ROOT, "static")

# 参与检查的前端源文件（第三方 SDK / cloud-config 不算）
JS_FILES = ["app.js", "cloud.js", "locals.js", "brain.js", "icons.js",
            "sync.js", "tasks.js", "conversations.js"]

fails = []
warns = []


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def check(name, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + name + (("  → " + detail) if detail else ""))
    if not cond:
        fails.append(name)


def warn(name, detail=""):
    print("  ⚠️  " + name + (("  → " + detail) if detail else ""))
    warns.append(name)


# ── ① 图标名 ─────────────────────────────────────────────────────────────
print("══ ① 图标名引用 ══")
icons_src = read(os.path.join(STATIC, "icons.js"))
block = re.search(r"const ICON_PATHS\s*=\s*\{(.*?)\n\};", icons_src, re.S)
defined = set(re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:", block.group(1), re.M)) if block else set()
print("     已定义 %d 个图标：%s" % (len(defined), ", ".join(sorted(defined))))

used = {}
indirect = set()
for fn in JS_FILES + ["index.html"]:
    src = read(os.path.join(STATIC, fn))
    for m in re.finditer(r"""icon\(\s*['"]([A-Za-z0-9_]+)['"]""", src):
        used.setdefault(m.group(1), set()).add(fn)
    for m in re.finditer(r"""data-icon=["']([A-Za-z0-9_]+)["']""", src):
        used.setdefault(m.group(1), set()).add(fn)
    # 变量间接引用：形如 { ok: 'check', err: 'alert' } 或 ROUTES 里的 icon: 'radar'。
    # 第一版没有这一步，把 alert / info 误报成「定义了但没用到」——
    # 它们其实是 toast 的图标映射表在用。
    for m in re.finditer(r""":\s*['"]([A-Za-z0-9_]+)['"]""", src):
        if m.group(1) in defined:
            indirect.add(m.group(1))
missing_icons = {k: v for k, v in used.items() if k not in defined}
check("所有引用的图标都已定义（直接引用 %d 个，间接引用 %d 个）"
      % (len(used), len(indirect)),
      not missing_icons,
      "缺失：" + ", ".join("%s（用于 %s）" % (k, "/".join(sorted(v)))
                          for k, v in sorted(missing_icons.items())))

unused_icons = defined - set(used) - indirect
if unused_icons:
    warn("定义了但确实没用到：%s" % ", ".join(sorted(unused_icons)))

# ── ② CSS 变量 ───────────────────────────────────────────────────────────
print("\n══ ② CSS 变量 ══")
tokens = read(os.path.join(STATIC, "tokens.css"))
defined_vars = set(re.findall(r"^\s*(--[A-Za-z0-9-]+)\s*:", tokens, re.M))
# 组件文件里也会声明「局部」自定义属性（比如 .range 的 --p，
# 由 JS 在运行时写值、CSS 给一个兜底默认）。它们同样算已定义，
# 否则会把 --p 误报成未定义变量。
for fn in ("app.css", "views.css"):
    src = read(os.path.join(STATIC, fn))
    defined_vars |= set(re.findall(r"^\s*(--[A-Za-z0-9-]+)\s*:", src, re.M))
print("     tokens.css + 组件内局部声明，共 %d 个变量" % len(defined_vars))

used_vars = {}
for fn in ("app.css", "views.css", "tokens.css"):
    src = read(os.path.join(STATIC, fn))
    for m in re.finditer(r"var\(\s*(--[A-Za-z0-9-]+)", src):
        used_vars.setdefault(m.group(1), set()).add(fn)
missing_vars = {k: v for k, v in used_vars.items() if k not in defined_vars}
check("所有 var() 引用的变量都已定义（共引用 %d 个）" % len(used_vars),
      not missing_vars,
      "缺失：" + ", ".join(sorted(missing_vars)))

# 内联 style 里的 var() 也要查（index.html / JS 模板字符串）
for fn in ["index.html"] + JS_FILES:
    src = read(os.path.join(STATIC, fn))
    bad = set()
    for m in re.finditer(r"var\(\s*(--[A-Za-z0-9-]+)", src):
        if m.group(1) not in defined_vars:
            bad.add(m.group(1))
    check("%-18s 内联样式里的 var() 均已定义" % fn, not bad,
          ", ".join(sorted(bad)) if bad else "")

# ── ③ 资源引用 ───────────────────────────────────────────────────────────
print("\n══ ③ index.html 引用的资源 ══")
html = read(os.path.join(STATIC, "index.html"))
refs = re.findall(r"""(?:href|src)=["']([^"'#]+)["']""", html)
local = [r for r in refs if not r.startswith(("http", "data:", "//"))]
for r in sorted(set(local)):
    # 带 ?v=__AA_BUILD__ 的查询串不参与文件系统判断
    clean = r.split("?")[0]
    exists = os.path.isfile(os.path.join(STATIC, clean))
    check("%-42s 存在" % clean, exists)

# 构建指纹占位符：每个本地资源都该带上，否则部署后可能拿到旧文件
versioned = [r for r in local if "v=__AA_BUILD__" in r]
plain = [r for r in local if "v=__AA_BUILD__" not in r]
check("所有本地资源都带构建指纹（%d 个）" % len(local), not plain,
      "未带指纹：" + ", ".join(plain) if plain else "")

# ── ④ data-act 闭环 ──────────────────────────────────────────────────────
print("\n══ ④ data-act 生成与处理闭环 ══")
app_src = read(os.path.join(STATIC, "app.js"))
generated = set(re.findall(r"""data-act=["']([a-z-]+)["']""", app_src))
handled = set(re.findall(r"""act\s*===\s*['"]([a-z-]+)['"]""", app_src))
# 其他模块也会生成 data-act，统一收集
for fn in ("tasks.js", "conversations.js", "sync.js"):
    src = read(os.path.join(STATIC, fn))
    generated |= set(re.findall(r"""data-act=["']([a-z-]+)["']""", src))
# index.html 里的静态按钮（返回应用、本地横幅等）算生成侧。
# 不收进来的话有两个后果：静态按钮漏了处理分支查不出来（点了没反应），
# 而已有分支的会被报成「找不到生成处」，多出一条无用提醒。
generated |= set(re.findall(r"""data-act=["']([a-z-]+)["']""",
                            read(os.path.join(STATIC, "index.html"))))
# 弹窗按钮用的是 actions[].value，不是 data-act，单独收
handled |= set(re.findall(r"""value:\s*['"]([a-z-]+)['"]""", app_src))

print("     生成 %d 个：" % len(generated) + ", ".join(sorted(generated)))
check("每个生成的 data-act 都有处理分支",
      generated <= handled,
      "无处理：" + ", ".join(sorted(generated - handled)) if generated - handled else "")
if handled - generated:
    warn("有处理分支但没找到生成处（可能是动态拼接或弹窗返回值）："
         + ", ".join(sorted(handled - generated)))

# ── ⑤ 跨模块接口闭环 ─────────────────────────────────────────────────────
print("\n══ ⑤ 跨模块接口 ══")

# 5.1 window.AAApp 桥：模块用到的方法必须在 app.js 的导出对象里
m = re.search(r"window\.AAApp\s*=\s*\{(.*?)\n\};", app_src, re.S)
bridge = set(re.findall(r"[,\s{]([A-Za-z_][A-Za-z0-9_]*)", m.group(1))) if m else set()
bridge.discard("")
print("     AAApp 暴露 %d 项：%s" % (len(bridge), ", ".join(sorted(bridge))))

bridge_used = {}
for fn in ("sync.js", "tasks.js", "conversations.js"):
    src = read(os.path.join(STATIC, fn))
    for mm in re.finditer(r"AAApp\.([A-Za-z_][A-Za-z0-9_]*)", src):
        bridge_used.setdefault(mm.group(1), set()).add(fn)
missing_bridge = {k: v for k, v in bridge_used.items() if k not in bridge}
check("模块调用的 AAApp.* 都在桥里（共 %d 个）" % len(bridge_used),
      not missing_bridge,
      "缺失：" + ", ".join("%s（被 %s 调用）" % (k, "/".join(sorted(v)))
                          for k, v in sorted(missing_bridge.items())))

# 5.2 Cloud.data.* 的方法必须在**路由表**里，且路由表必须覆盖云端实现的每一个方法
#
# 为什么改成查路由表而不是查那个对象字面量：
# 现在 Cloud.data 是按模式分派的（本地 / 云端），方法名只有一个真源 —— ROUTED 数组。
# 只查对象字面量的话，「新写了一个数据方法却忘了挂路由」这种错完全查不出来，
# 而它的表现是运行时 sink(...) is not a function，藏在某个不常走的路径里。
cloud_src = read(os.path.join(STATIC, "cloud.js"))

route_block = re.search(r"const ROUTED = \[(.*?)\];", cloud_src, re.S)
routed = set(re.findall(r"""['"]([A-Za-z_][A-Za-z0-9_]*)['"]""", route_block.group(1))) \
    if route_block else set()

cloud_block = re.search(r"const cloudData = \{(.*?)\n  \};\n", cloud_src, re.S)
cloud_impl = set(re.findall(r"async\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", cloud_block.group(1))) \
    if cloud_block else set()

print("     路由表 %d 个方法 · 云端实现 %d 个" % (len(routed), len(cloud_impl)))
check("路由表覆盖云端实现的每一个方法",
      bool(cloud_impl) and cloud_impl <= routed,
      "未挂路由：" + ", ".join(sorted(cloud_impl - routed)))

# 本地实现由 tools/test_store.js 做逐方法对齐（那里能真正 import 两个模块比对）

data_used = {}
for fn in JS_FILES:
    src = read(os.path.join(STATIC, fn))
    for mm in re.finditer(r"Cloud\.data\.([A-Za-z_][A-Za-z0-9_]*)", src):
        data_used.setdefault(mm.group(1), set()).add(fn)
missing_data = {k: v for k, v in data_used.items() if k not in routed}
check("调用的 Cloud.data.* 都在路由表里（共 %d 个）" % len(data_used),
      not missing_data,
      "缺失：" + ", ".join("%s（被 %s 调用）" % (k, "/".join(sorted(v)))
                          for k, v in sorted(missing_data.items())))

# 5.3 全局模块是否真的挂到 window
for name, fn in (("Sync", "sync.js"), ("Tasks", "tasks.js"), ("Convos", "conversations.js")):
    src = read(os.path.join(STATIC, fn))
    check("%s 已挂到 window" % name, "window.%s =" % name in src)

# 5.4 脚本加载顺序：被依赖的必须先加载
# 注意：必须先剥掉 ?v=<构建指纹> 再判断扩展名 —— 否则 "...js?v=abc".endswith(".js")
# 是 False，整个 order 会变成空列表，检查形同虚设（第一版就踩了这个坑）。
clean_local = [r.split("?")[0] for r in local]
order = [r for r in clean_local if r.endswith(".js")]


def idx(n):
    return order.index(n) if n in order else -1


check("脚本顺序：icons → brain → locals → cloud → 三个模块 → app",
      idx("icons.js") >= 0 and idx("brain.js") >= 0 and idx("cloud.js") >= 0
      and idx("icons.js") < idx("brain.js") < idx("locals.js") < idx("cloud.js")
      < idx("app.js")
      and idx("conversations.js") >= 0 and idx("conversations.js") < idx("app.js"),
      "实际顺序：" + " → ".join(order))
check("app.js 最后加载（其余模块只定义、不执行）",
      idx("app.js") == len(order) - 1 and len(order) > 1,
      "实际顺序：" + " → ".join(order))

# ── ⑥ 危险模式 ───────────────────────────────────────────────────────────
print("\n══ ⑥ 危险模式扫描 ══")

# 「请求里带 owner_id」只对**会发网络请求**的文件成立。
# locals.js 是本地存储层：它写的 owner_id 是本地的归属标记（固定常量 'local'），
# 不出网，也不是身份凭据 —— 把它算成违规是误报。
# 误报的代价不是「多看一眼」，而是整条规则被逐渐无视，最后真的违规也看不见。
CLOUD_FACING = [f for f in JS_FILES if f != "locals.js"]

danger = {
    "innerHTML 直接拼接未转义变量": (re.compile(r"innerHTML\s*=\s*[^;]*\$\{(?!esc\()"), JS_FILES),
    "手写 fetch 打 /.cloud/": (re.compile(r"""fetch\(\s*['"`][^'"`]*/\.cloud/"""), JS_FILES),
    "请求里带 owner_id": (re.compile(r"owner_id\s*:"), CLOUD_FACING),
    "eval / new Function": (re.compile(r"\b(eval|new Function)\s*\("), JS_FILES),
}
for label, (pat, files) in danger.items():
    hits = []
    for fn in files:
        src = read(os.path.join(STATIC, fn))
        for i, line in enumerate(src.split("\n"), 1):
            if pat.search(line):
                hits.append("%s:%d" % (fn, i))
    check("%s 未出现" % label, not hits, ", ".join(hits[:5]))

# 本地层的归属标必须是写死的常量 —— 一旦它变成可传入的参数，
# 「本地数据」就有了被伪造成别人数据的能力，而本地层是没有 RLS 兜底的。
check("locals.js 的 owner_id 是写死的常量 local（不接受外部传入）",
      bool(re.search(r"""const\s+OWNER\s*=\s*['"]local['"]\s*;""",
                     read(os.path.join(STATIC, "locals.js")))))

# 令牌是否出现在会被公开的静态文件里
print()
token_like = re.findall(r"""["']([A-Za-z0-9_\-]{32,})["']""", read(os.path.join(STATIC, "cloud-config.js")))
check("cloud-config.js 里只有 publishableKey（可公开），无服务端密钥",
      all(v.startswith(("wbpk_", "wbcs_", "https")) or "workbuddy" in v for v in token_like),
      str(token_like))

print()
if fails:
    print("❌ 失败 %d 项" % len(fails))
    for f in fails:
        print("   ·", f)
    sys.exit(1)
print("✅ 一致性检查全部通过" + ("（%d 条提醒）" % len(warns) if warns else ""))
sys.exit(0)
