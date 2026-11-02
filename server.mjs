import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import siteClockHandler from './api/site-clock.mjs';

const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === '/api/site-clock') {
      await siteClockHandler(req, res);
      return;
    }
    const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(filename);
    res.writeHead(200, {
      'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://tickets.interpark.com https://ticket.interpark.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('페이지를 찾을 수 없습니다.');
  }
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`ONDECK is ready\nLocal: http://127.0.0.1:${port}\n`));
server.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
