"""Serve only this independent asset bundle. Ctrl-C closes the server."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from functools import partial
ROOT=Path(__file__).resolve().parents[1]
print('Open http://127.0.0.1:8768/viewer/ (Ctrl-C to stop)',flush=True)
ThreadingHTTPServer(('127.0.0.1',8768),partial(SimpleHTTPRequestHandler,directory=str(ROOT))).serve_forever()
