#!/usr/bin/env python3
"""
Minimal CORS relay for AI Transformation Studio (optional).

Browsers may block direct calls to api.x.ai / api-inference.modelscope.cn due to
CORS policy. Run this tiny local relay and point the endpoint fields in the app's
Settings at it:

    python3 proxy.py            # serves on http://127.0.0.1:8787

In the app Settings (Live mode), set:
    Grok endpoint base      -> http://127.0.0.1:8787/xai/v1
    ModelScope endpoint base-> http://127.0.0.1:8787/ms/v1

The relay forwards POST /xai/v1/*  -> https://api.x.ai/v1/*
                 POST /ms/v1/*   -> https://api-inference.modelscope.cn/v1/*
and adds permissive CORS headers. Your keys still live only in the browser;
they are forwarded as-is on each request and never stored by the relay.

Requires: Python 3.8+ standard library only.
"""
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROUTES = {
    "/xai/": "https://api.x.ai/",
    "/ms/":  "https://api-inference.modelscope.cn/",
}

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
}


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[relay] " + (fmt % args) + "\n")

    def _cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        target = None
        for prefix, upstream in ROUTES.items():
            if self.path.startswith(prefix):
                target = upstream + self.path[len(prefix):]
                break
        if not target:
            self.send_response(404)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"unknown relay route"}')
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target, data=body, method="POST")
        req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        auth = self.headers.get("Authorization")
        if auth:
            req.add_header("Authorization", auth)

        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = resp.read()
                status = resp.status
                ctype = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            payload = e.read()
            status = e.code
            ctype = e.headers.get("Content-Type", "application/json")
        except Exception as e:
            payload = ('{"error":"relay failure: %s"}' % str(e).replace('"', "'")).encode()
            status = 502
            ctype = "application/json"

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"CORS relay listening on http://127.0.0.1:{port}")
    print("  /xai/v1/* -> https://api.x.ai/v1/*")
    print("  /ms/v1/*  -> https://api-inference.modelscope.cn/v1/*")
    ThreadingHTTPServer(("127.0.0.1", port), Relay).serve_forever()
