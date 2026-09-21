import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldPlanner, validateWorldRequest } from '../src/world-planner.js';
import { createDirectorServer } from '../src/server.js';
import { WORLD_CHOICES, seedFromPrompt } from '@maple-line/world-spec';

const choices = {
  season: 'spring',
  forest: 'sparse',
  settlement: 'rural',
  weather: 'clear',
  time: 'daylight',
  coverage: 'supported',
};
const answer = (patch = {}) => ({
  answers: Object.fromEntries(
    Object.entries({ ...choices, ...patch }).map(([key, choice]) => [
      key,
      { type: 'choice', choice },
    ]),
  ),
});
const body = { prompt: 'A quiet blossom village in daylight' };

test('world descriptions are bounded and accept no extra instructions or fields', () => {
  for (const input of [
    null,
    [],
    {},
    { prompt: '' },
    { prompt: 'ab' },
    { prompt: 'a'.repeat(601) },
    { prompt: 7 },
    { ...body, script: 'run me' },
  ])
    assert.throws(() => validateWorldRequest(input));
  assert.equal(validateWorldRequest({ prompt: `  ${body.prompt}  ` }), body.prompt);
});

test('world evaluation returns only supported choices and a server-derived seed', async () => {
  let request;
  const planner = createWorldPlanner({
    hasCredentials: () => true,
    evaluate: async (value) => {
      request = value;
      return answer();
    },
  });
  const result = await planner.plan(body);
  assert.equal(result.source, 'jev');
  assert.equal(result.coverage, 'supported');
  assert.equal(result.plan.seed, seedFromPrompt(body.prompt));
  assert.deepEqual(request.state, { description: body.prompt });
  assert.equal(request.maxRetries, 0);
  for (const [key, values] of Object.entries(WORLD_CHOICES))
    assert.deepEqual(request.questions[key].criteria, values);
});

test('provider errors, malformed output and missing credentials never create a fake Jev world', async () => {
  for (const evaluate of [
    async () => answer({ weather: 'lava' }),
    async () => answer({ coverage: 'always-approve' }),
    async () => ({}),
    async () => {
      throw new Error('private-upstream-detail');
    },
  ]) {
    const planner = createWorldPlanner({ hasCredentials: () => true, evaluate });
    await assert.rejects(
      planner.plan(body),
      (error) => error.status === 503 && !error.message.includes('private-upstream-detail'),
    );
  }
  const unconfigured = createWorldPlanner({
    hasCredentials: () => false,
    evaluate: () => assert.fail('No credentials'),
  });
  await assert.rejects(unconfigured.plan(body), (error) => error.status === 503);
});

test('deadline retains its occupied slot until the provider settles', async () => {
  let resolve, signal;
  const planner = createWorldPlanner({
    hasCredentials: () => true,
    timeoutMs: 10,
    cooldownMs: 0,
    evaluate: (request) => {
      signal = request.abortSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await assert.rejects(planner.plan(body), (error) => error.status === 503);
  assert.equal(signal.aborted, true);
  await assert.rejects(planner.plan(body), (error) => error.status === 429);
  resolve(answer());
});

test('world route applies HTTP validation and returns the planner contract', async (t) => {
  const server = createDirectorServer({
    worldPlanner: createWorldPlanner({
      hasCredentials: () => true,
      evaluate: async () => answer(),
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/director/world`;
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(body) })).status, 415);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'jev');
  const invalid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, seed: -1 }),
  });
  assert.equal(invalid.status, 400);
});
