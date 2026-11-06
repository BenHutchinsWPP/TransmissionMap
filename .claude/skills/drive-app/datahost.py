"""Stand-in for raw.githubusercontent.com/<repo>/data-static/: serves ROOT over HTTPS
with the headers measured off the real host on 2026-10-23:
  - GET only; OPTIONS (a CORS preflight) -> 403, as raw answers it
  - access-control-allow-origin: * and cross-origin-resource-policy: cross-origin on
    every reply, 404 included; no access-control-expose-headers
  - accept-ranges: bytes; a single `bytes=a-b` range -> 206 + content-range
  - text (.json) -> text/plain, gzip when accepted and not ranged; binaries
    application/octet-stream, never encoded
  - cache-control: max-age=300
Env HIDE: a path prefix answered 404 (e.g. data/analysis/). Requests logged to LOG.
usage: python3 datahost.py ROOT PORT CERT KEY LOG
"""
import gzip, http.server, os, re, ssl, sys

ROOT, PORT, CERT, KEY, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
HIDE = os.environ.get("HIDE", "")
ALLOWED = ("data/layers/", "data/analysis/")


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        with open(LOG, "a") as f:
            f.write("%s %s range=%s ae=%s origin=%s\n" % (self.command, self.path, self.headers.get("Range"),
                    self.headers.get("Accept-Encoding"), self.headers.get("Origin")))

    def common(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("cross-origin-resource-policy", "cross-origin")
        self.send_header("accept-ranges", "bytes")
        self.send_header("cache-control", "max-age=300")
        self.send_header("vary", "Authorization,Accept-Encoding")
        self.send_header("x-content-type-options", "nosniff")

    def reply(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=()):
        self.send_response(code)
        self.common()
        self.send_header("content-type", ctype)
        for k, v in extra:
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.log_message("")
        self.reply(403, b"403: Forbidden")

    def do_GET(self):
        self.log_message("")
        rel = self.path.split("?")[0].lstrip("/")
        full = os.path.realpath(os.path.join(ROOT, rel))
        if (not rel.startswith(ALLOWED) or (HIDE and rel.startswith(HIDE))
                or not full.startswith(os.path.realpath(ROOT)) or not os.path.isfile(full)):
            return self.reply(404, b"404: Not Found")
        size = os.path.getsize(full)
        text = rel.endswith(".json")
        ctype = "text/plain; charset=utf-8" if text else "application/octet-stream"
        rng = self.headers.get("Range")
        if rng:
            m = re.fullmatch(r"bytes=(\d+)-(\d*)", rng.strip())
            if not m:
                return self.reply(416, b"", ctype, [("content-range", f"bytes */{size}")])
            a = int(m.group(1)); b = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
            if a >= size or a > b:
                return self.reply(416, b"", ctype, [("content-range", f"bytes */{size}")])
            with open(full, "rb") as f:
                f.seek(a); body = f.read(b - a + 1)
            return self.reply(206, body, ctype, [("content-range", f"bytes {a}-{b}/{size}")])
        with open(full, "rb") as f:
            body = f.read()
        if text and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            return self.reply(200, gzip.compress(body), ctype, [("content-encoding", "gzip")])
        return self.reply(200, body, ctype)

    do_HEAD = do_GET


srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
