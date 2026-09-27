// Tiny static + API server (no framework). Serves compiled browser code and studio pages.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

export const ROOT = resolve(new URL('../../..', import.meta.url).pathname);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg',
};
const PUBLIC = ['dist', 'apps/studio', 'out', 'episodes', 'assets', 'docs'];

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function startServer(port: number, api?: ApiHandler): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (api && url.pathname.startsWith('/api/') && (await api(req, res, url))) return;
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/apps/studio/index.html';
      const rel = normalize(p).replace(/^\/+/, '');
      if (!PUBLIC.some((d) => rel === d || rel.startsWith(d + '/'))) { res.writeHead(404); res.end('not found'); return; }
      const file = join(ROOT, rel);
      if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      const size = statSync(file).size;
      const type = MIME[extname(file)] ?? 'application/octet-stream';
      const range = req.headers.range;
      if (range && /bytes=\d*-\d*/.test(range)) {
        const [a, b] = range.replace('bytes=', '').split('-');
        const start = a ? parseInt(a, 10) : 0, end = b ? parseInt(b, 10) : size - 1;
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      ok({ server, url: `http://localhost:${p}` });
    });
  });
}
