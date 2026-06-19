#!/usr/bin/env python3
import sys
from http.server import SimpleHTTPRequestHandler, HTTPServer

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence per-request noise

port = int(sys.argv[1]) if len(sys.argv) > 1 else 3848
print(f'DVR Timer → http://localhost:{port}', flush=True)
HTTPServer(('', port), Handler).serve_forever()
