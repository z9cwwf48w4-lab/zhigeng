"""LLM 客户端：OpenAI 兼容 /chat/completions 直连，标准库实现。

stream() 是唯一入口：给 messages，吐 content 增量字符串的生成器。
上游断流、超时都抛 LLMError，由调用方决定怎么兜底（对话报错 / 主动开口落模板）。
"""
import json
import urllib.error
import urllib.request

from . import config


class LLMError(Exception):
    pass


def _payload(messages, stream, max_tokens=800, temperature=0.8):
    cfg = config.llm_config()
    if not cfg:
        raise LLMError("LLM 未配置")
    return cfg, {
        "model": cfg["model"],
        "messages": messages,
        "stream": stream,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }


def _request(cfg, body, timeout):
    req = urllib.request.Request(
        cfg["base_url"] + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg["api_key"],
        },
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def stream(messages, max_tokens=800, temperature=0.8):
    """流式：yield content 增量。用完记得 close()（用 with）。"""
    cfg, body = _payload(messages, True, max_tokens, temperature)
    try:
        resp = _request(cfg, body, timeout=180)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read(300).decode("utf-8", "replace")
        except Exception:
            pass
        raise LLMError("上游 %s %s" % (e.code, detail)) from e
    except urllib.error.URLError as e:
        raise LLMError("连不上模型服务：%s" % e.reason) from e

    return _iter_sse(resp)


def _iter_sse(resp):
    """解析上游 SSE：data: {...} 行，取 choices[0].delta.content。"""
    try:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                j = json.loads(data)
            except ValueError:
                continue
            delta = ((j.get("choices") or [{}])[0].get("delta") or {})
            piece = delta.get("content")
            if piece:
                yield piece
    finally:
        resp.close()


def complete(messages, max_tokens=800, temperature=0.8):
    """非流式：一次拿全文。主动开口、来信生成用这个，省事。"""
    cfg, body = _payload(messages, False, max_tokens, temperature)
    try:
        with _request(cfg, body, timeout=120) as resp:
            j = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise LLMError("上游 %s" % e.code) from e
    except (urllib.error.URLError, ValueError) as e:
        raise LLMError("模型请求失败：%s" % e) from e
    try:
        return (j["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        raise LLMError("模型返回格式异常")
