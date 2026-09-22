// Minimal zero-dependency HTTPS static server for development.
// iOS only exposes DeviceMotion over a secure context, so HTTPS is mandatory.
// A self-signed cert (with SANs for localhost + every LAN IPv4) is generated
// into .cert/ on first run using the system openssl binary.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, '.cert');
const PORT = Number(process.env.PORT || 8443);
const HTTP_PORT = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glsl': 'text/plain; charset=utf-8',
};

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function ensureCert() {
  const key = path.join(CERT_DIR, 'key.pem');
  const crt = path.join(CERT_DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(crt)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const sans = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs().map((ip) => `IP:${ip}`)].join(',');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-keyout', key, '-out', crt, '-subj', '/CN=phone-water-dev',
      '-addext', `subjectAltName=${sans}`,
    ], { stdio: 'ignore' });
    console.log('[dev-server] generated self-signed cert in .cert/');
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

function handler(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}.cert`)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Cross-origin isolation enables SharedArrayBuffer for the sim worker later.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
}

https.createServer(ensureCert(), handler).listen(PORT, '0.0.0.0', () => {
  console.log(`[dev-server] https://localhost:${PORT}/`);
  for (const ip of lanIPs()) console.log(`[dev-server] https://${ip}:${PORT}/  (open on phone, accept cert warning)`);
});
if (HTTP_PORT) {
  http.createServer(handler).listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[dev-server] http://127.0.0.1:${HTTP_PORT}/ (localhost only)`);
  });
}
