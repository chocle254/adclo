// Builds a full outfit by chaining try-ons: each result becomes the photo for the next garment.

// Dress in a natural order: trousers first, then top, then jacket.
const LAYER = { full_body: 0, lower_body: 1, shoes: 2, upper_body: 3, auto: 3, outer: 4 };

// Keeps one garment per slot (the last one picked wins) and puts them in dressing order.
// A full-body piece (like a dress) replaces any separate top or bottom.
export function orderOutfit(garments) {
  const bySlot = new Map();
  for (const g of garments) bySlot.set(g.category, g);
  if (bySlot.has('full_body')) {
    bySlot.delete('upper_body');
    bySlot.delete('lower_body');
  }
  return [...bySlot.values()].sort((a, b) => (LAYER[a.category] ?? 3) - (LAYER[b.category] ?? 3));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTask(client, taskId, { pollMs, timeoutMs }) {
  const started = Date.now();
  for (;;) {
    const r = await client.getTryOn(taskId);
    if (r.state !== 'running') return r;
    if (Date.now() - started > timeoutMs) return { state: 'error', code: 'timeout' };
    await sleep(pollMs);
  }
}

// Starts the outfit in the background and returns a job object that updates as each step finishes.
// If a step fails, earlier results stay available so the user still sees partial progress.
export function startOutfitJob(client, { srcFileId, garments, refIdFor, pollMs = 2500, timeoutMs = 120_000 }) {
  const job = {
    state: 'running',
    code: null,
    url: null,
    steps: garments.map((g) => ({ garmentId: g.id, name: g.name, state: 'pending', url: null })),
  };

  job.done = (async () => {
    let src = { srcFileId };
    for (const [i, g] of garments.entries()) {
      const step = job.steps[i];
      step.state = 'running';
      try {
        const refFileId = await refIdFor(g);
        const taskId = await client.startTryOn({ ...src, refFileId, category: g.category });
        const r = await waitForTask(client, taskId, { pollMs, timeoutMs });
        if (r.state !== 'done') throw Object.assign(new Error(r.code), { code: r.code });
        step.state = 'done';
        step.url = r.url;
        job.url = r.url;
        src = { srcFileUrl: r.url };
      } catch (err) {
        step.state = 'error';
        job.state = 'error';
        job.code = err.code || 'server_error';
        return;
      }
    }
    job.state = 'done';
  })();

  return job;
}
