import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDirectorHandler } from '../src/server.js';
import { createDirector } from '../src/director.js';

test('hosted handler accepts Vercel parsed bodies and enforces origin and size limits', async (t) => {
  const handler = createDirectorHandler({
    hosted: true,
    allowedOrigins: ['https://lokeshinumpudi.com'],
    director: createDirector({ hasCredentials: () => false }),
    cacheDirectory: null,
  });
  const server = createServer((req, res) => {
    req.body = req.headers['x-large-body']
      ? { prompt: 'x'.repeat(4097) }
      : { weather: 'clear', speedKmh: 30, remainingToStation: 600, region: 'gorge', paused: false };
    return handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/director/decide`;
  const headers = { 'content-type': 'application/json', origin: 'https://lokeshinumpudi.com' };
  const result = await fetch(url, { method: 'POST', headers });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).source, 'fallback');
  assert.equal(result.headers.get('access-control-allow-origin'), headers.origin);
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, 'x-large-body': '1' } })).status,
    413,
  );
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://other.example' } }))
      .status,
    403,
  );
  const preflight = await fetch(url, { method: 'OPTIONS', headers });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});
