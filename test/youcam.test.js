import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYouCamClient, createMockClient, normalizeStatus, YouCamError } from '../lib/youcam.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const key = `${opts.method || 'GET'} ${url.replace('https://api.test', '')}`;
    const handler = routes[key] ?? routes[key.split('?')[0]];
    if (!handler) return new Response('{"error":"Not Found"}', { status: 404 });
    const [status, body] = handler(opts);
    return new Response(JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

test('normalizeStatus handles running, success and error', () => {
  assert.deepEqual(normalizeStatus({ data: { task_status: 'running' } }), { state: 'running' });
  assert.deepEqual(
    normalizeStatus({ data: { task_status: 'success', results: { url: 'https://x/r.jpg' } } }),
    { state: 'done', url: 'https://x/r.jpg' },
  );
  assert.deepEqual(
    normalizeStatus({ data: { task_status: 'error', error: 'error_pose' } }),
    { state: 'error', code: 'error_pose' },
  );
});

test('upload falls back to the next file endpoint on 404, then PUTs the bytes', async () => {
  const fetchImpl = fakeFetch({
    'POST /s2s/v2.0/file/cloth-v3': () => [200, {
      status: 200,
      data: { files: [{ file_id: 'F1', requests: [{ method: 'PUT', url: 'https://s3.test/up', headers: { 'Content-Type': 'image/jpg', 'Content-Length': '3' } }] }] },
    }],
    'PUT https://s3.test/up': () => [200, {}],
  });
  const client = createYouCamClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  const id = await client.uploadImage(Buffer.from('abc'), 'image/jpg', 'a.jpg');
  assert.equal(id, 'F1');

  const put = fetchImpl.calls.find((c) => c.method === 'PUT');
  assert.equal(put.headers['Content-Length'], undefined);
  assert.equal(put.headers['Content-Type'], 'image/jpg');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer k');

  // Second upload goes straight to the endpoint that worked.
  await client.uploadImage(Buffer.from('abc'), 'image/jpg', 'b.jpg');
  const posts = fetchImpl.calls.filter((c) => c.method === 'POST').map((c) => c.url);
  assert.deepEqual(posts, [
    'https://api.test/s2s/v2.0/file/cloth-v4',
    'https://api.test/s2s/v2.0/file/cloth-v3',
    'https://api.test/s2s/v2.0/file/cloth-v3',
  ]);
});

test('startTryOn sends the documented body', async () => {
  let sent;
  const fetchImpl = fakeFetch({
    'POST /s2s/v2.0/task/cloth-v4': (opts) => { sent = JSON.parse(opts.body); return [200, { data: { task_id: 'T1' } }]; },
  });
  const client = createYouCamClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  const id = await client.startTryOn({ srcFileId: 'S', refFileId: 'R', category: 'upper_body' });
  assert.equal(id, 'T1');
  assert.deepEqual(sent, { src_file_id: 'S', ref_file_id: 'R', garment_category: 'upper_body' });
});

test('trousers keep the person\'s own shoes and can chain from a result URL', async () => {
  let sent;
  const fetchImpl = fakeFetch({
    'POST /s2s/v2.0/task/cloth-v4': (opts) => { sent = JSON.parse(opts.body); return [200, { data: { task_id: 'T2' } }]; },
  });
  const client = createYouCamClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  await client.startTryOn({ srcFileUrl: 'https://x/prev.jpg', refFileId: 'R', category: 'lower_body' });
  assert.deepEqual(sent, { src_file_url: 'https://x/prev.jpg', ref_file_id: 'R', garment_category: 'lower_body', change_shoes: false });
});

test('API errors surface the error code', async () => {
  const fetchImpl = fakeFetch({
    'POST /s2s/v2.0/task/cloth-v4': () => [401, { status: 401, error: 'Unauthorized', error_code: 'InvalidAccessToken' }],
  });
  const client = createYouCamClient({ apiKey: 'bad', baseUrl: 'https://api.test', fetchImpl });
  await assert.rejects(
    client.startTryOn({ srcFileId: 'S', refFileId: 'R', category: 'upper_body' }),
    (err) => err instanceof YouCamError && err.code === 'InvalidAccessToken' && err.status === 401,
  );
});

test('mock client returns the source photo after the delay', async () => {
  const mock = createMockClient({ delayMs: 0 });
  const src = await mock.uploadImage(Buffer.from('hi'), 'image/jpg');
  const task = await mock.startTryOn({ srcFileId: src, refFileId: 'x' });
  const r = await mock.getTryOn(task);
  assert.equal(r.state, 'done');
  assert.equal(r.url, `data:image/jpeg;base64,${Buffer.from('hi').toString('base64')}`);
});

test('a dropped connection is retried once, then reported plainly', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return new Response(JSON.stringify({ data: { task_id: 'T9' } }), { status: 200 }); };
  const client = createYouCamClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: flaky, retryDelayMs: 0 });
  assert.equal(await client.startTryOn({ srcFileId: 'S', refFileId: 'R', category: 'upper_body' }), 'T9');

  const dead = async () => { throw new TypeError('fetch failed'); };
  const c2 = createYouCamClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: dead, retryDelayMs: 0 });
  await assert.rejects(c2.startTryOn({ srcFileId: 'S', refFileId: 'R', category: 'upper_body' }), (e) => e.code === 'network_error');
});
