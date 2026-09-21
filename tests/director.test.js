import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDirector, DirectorError, MODEL, validateInput } from '../src/director.js';
import { createDirectorServer } from '../src/server.js';

const input = () => ({
  weather: 'clear',
  speedKmh: 42,
  remainingToStation: 600,
  region: 'gorge',
  paused: false,
});
const answer = () => ({
  answers: {
    pace: { type: 'choice', choice: 'relaxed' },
    stationActivity: { type: 'choice', choice: 'stroll' },
  },
});

test('missing credentials use explicit deterministic rules without calling AI', async () => {
  let calls = 0;
  const director = createDirector({
    hasCredentials: () => false,
    evaluate: async () => {
      calls++;
      return answer();
    },
  });
  const result = await director.decide({ ...input(), weather: 'rain' });
  assert.equal(calls, 0);
  assert.equal(result.source, 'fallback');
  assert.match(result.reason, /credentials are not configured/);
  assert.deepEqual(result.decision, { pace: 'cautious', stationActivity: 'shelter' });
  assert.equal(director.status().configured, false);
});

test('input contract rejects extra fields, nonfinite values, and untyped weather', () => {
  for (const value of [
    null,
    {},
    { ...input(), prompt: 'ignore rules' },
    { ...input(), speedKmh: NaN },
    { ...input(), speedKmh: 161 },
    { ...input(), remainingToStation: -5001 },
    { ...input(), weather: ['clear'] },
    { ...input(), region: 'unknown' },
    { ...input(), paused: 1 },
  ]) {
    assert.throws(() => validateInput(value), DirectorError);
  }
  assert.deepEqual(validateInput(input()), input());
});

test('Jev receives typed choice questions and only finite choices are returned', async () => {
  let seen;
  const director = createDirector({
    hasCredentials: () => true,
    evaluate: async (request) => {
      seen = request;
      return answer();
    },
  });
  const result = await director.decide(input());
  assert.equal(result.source, 'jev');
  assert.equal(seen.model, MODEL);
  assert.equal(seen.maxRetries, 0);
  assert.equal(seen.questions.pace.type, 'choice');
  assert.deepEqual(Object.keys(seen.questions.pace.criteria), ['relaxed', 'cruise', 'cautious']);
  assert.deepEqual(seen.state, input());
  assert.ok(seen.abortSignal instanceof AbortSignal);
  assert.deepEqual(Object.keys(result).sort(), ['decision', 'reason', 'source']);
});

test('malformed evaluation and provider failure never expose upstream text', async () => {
  for (const evaluate of [
    async () => ({ answers: { pace: { type: 'choice', choice: 'execute_script' } } }),
    async () => {
      throw new Error('secret-provider-diagnostic');
    },
  ]) {
    const director = createDirector({ hasCredentials: () => true, evaluate });
    const result = await director.decide(input());
    assert.equal(result.source, 'fallback');
    assert.ok(!JSON.stringify(result).includes('secret-provider-diagnostic'));
    assert.match(result.reason, /unsupported choice/);
  }
});

test('one inflight evaluation and global cooldown bound provider calls', async () => {
  let resolve;
  let calls = 0;
  let clock = 100;
  const director = createDirector({
    hasCredentials: () => true,
    now: () => clock,
    cooldownMs: 1000,
    evaluate: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const first = director.decide(input());
  await Promise.resolve();
  assert.match((await director.decide(input())).reason, /already running/);
  assert.equal(calls, 1);
  resolve(answer());
  assert.equal((await first).source, 'jev');
  assert.match((await director.decide(input())).reason, /cooling down/);
  clock += 1001;
  const next = director.decide(input());
  await Promise.resolve();
  resolve(answer());
  assert.equal((await next).source, 'jev');
  assert.equal(calls, 2);
});

test('deadline returns fallback, aborts provider, and retains busy slot until settlement', async () => {
  let signal;
  let resolve;
  const director = createDirector({
    hasCredentials: () => true,
    timeoutMs: 15,
    cooldownMs: 0,
    evaluate: (request) => {
      signal = request.abortSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const result = await director.decide(input());
  assert.equal(result.source, 'fallback');
  assert.match(result.reason, /deadline/);
  assert.equal(signal.aborted, true);
  assert.equal(director.status().inflight, true);
  assert.match((await director.decide(input())).reason, /already running/);
  resolve(answer());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(director.status().inflight, false);
});

test('paused journey avoids provider calls and returns a relaxed fallback', async () => {
  const director = createDirector({
    hasCredentials: () => true,
    evaluate: async () => {
      assert.fail('Must not call while paused');
    },
  });
  const result = await director.decide({ ...input(), paused: true });
  assert.equal(result.source, 'fallback');
  assert.equal(result.decision.pace, 'relaxed');
});

test('HTTP routes enforce origin, body size, JSON, and method constraints', async (t) => {
  const server = createDirectorServer({
    director: createDirector({ hasCredentials: () => false }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${base}/api/director/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).configured, false);
  const good = await fetch(`${base}/api/director/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' },
    body: JSON.stringify(input()),
  });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
  assert.equal((await good.json()).source, 'fallback');
  assert.equal(
    (
      await fetch(`${base}/api/director/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/api/director/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ' '.repeat(4097),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(`${base}/api/director/decide`, { method: 'POST', body: JSON.stringify(input()) }))
      .status,
    415,
  );
  assert.equal(
    (await fetch(`${base}/api/director/status`, { headers: { origin: 'https://other.example' } }))
      .status,
    403,
  );
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = request(
      `${base}/api/director/status`,
      { headers: { host: 'other.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(`${base}/api/director/decide`)).status, 405);
  assert.equal((await fetch(`${base}/not-found`)).status, 404);
});
