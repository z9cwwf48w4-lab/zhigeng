#!/usr/bin/env python3
"""知更 · 服务端入口。

只做三件事：静态文件、API 分发、启动。逻辑全在 app/ 包里分层。
标准库 only，单端口，python3 server.py 即起。
"""
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import api, config, db  # noqa: E402

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- 动态 API ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            return api.dispatch_get(self, path)
        return self._static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            return api.dispatch_post(self, path)
        self.send_error(404)

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            return api.dispatch_delete(self, path)
        self.send_error(404)

    # ---- 静态：web/ 目录，前端原生 ESM 无构建 ----
    def _static(self, path):
        if path == "/":
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith(".."):
            return self.send_error(403)
        full = os.path.join(config.WEB_DIR, rel)
        if not os.path.isfile(full):
            # SPA 兜底：未知路径回首页（前端路由接管）
            full = os.path.join(config.WEB_DIR, "index.html")
            if not os.path.isfile(full):
                return self.send_error(404)
        ctype = STATIC_TYPES.get(
            os.path.splitext(full)[1],
            mimetypes.guess_type(full)[0] or "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 开发期允许强刷；指纹由前端入口的 ?v= 决定
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # 只在错误上出声
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write("[zhigeng] %s %s\n"
                             % (self.address_string(), fmt % args))


def main():
    port = int(os.environ.get("PORT", "8140"))
    db.init()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("知更已上线 ：%d" % port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
