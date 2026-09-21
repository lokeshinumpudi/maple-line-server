import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDirector, DirectorError } from './director.js';
import { createEvaluationGate } from './evaluation-gate.js';
import { createWorldPlanner } from './world-planner.js';
import { createNarration } from './narration.js';

const MAX_BODY_BYTES = 4096;
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:4174',
  'http://localhost:4174',
]);

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body */
function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<unknown>} */
function readJson(request) {
  // Vercel parses JSON before invoking a Node function; local HTTP streams do not.
  if ('body' in request && request.body !== undefined) {
    try {
      const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES)
        return Promise.reject(new DirectorError(413, 'Request body exceeds 4096 bytes.'));
      return Promise.resolve(JSON.parse(raw));
    } catch {
      return Promise.reject(new DirectorError(400, 'Invalid JSON.'));
    }
  }
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new DirectorError(408, 'Request body timed out.')), 2000);
    /** @param {Error|null} error @param {unknown} [value] */
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(value);
    }
    /** @param {Buffer} chunk */
    function onData(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        return finish(new DirectorError(413, 'Request body exceeds 4096 bytes.'));
      chunks.push(chunk);
    }
    function onEnd() {
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(new DirectorError(400, 'Invalid JSON.'));
      }
    }
    function onError() {
      finish(new DirectorError(400, 'Request body could not be read.'));
    }
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

/** @param {{director?:ReturnType<typeof createDirector>,worldPlanner?:ReturnType<typeof createWorldPlanner>,narration?:ReturnType<typeof createNarration>, hosted?:boolean, allowedOrigins?:string[], cacheDirectory?:string|null}} [options] */
export function createDirectorHandler(options = {}) {
  const gate = createEvaluationGate();
  const narration =
    options.narration ??
    createNarration({
      cacheDirectory:
        options.cacheDirectory === undefined
          ? fileURLToPath(new URL('../../../.cache/narration/', import.meta.url))
          : options.cacheDirectory,
    });
  const director = options.director ?? createDirector({ evaluate: gate.background });
  const worldPlanner = options.worldPlanner ?? createWorldPlanner({ evaluate: gate.foreground });
  const allowedOrigins = new Set(options.allowedOrigins ?? ALLOWED_ORIGINS);
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  return async (request, response) => {
    try {
      const host = request.headers.host?.split(':')[0];
      if (!options.hosted && host !== '127.0.0.1' && host !== 'localhost')
        return json(response, 403, { error: 'Localhost requests only.' });
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin))
        return json(response, 403, { error: 'Origin is not allowed.' });
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (
        ![
          '/api/director/status',
          '/api/director/decide',
          '/api/director/world',
          '/api/director/narration',
          '/api/director/narration/status',
        ].includes(pathname)
      )
        return json(response, 404, { error: 'Not found.' });
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        });
        return response.end();
      }
      if (pathname === '/api/director/narration/status' && request.method === 'GET')
        return json(response, 200, narration.status());
      if (pathname === '/api/director/status' && request.method === 'GET')
        return json(response, 200, { ...director.status(), world: worldPlanner.status() });
      if (
        !['/api/director/decide', '/api/director/world', '/api/director/narration'].includes(
          pathname,
        ) ||
        request.method !== 'POST'
      )
        return json(response, 405, { error: 'Method not allowed.' });
      if (
        request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
      )
        return json(response, 415, { error: 'Use application/json.' });
      if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        request.resume();
        return json(response, 413, { error: 'Request body exceeds 4096 bytes.' });
      }
      const body = await readJson(request);
      if (pathname === '/api/director/narration') {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        try {
          const result = await narration.speak(body, controller.signal);
          if (response.destroyed) return;
          response.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': result.audio.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          return response.end(result.audio);
        } finally {
          response.removeListener('close', cancel);
        }
      }
      const result =
        pathname === '/api/director/world'
          ? await worldPlanner.plan(body)
          : await director.decide(body);
      return json(response, 200, result);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      return json(response, error instanceof DirectorError ? error.status : 500, {
        error: error instanceof DirectorError ? error.message : 'Director request failed.',
      });
    }
  };
}

/** @param {Parameters<typeof createDirectorHandler>[0]} [options] */
export function createDirectorServer(options = {}) {
  const server = createServer(createDirectorHandler(options));
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 30;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DIRECTOR_PORT ?? 4175);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('DIRECTOR_PORT must be an integer from 1024 to 65535.');
  const server = createDirectorServer();
  server.listen(port, '127.0.0.1', () =>
    process.stdout.write(`Maple Line director listening on http://127.0.0.1:${port}\n`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.close();
      server.closeIdleConnections();
    });
}
