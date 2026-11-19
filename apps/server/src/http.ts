// Small web helpers shared by MedFlow Local and MedFlow HQ: JSON in and out, static files.
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from './db.ts';

export function lanAddresses(port: number): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}`);
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// A tunnel or proxy on this PC (Tailscale Funnel, Cloudflare Tunnel, a reverse proxy) connects from
// 127.0.0.1 too, but always adds one of these headers; such a request comes from the internet.
const PROXIED = ['x-forwarded-for', 'forwarded', 'tailscale-funnel-request', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip'];
const proxied = (req: http.IncomingMessage) => PROXIED.some((h) => req.headers[h] !== undefined);

/**
 * Takes the port BEFORE the database is opened. A second copy of the server (the icon clicked again
 * while MedFlow is still starting) stops here with exit code 3 and never touches the data folder:
 * two database engines on one folder can damage it.
 */
export async function claimPort(port: number, starting: string, log: (s: string) => void) {
  let handler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;
  const http_ = await import('node:http');
  const server = http_.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (handler) { handler(req, res); return; }
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '3' });
    res.end(JSON.stringify({ error: starting, starting: true }));
  });
  await new Promise<void>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      log(err.code === 'EADDRINUSE' ? `Port ${port} is in use: already running on this PC. This copy stops without opening the data.` : `Server error: ${err.message}`);
      process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
    });
    server.listen(port, '0.0.0.0', () => resolve());
  });
  return { server, ready: (h: (req: http.IncomingMessage, res: http.ServerResponse) => void) => { handler = h; } };
}

/** Really this PC: a direct connection from 127.0.0.1, not through a tunnel. */
export const isLocal = (req: http.IncomingMessage) => LOOPBACK.includes(req.socket.remoteAddress ?? '') && !proxied(req);

/** The caller's address, for sign-in limits (the tunnel's X-Forwarded-For when it came through one on this PC). */
export function clientAddress(req: http.IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? '?';
  if (!LOOPBACK.includes(direct)) return direct;
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || (proxied(req) ? 'proxied' : direct);
}

export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 25 * 1048576;
  // Too big: answer 413 and close this connection (the unread rest of the body would garble the next request on it).
  const tooBig = () => { (req as http.IncomingMessage & { tooBig?: boolean }).tooBig = true; return new ApiError('Too much data in one request', 413); };
  if (Number(req.headers['content-length'] ?? 0) > limit) throw tooBig();
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw tooBig();
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { throw new ApiError('Invalid JSON'); }
}

/**
 * Sent with every response from MedFlow Local and MedFlow HQ (OWASP secure headers).
 * The pages load only their own files, Google Fonts, and (HQ sign-in) Google Identity Services.
 * 'wasm-unsafe-eval' lets the browser run the WebAssembly database in the browser-only mode;
 * 'unsafe-inline' is for style attributes only (React style={}), never for scripts.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Browsers honour this only over HTTPS (HQ through Tailscale); on the shop's local HTTP it is ignored.
  'Strict-Transport-Security': 'max-age=31536000',
};

export function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  if ((res.req as http.IncomingMessage & { tooBig?: boolean } | undefined)?.tooBig) res.setHeader('Connection', 'close');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse, prefix = '') {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!).slice(prefix.length) || '/';
  let file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('MedFlow app files are missing (public folder).'); return; }
  const hashed = urlPath.startsWith('/assets/');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

