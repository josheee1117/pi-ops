"""Local-only workload for exercising Docker log discovery with a real Python traceback."""
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        try:
            if self.path == "/memory":
                raise MemoryError("log scan drill")
            raise ValueError("log scan drill")
        except Exception:
            logging.exception("drill request failed")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"logged")


HTTPServer(("0.0.0.0", 8088), Handler).serve_forever()
