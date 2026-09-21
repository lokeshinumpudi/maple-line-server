import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationGate } from '../src/evaluation-gate.js';

test('world requests wait for a background evaluation and retain priority', async () => {
  const completions = [];
  let calls = 0;
  const gate = createEvaluationGate(() => {
    calls++;
    return new Promise((resolve) => completions.push(resolve));
  });
  const background = gate.background({});
  await Promise.resolve();
  const world = gate.foreground({});
  assert.equal(calls, 1);
  await assert.rejects(gate.background({}), /busy/);
  completions.shift()('background');
  await background;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  completions.shift()('world');
  assert.equal(await world, 'world');
});

test('a cancelled queued world never reaches the provider', async () => {
  let complete,
    calls = 0;
  const gate = createEvaluationGate(() => {
    calls++;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const background = gate.background({});
  await Promise.resolve();
  const controller = new AbortController();
  const world = gate.foreground({ abortSignal: controller.signal });
  controller.abort();
  await assert.rejects(world, /Cancelled/);
  assert.equal(calls, 1);
  complete('done');
  await background;
});
