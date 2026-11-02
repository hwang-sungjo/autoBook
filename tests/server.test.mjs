import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

let server;
let origin;

before(async () => {
  const port = randomInt(32_000, 60_000);
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error(`Local server did not start: ${errors}`));
    }, 5000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ONDECK is ready')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (chunk) => { errors += chunk; });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => {
      if (!output.includes('ONDECK is ready')) {
        clearTimeout(timer);
        reject(new Error(`Local server exited (${code}): ${errors}`));
      }
    });
  });
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
});

test('GET / serves the application with a restrictive content policy', async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const policy = response.headers.get('content-security-policy');
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
    assert.ok(policy.includes(directive), directive);
  }
  const html = await response.text();
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /app\.mjs/);
});

test('HEAD returns the same MIME metadata with no response body', async () => {
  const response = await fetch(origin, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.ok(response.headers.get('content-security-policy'));
  assert.equal(await response.text(), '');
});

test('application modules and styles are served with usable MIME types', async () => {
  for (const [resource, mime] of [
    ['/app.mjs', 'text/javascript; charset=utf-8'],
    ['/core.mjs', 'text/javascript; charset=utf-8'],
    ['/seat-model.mjs', 'text/javascript; charset=utf-8'],
    ['/timing.mjs', 'text/javascript; charset=utf-8'],
    ['/standby.mjs', 'text/javascript; charset=utf-8'],
    ['/standby.html', 'text/html; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/icon.svg', 'image/svg+xml'],
  ]) {
    const response = await fetch(`${origin}${resource}`);
    assert.equal(response.status, 200, resource);
    assert.equal(response.headers.get('content-type'), mime, resource);
    assert.ok((await response.text()).length > 0, resource);
  }
});

test('encoded path traversal cannot expose files outside dist', async () => {
  for (const resource of ['/..%2fserver.mjs', '/..%2fpackage.json', '/..%2f..%2fetc%2fpasswd']) {
    const response = await fetch(`${origin}${resource}`);
    assert.equal(response.status, 403, resource);
    assert.equal(await response.text(), 'Forbidden');
  }
});

test('POST is rejected and advertises the supported methods', async () => {
  const response = await fetch(origin, { method: 'POST', body: 'example' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('missing resources return 404 and malformed URL encodings return 400', async () => {
  const missing = await fetch(`${origin}/does-not-exist.json`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /^text\/plain/);
  const malformed = await fetch(`${origin}/%E0%A4%A`);
  assert.equal(malformed.status, 400);
});

test('clock API rejects arbitrary targets and cross-site callers before any upstream access', async () => {
  for (const target of ['https://evil.test', 'http://127.0.0.1:3000', 'https://tickets.interpark.com/gates/ticket/123']) {
    const response = await fetch(`${origin}/api/site-clock?origin=${encodeURIComponent(target)}`);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const response = await fetch(`${origin}/api/site-clock`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(response.status, 403);
});
