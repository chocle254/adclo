import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderOutfit, startOutfitJob } from '../lib/outfit.js';
import { createMockClient } from '../lib/youcam.js';

const top = { id: 'top', name: 'Top', category: 'upper_body' };
const top2 = { id: 'top2', name: 'Top 2', category: 'upper_body' };
const pants = { id: 'pants', name: 'Pants', category: 'lower_body' };
const coat = { id: 'coat', name: 'Coat', category: 'outer' };
const dress = { id: 'dress', name: 'Dress', category: 'full_body' };

test('dresses bottoms first, then top, then jacket', () => {
  assert.deepEqual(orderOutfit([coat, top, pants]).map((g) => g.id), ['pants', 'top', 'coat']);
});

test('keeps one piece per slot, last pick wins', () => {
  assert.deepEqual(orderOutfit([top, top2]).map((g) => g.id), ['top2']);
});

test('a full-body piece replaces top and bottoms', () => {
  assert.deepEqual(orderOutfit([top, pants, dress, coat]).map((g) => g.id), ['dress', 'coat']);
});

test('each step uses the previous result as its photo', async () => {
  const calls = [];
  const mock = createMockClient({ delayMs: 0 });
  const client = { ...mock, startTryOn: (args) => { calls.push(args); return mock.startTryOn(args); } };
  const srcFileId = await mock.uploadImage(Buffer.from('me'), 'image/jpg');
  const job = startOutfitJob(client, { srcFileId, garments: [pants, top], refIdFor: async (g) => `ref-${g.id}`, pollMs: 1 });
  await job.done;
  assert.equal(job.state, 'done');
  assert.equal(calls[0].srcFileId, srcFileId);
  assert.equal(calls[1].srcFileUrl, job.steps[0].url);
  assert.deepEqual(calls.map((c) => c.category), ['lower_body', 'upper_body']);
  assert.ok(job.url);
});

test('a failed step keeps earlier results and stops', async () => {
  const mock = createMockClient({ delayMs: 0 });
  let n = 0;
  const client = {
    ...mock,
    getTryOn: async (id) => (++n === 2 ? { state: 'error', code: 'error_pose' } : mock.getTryOn(id)),
  };
  const srcFileId = await mock.uploadImage(Buffer.from('me'), 'image/jpg');
  const job = startOutfitJob(client, { srcFileId, garments: [pants, top, coat], refIdFor: async () => 'r', pollMs: 1 });
  await job.done;
  assert.equal(job.state, 'error');
  assert.equal(job.code, 'error_pose');
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'error', 'pending']);
  assert.equal(job.url, job.steps[0].url);
});
