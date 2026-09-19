#!/usr/bin/env bash
# AA · 一键跑全部检查
#
# 三件事：
#   ① Python / JS 语法
#   ② 一致性检查 —— 引用了不存在的东西（白屏的头号原因），静态可查
#   ③ 设计规范检查 —— 圆角/字阶/间距网格/交互态/动效是否守规矩（防「AI 味」回归）
#   ④ 本地数据层 —— 云端接口与本地实现的逐方法对齐 + CRUD 行为
#   ⑤ 算法等价性 —— JS 移植版与 Python 原版是否算得一样
#
# 浏览器渲染没法在这里验（沙箱拦 Chrome 的 IPC），所以这些是本地能做的全部。
# 界面要看效果，用 ../tools/preview/build.sh + ../tools/shot/shot 出截图。
# 登录流程必须在正式域名上人工验一次 —— 平台认证不给 localhost 开回调绑定。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PY="${AA_PY:-/Users/a1234/.workbuddy/binaries/python/envs/default/bin/python}"

cd "$ROOT"

echo "════════════ ① Python 语法 ════════════"
"$PY" -m py_compile server.py && echo "  ✅ server.py"

echo
echo "════════════ ② JS 语法 ════════════"
NODE="${AA_NODE:-/Users/a1234/.workbuddy/binaries/node/versions/22.22.2-3/bin/node}"
for f in static/icons.js static/brain.js static/cloud-config.js static/cloud.js \
         static/locals.js static/sync.js static/tasks.js static/conversations.js \
         static/app.js; do
  "$NODE" --check "$f" && echo "  ✅ $f"
done

echo
echo "════════════ ③ 前端一致性 ════════════"
"$PY" tools/check_consistency.py

echo
echo "════════════ ④ 设计规范 ════════════"
"$PY" tools/check_design.py

echo
echo "════════════ ⑤ 本地数据层 ════════════"
"$NODE" tools/test_store.js

echo
echo "════════════ ⑥ 大脑算法等价性 ════════════"
"$PY" tools/test_brain_parity.py

echo
echo "✅ 全部检查通过"
