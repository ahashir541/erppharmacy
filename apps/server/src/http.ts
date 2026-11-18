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
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 25 * 1048576) throw new ApiError('Too much data in one request', 413);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { throw new ApiError('Invalid JSON'); }
}

export function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('MedFlow app files are missing (public folder).'); return; }
  const hashed = urlPath.startsWith('/assets/');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

