#!/usr/bin/env python3
# Development server for `make run`: `python3 -m http.server`, except that every
# response says Cache-Control: no-cache. The page loads build/cpu-worker.js and
# build/v86.wasm under a fixed ?<version> query, so without this a browser can
# keep running a stale bundle or core after a rebuild.
import contextlib
import http.server
import socket
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        # Dual stack, like http.server's own command line: localhost may be ::1 or 127.0.0.1.
        with contextlib.suppress(Exception):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
with Server(("::", port), Handler) as server:
    print(f"Serving on http://localhost:{port}/", flush=True)
    server.serve_forever()
