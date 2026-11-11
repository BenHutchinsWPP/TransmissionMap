"""Stand-in for data.wpptx.org (Cloudflare R2): serves ROOT over HTTPS with the
headers measured off the real host on 2026-11-10:
  - GET/HEAD; a CORS preflight asking for `range` only -> 204 (allow-methods GET, HEAD,
    allow-headers range, max-age 86400), any other requested header -> 403
  - access-control-allow-origin: * and access-control-expose-headers: ETag,
    Content-Range, Content-Length, Accept-Ranges on every reply, 404 included
  - accept-ranges: bytes; a single `bytes=a-b` range -> 206 + content-range
  - content-type by extension as publish_r2.sh sets it; never a content-encoding
  - a strong etag; cache-control: public, max-age=3600
Env HIDE: a path prefix answered 404 (e.g. data/analysis/). Requests logged to LOG.
Env ROUTE_ID (with optional ROUTE_ROOT, default ROOT/data/route): serves
data/route/<ROUTE_ID>/{250m,report,constraints}/... from ROUTE_ROOT/...; unversioned data/route/
stays 404. report/screening/ (a symlink out of the tree) serves exactly what the publish plan
hosts, taken from scripts/route_publish_plan.py build(): the pointer as manifest.json and the
generation's files the plan lists; anything else is 404.
usage: python3 datahost.py ROOT PORT CERT KEY LOG
"""
import hashlib, http.server, os, re, ssl, sys

ROOT, PORT, CERT, KEY, LOG = sys.argv[1], int(sys.argv[2]), *map(os.path.abspath, sys.argv[3:6])
HIDE = os.environ.get("HIDE", "")
ROUTE_ID = os.environ.get("ROUTE_ID", "")
ROUTE_ROOT = os.path.realpath(os.environ.get("ROUTE_ROOT") or os.path.join(ROOT, "data/route"))
ROUTE_SUBS = ("250m/", "report/", "constraints/")
SCREEN = {}  # key under report/screening/ -> real path
if ROUTE_ID:
    import json, tempfile
    os.chdir(ROOT)
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import route_publish_plan as plan
    entries, _skipped, problems, _grid, pointer_bytes = plan.build()
    if problems:
        sys.exit("route_publish_plan: " + "; ".join(problems))
    tmp = tempfile.mkdtemp()
    ptr_file = os.path.join(tmp, "manifest.json")
    open(ptr_file, "wb").write(pointer_bytes)
    for e in entries:
        if e["family"] == "screening":
            SCREEN[e["key"][len("report/screening/"):]] = str(e["root"] / e["name"])
    SCREEN["manifest.json"] = ptr_file
ALLOWED = ("data/layers/", "data/analysis/")
TYPES = {".json": "application/json", ".geojson": "application/geo+json", ".zip": "application/zip", ".csv": "text/csv"}


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        with open(LOG, "a") as f:
            f.write("%s %s range=%s ae=%s origin=%s\n" % (self.command, self.path, self.headers.get("Range"),
                    self.headers.get("Accept-Encoding"), self.headers.get("Origin")))

    def common(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-expose-headers", "ETag, Content-Range, Content-Length, Accept-Ranges")
        self.send_header("accept-ranges", "bytes")
        self.send_header("cache-control", "public, max-age=3600")

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
        asked = {h.strip().lower() for h in (self.headers.get("Access-Control-Request-Headers") or "").split(",") if h.strip()}
        if not asked <= {"range"}:
            return self.reply(403)
        self.reply(204, extra=[("access-control-allow-methods", "GET, HEAD"),
                               ("access-control-allow-headers", "range"), ("access-control-max-age", "86400")])

    def do_GET(self):
        self.log_message("")
        rel = self.path.split("?")[0].lstrip("/")
        pre = "data/route/%s/" % ROUTE_ID
        if ROUTE_ID and rel.startswith(pre) and rel[len(pre):].startswith(ROUTE_SUBS) and ".." not in rel:
            sub = rel[len(pre):]
            full = os.path.realpath(os.path.join(ROUTE_ROOT, sub))
            if sub.startswith("report/screening/"):
                full = SCREEN.get(sub[len("report/screening/"):], "")
                ok = bool(full)
            else:
                ok = full.startswith(ROUTE_ROOT + os.sep)
            if HIDE and rel.startswith(HIDE):
                ok = False
        else:
            full = os.path.realpath(os.path.join(ROOT, rel))
            ok = (rel.startswith(ALLOWED) and not (HIDE and rel.startswith(HIDE))
                  and full.startswith(os.path.realpath(ROOT)))
        if not ok or not os.path.isfile(full):
            return self.reply(404, b"404: Not Found")
        size = os.path.getsize(full)
        ctype = TYPES.get(os.path.splitext(rel)[1], "application/octet-stream")
        st = os.stat(full)
        etag = [("etag", '"%s"' % hashlib.md5(f"{rel}{st.st_size}{st.st_mtime_ns}".encode()).hexdigest())]
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
            return self.reply(206, body, ctype, etag + [("content-range", f"bytes {a}-{b}/{size}")])
        with open(full, "rb") as f:
            body = f.read()
        return self.reply(200, body, ctype, etag)

    do_HEAD = do_GET


srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
