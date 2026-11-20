// Minimal static file server for the tests (no dependencies). serve(dir, port, host) -> Promise<http.Server>
const http = require('http'); const fs = require('fs'); const path = require('path');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain' };
function serve(dir, port, host) {
  const root = path.resolve(dir);
  const srv = http.createServer((req, res) => {
    let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
    let f = path.join(root, p); if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.stat(f, (err, st) => {
      if (!err && st.isDirectory()) f = path.join(f, 'index.html');
      fs.readFile(f, (e, buf) => {
        if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(buf);
      });
    });
  });
  return new Promise((ok, bad) => { srv.once('error', bad); srv.listen(port, host || undefined, () => ok(srv)); });
}
module.exports = { serve };
if (require.main === module) { const [dir = '.', port = '8080', host = '127.0.0.1'] = process.argv.slice(2); serve(dir, +port, host).then(() => console.log(`serving ${dir} on http://${host}:${port}/`)); }
