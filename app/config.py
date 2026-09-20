"""配置加载：路径、LLM 凭据。全标准库，无全局可变状态以外的东西。"""
import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
WEB_DIR = os.path.join(BASE_DIR, "web")
DB_PATH = os.path.join(DATA_DIR, "robin.db")

# 私有配置读序：运行时 data/llm.json 优先，根目录 llm.default.json 兜底。
# 两个路径都不进 git（key 不能泄）。
_LLM_CANDIDATES = (
    os.path.join(DATA_DIR, "llm.json"),
    os.path.join(BASE_DIR, "llm.default.json"),
)

_llm_cache = None


def llm_config():
    """返回 {base_url, api_key, model}；没配置返回 None（对话功能安全降级）。"""
    global _llm_cache
    if _llm_cache is None:
        for p in _LLM_CANDIDATES:
            try:
                with open(p, "r", encoding="utf-8") as f:
                    d = json.load(f)
                if d.get("api_key") and d.get("base_url") and d.get("model"):
                    _llm_cache = {
                        "base_url": d["base_url"].rstrip("/"),
                        "api_key": d["api_key"],
                        "model": d["model"],
                    }
                    break
            except (OSError, ValueError):
                continue
    return _llm_cache


def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
