#!/usr/bin/env python3
"""把 prototype/ 打成**单文件** HTML：所有源文件内联，产出零外链的 AA-重做原型-单文件.html。

为什么需要这一步：
  1) 交付物要能双击就开 —— 带着相对路径的 index.html 发给别人必然丢样式；
  2) 「零外链」是硬纪律（国内 CDN 时通时不通，一个加载失败就整页白屏），
     所以打包时**必须断言**产物里没有任何外部 href/src，而不是靠人眼看。

用法：python3 build_single_file.py
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "prototype", "index.html")
OUT = os.path.join(ROOT, "AA-重做原型-单文件.html")

# 每项：(index.html 里被引用的原样文本, 包裹标签, 要填进去的源文件列表)
# ⚠️ 一处引用可能对应**多个**源文件（这里 index.html 把 open-props 和 aa.css
#    写在相邻两行，一起替换）。第一版脚本只填了前者，静默丢了 20KB 样式，
#    而外链断言查不出来 —— 因为那条 <link> 已经被一起删掉了。
#    所以下面额外做「内容在场」断言：每个源文件都必须在产物里找到。
INLINE = [
    ('<link rel="stylesheet" href="../assets/open-props.min.css">\n<link rel="stylesheet" href="aa.css">',
     "style",
     [os.path.join(HERE, "open-props.min.css"),
      os.path.join(ROOT, "prototype", "aa.css")]),
    ('<script src="../assets/icons.js"></script>', "script",
     [os.path.join(HERE, "icons.js")]),
    ('<script src="../assets/auto-animate.min.js"></script>', "script",
     [os.path.join(HERE, "auto-animate.min.js")]),
    ('<script src="aa.js"></script>', "script",
     [os.path.join(ROOT, "prototype", "aa.js")]),
]


def sentinel(text):
    """取一段有辨识度的内容，用来验证「这个文件真的进产物了」。"""
    for line in text.splitlines():
        s = line.strip()
        if len(s) > 40 and not s.startswith(("/*", "*", "//", "<!--")):
            return s[:60]
    return text.strip()[:60]


def main():
    html = open(SRC, encoding="utf-8").read()
    must_appear = []

    for needle, kind, paths in INLINE:
        assert needle in html, "index.html 里找不到这段引用：%r" % needle
        chunks, labels = [], []
        for p in paths:
            body = open(p, encoding="utf-8").read()
            # 内联脚本/样式时，绝不能出现 </script> 或 <!-- 把宿主标签提前闭合。
            assert "</script" not in body.lower(), "%s 含 </script，不能直接内联" % p
            chunks.append(body)
            labels.append(os.path.basename(p))
            must_appear.append((os.path.basename(p), sentinel(body)))
        inner = "\n".join(chunks)
        if kind == "style":
            html = html.replace(needle, "<style>\n/* 内联自 %s */\n%s\n</style>"
                                % (" + ".join(labels), inner))
        else:
            html = html.replace(needle, "<script>\n%s\n</script>" % inner)

    # 断言一：除页内锚点(#)和 data: URI 外，任何 href/src 都是漏网的外链。
    # 曾经因为只查 "../" 前缀，漏掉了同目录的 aa.js —— 页面照常显示，
    # 只是静默少了一段逻辑（顶栏副标题空白），肉眼很难发现。
    leaks = [u for u in re.findall(r'(?:href|src)="([^"]+)"', html)
             if not u.startswith("#") and not u.startswith("data:")]
    if leaks:
        print("❌ 还有外链没内联：", leaks)
        sys.exit(1)

    # 断言二：每个源文件的内容都必须在产物里。
    # 外链断言查不出「引用被删掉、内容却没填进去」这类漏，必须单独验。
    missing = [name for name, s in must_appear if s not in html]
    if missing:
        print("❌ 这些文件的内容没进产物：", missing)
        sys.exit(1)

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("✅ %s（%.1f KB，外链 0 个，内联 %d 个文件）"
          % (OUT, os.path.getsize(OUT) / 1024, len(must_appear)))
    for name, _ in must_appear:
        print("   ·", name)


if __name__ == "__main__":
    main()
