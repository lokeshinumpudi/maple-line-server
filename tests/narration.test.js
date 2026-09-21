import test from 'node:test';
import assert from 'node:assert/strict';
import { createNarration } from '../src/narration.js';
import { createDirectorServer } from '../src/server.js';
const wav = Buffer.alloc(48);
wav.write('RIFF');
wav.write('WAVE', 8);
const speech = () => Response.json({ audios: [wav.toString('base64')] });

test('English uses TTS directly; Telugu translates first and repeated dialogue is cached', async () => {
  const calls = [];
  const narration = createNarration({
    apiKey: 'test-only',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body, headers: options.headers });
      return url.endsWith('/translate')
        ? Response.json({ translated_text: 'రైలుకు స్వాగతం' })
        : speech();
    },
  });
  await narration.speak({ text: 'Welcome aboard.', language: 'en-IN' });
  const result = await narration.speak({ text: 'Welcome aboard.', language: 'te-IN' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.language_code, 'en-IN');
  assert.equal(calls[1].body.source_language_code, 'en-IN');
  assert.equal(calls[1].body.target_language_code, 'te-IN');
  assert.equal(calls[2].body.text, 'రైలుకు స్వాగతం');
  assert.equal(calls[2].body.model, 'bulbul:v3');
  assert.deepEqual(result.audio, wav);
  await narration.speak({ text: 'Welcome aboard.', language: 'te-IN' });
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(narration.status()).includes('test-only'), false);
});

test('validation rejects unsupported languages, missing keys and provider details stay private', async () => {
  const narration = createNarration({
    apiKey: 'test-only',
    fetchImpl: async () => {
      throw new Error('secret-provider-detail');
    },
  });
  for (const language of ['ja-JP', 'ur-IN', 'unknown'])
    await assert.rejects(narration.speak({ text: 'Hello', language }), (e) => e.status === 400);
  await assert.rejects(
    narration.speak({ text: 'Hello', language: 'en-IN', apiKey: 'injected' }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    narration.speak({ text: 'Hello', language: 'en-IN' }),
    (e) => e.status === 502 && !e.message.includes('secret'),
  );
  await assert.rejects(
    createNarration({ apiKey: '' }).speak({ text: 'Hello', language: 'en-IN' }),
    (e) => e.status === 503,
  );
});

test('deadline cancels provider work and frees the occupied slot', async () => {
  let signal;
  const narration = createNarration({
    apiKey: 'test-only',
    deadlineMs: 15,
    concurrency: 1,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    },
  });
  const pending = narration.speak({ text: 'Hello', language: 'en-IN' });
  const second = narration.speak({ text: 'Another', language: 'en-IN' });
  const secondCheck = assert.rejects(second, (e) => e.status === 504);
  await assert.rejects(pending, (e) => e.status === 504);
  await secondCheck;
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(narration.status().busy, false);
});

test('narration HTTP endpoint serves WAV without exposing key or admitting foreign origins', async (t) => {
  const server = createDirectorServer({
    narration: createNarration({ apiKey: 'test-only', fetchImpl: async () => speech() }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/api/director/narration`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Welcome.', language: 'en-IN' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  const status = await (await fetch(`${url}/status`)).json();
  assert.equal(status.languages.length, 11);
  assert.equal(JSON.stringify(status).includes('test-only'), false);
  assert.equal((await fetch(url, { headers: { origin: 'https://example.com' } })).status, 403);
});

test('cast and delivery affect synthesis and cache identity; duplicate requests share work', async () => {
  const calls = [];
  const narration = createNarration({
    apiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return speech();
    },
  });
  const cue = { text: 'I remember.', language: 'en-IN', character: 'haru', emotion: 'reflective' };
  await Promise.all([narration.speak(cue), narration.speak(cue)]);
  await narration.speak({ ...cue, character: 'emi' });
  await narration.speak({ ...cue, emotion: 'playful' });
  assert.equal(calls.length, 3);
  assert.notEqual(calls[0].speaker, calls[1].speaker);
  assert.notEqual(calls[0].pace, calls[2].pace);
  assert.equal('emotion' in calls[0], false);
  for (const invalid of [{ character: '__proto__' }, { emotion: 'unknown' }, { priority: 'admin' }])
    await assert.rejects(narration.speak({ ...cue, ...invalid }), (error) => error.status === 400);
});

test('one cancelled listener does not cancel shared speech for another listener', async () => {
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const narration = createNarration({
    apiKey: 'test-only',
    fetchImpl: async () => {
      started();
      return new Promise((resolve) => {
        finish = () => resolve(speech());
      });
    },
  });
  const cue = { text: 'Shared', language: 'en-IN' };
  const controller = new AbortController();
  const cancelled = narration.speak(cue, controller.signal);
  const kept = narration.speak(cue);
  await ready;
  controller.abort();
  await assert.rejects(cancelled, (error) => error.status === 504);
  finish();
  assert.deepEqual((await kept).audio, wav);
});

test('prepared audio survives a new engine instance without another provider call', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'maple-voice-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cue = { text: 'Saved voice', language: 'en-IN', character: 'emi', emotion: 'warm' };
  await createNarration({
    apiKey: 'test-only',
    cacheDirectory: directory,
    fetchImpl: async () => speech(),
  }).speak(cue);
  const second = createNarration({
    apiKey: '',
    cacheDirectory: directory,
    fetchImpl: async () => {
      throw new Error('Should not synthesize again');
    },
  });
  assert.deepEqual((await second.speak(cue)).audio, wav);
  assert.equal(second.status().cache.hits, 1);
});

test('queued playback precedes speculative work and concurrency is bounded', async () => {
  const calls = [],
    releases = [];
  const narration = createNarration({
    apiKey: 'test-only',
    concurrency: 1,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).text);
      return new Promise((resolve) => releases.push(() => resolve(speech())));
    },
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = narration.speak({ text: 'First', language: 'en-IN' });
  await tick();
  const background = narration.speak({
    text: 'Background',
    language: 'en-IN',
    priority: 'prefetch',
  });
  const foreground = narration.speak({ text: 'Foreground', language: 'en-IN' });
  assert.equal(narration.status().active, 1);
  releases.shift()();
  await first;
  await tick();
  assert.deepEqual(calls, ['First', 'Foreground']);
  releases.shift()();
  await foreground;
  await tick();
  releases.shift()();
  await background;
});
