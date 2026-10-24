// Thin client for the YouCam AI Clothes VTO API (cloth-v4).
// Docs: https://docs.perfectcorp.com/reference/ai_clothes

const DEFAULT_BASE = 'https://yce-api-01.makeupar.com';

// The docs mention more than one upload path. We try them in order and
// remember the first one that works.
const FILE_PATHS = ['/s2s/v2.0/file/cloth-v4', '/s2s/v2.0/file/cloth-v3', '/s2s/v2.0/file'];

export const GARMENT_CATEGORIES = ['upper_body', 'lower_body', 'full_body', 'outer', 'shoes', 'auto'];

export class YouCamError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Turn a task-status response into {state: 'running'|'done'|'error', url?, code?}.
export function normalizeStatus(json) {
  const d = json?.data ?? json ?? {};
  const status = d.task_status ?? d.status;
  if (status === 'success') {
    const url =
      d.results?.url ?? d.results?.[0]?.url ?? d.result?.url ?? d.url ?? null;
    return url ? { state: 'done', url } : { state: 'error', code: 'missing_result_url' };
  }
  if (status === 'error') {
    return { state: 'error', code: d.error || 'unknown_internal_error' };
  }
  return { state: 'running' };
}

export function createYouCamClient({ apiKey, baseUrl = DEFAULT_BASE, fetchImpl = fetch, retryDelayMs = 1500 }) {
  let filePath = null;

  // Retries once when the connection itself fails (common on mobile networks).
  // HTTP errors from YouCam are not retried.
  async function send(url, opts) {
    try {
      return await fetchImpl(url, opts);
    } catch (err) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      try {
        return await fetchImpl(url, opts);
      } catch {
        throw new YouCamError('Could not reach the try-on service', 'network_error', 503);
      }
    }
  }

  async function call(method, path, body) {
    const res = await send(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new YouCamError(
        json.error || json.message || `YouCam request failed (${res.status})`,
        json.error_code || json.error || 'http_error',
        res.status,
      );
    }
    return json;
  }

  async function uploadImage(buffer, contentType, fileName) {
    const body = {
      files: [{ content_type: contentType, file_name: fileName, file_size: buffer.length }],
    };
    let json;
    for (const path of filePath ? [filePath] : FILE_PATHS) {
      try {
        json = await call('POST', path, body);
        filePath = path;
        break;
      } catch (err) {
        if (err.status === 404 && !filePath) continue;
        throw err;
      }
    }
    if (!json) throw new YouCamError('No working file upload endpoint', 'file_endpoint', 404);

    const file = json.data?.files?.[0];
    const req = file?.requests?.[0];
    if (!file?.file_id || !req?.url) {
      throw new YouCamError('Unexpected upload response', 'bad_upload_response', 502);
    }

    // fetch sets Content-Length itself; passing it manually can make the request fail.
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-length') delete headers[k];

    const put = await send(req.url, { method: req.method || 'PUT', headers, body: buffer });
    if (!put.ok) throw new YouCamError(`Image upload failed (${put.status})`, 'upload_failed', put.status);
    return file.file_id;
  }

  // The person can be an uploaded file (srcFileId) or a URL, such as a previous try-on result.
  async function startTryOn({ srcFileId, srcFileUrl, refFileId, category }) {
    const json = await call('POST', '/s2s/v2.0/task/cloth-v4', {
      ...(srcFileUrl ? { src_file_url: srcFileUrl } : { src_file_id: srcFileId }),
      ref_file_id: refFileId,
      garment_category: category,
      // Keep the person's own shoes. Many people wear specific footwear (orthotics, shoes that fit over braces).
      ...(category === 'lower_body' || category === 'full_body' ? { change_shoes: false } : {}),
    });
    const taskId = json.data?.task_id;
    if (!taskId) throw new YouCamError('No task id returned', 'bad_task_response', 502);
    return taskId;
  }

  async function getTryOn(taskId) {
    const json = await call('GET', `/s2s/v2.0/task/cloth-v4/${encodeURIComponent(taskId)}`);
    return normalizeStatus(json);
  }

  return { mode: 'live', uploadImage, startTryOn, getTryOn };
}

// Works without an API key: "try-on" returns your own photo after a short delay.
// Lets you build the UI without spending API units.
export function createMockClient({ delayMs = 2500 } = {}) {
  const files = new Map();
  const tasks = new Map();
  let n = 0;
  return {
    mode: 'mock',
    async uploadImage(buffer, contentType) {
      const id = `mock-file-${++n}`;
      files.set(id, `data:${contentType.replace('image/jpg', 'image/jpeg')};base64,${buffer.toString('base64')}`);
      return id;
    },
    async startTryOn({ srcFileId, srcFileUrl }) {
      const id = `mock-task-${++n}`;
      tasks.set(id, { src: srcFileUrl ?? files.get(srcFileId), at: Date.now() });
      return id;
    },
    async getTryOn(taskId) {
      const t = tasks.get(taskId);
      if (!t) return { state: 'error', code: 'unknown_task' };
      if (Date.now() - t.at < delayMs) return { state: 'running' };
      return { state: 'done', url: t.src };
    },
  };
}
