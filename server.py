#!/usr/bin/env python3
import sys
from http.server import SimpleHTTPRequestHandler, HTTPServer

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence per-request noise

    def end_headers(self):
        # No caching: this is a local single-user tool, and stale JS/CSS after an
        # edit is far more costly here than re-reads of small files.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 3848
print(f'DVR Timer → http://localhost:{port}', flush=True)
HTTPServer(('', port), Handler).serve_forever()
