import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRecoveryController } from './browserRecovery.js';

test('coalesces concurrent recovery requests', async () => {
  let ready = false;
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new BrowserRecoveryController({
    isReady: () => ready,
    recover: async () => {
      calls += 1;
      await gate;
      ready = true;
    },
    delaysMs: [1],
  });

  const first = controller.request('disconnect');
  const second = controller.request('second signal');
  release?.();

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls, 1);
});

test('retries with backoff until recovery succeeds', async () => {
  let ready = false;
  let calls = 0;
  const attempts: number[] = [];
  const controller = new BrowserRecoveryController({
    isReady: () => ready,
    recover: async () => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
      ready = true;
    },
    delaysMs: [1],
    onAttempt: ({ attempt }) => attempts.push(attempt),
  });

  assert.equal(await controller.request('startup failed'), true);
  assert.equal(calls, 3);
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('ensureReady times out without stopping background recovery', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready = false;
  const controller = new BrowserRecoveryController({
    isReady: () => ready,
    recover: async () => {
      await gate;
      ready = true;
    },
  });

  assert.equal(await controller.ensureReady('request waiting', 5), false);
  release?.();
  assert.equal(await controller.request('still recovering'), true);
});

test('stop cancels a pending retry', async () => {
  let calls = 0;
  const controller = new BrowserRecoveryController({
    isReady: () => false,
    recover: async () => { calls += 1; },
    delaysMs: [1_000],
  });

  const recovery = controller.request('disconnect');
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.stop();

  assert.equal(await recovery, false);
  assert.equal(calls, 1);
});
