import express from 'express';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createYouCamClient, createMockClient, YouCamError } from './lib/youcam.js';
import { rankGarments, NEEDS, FEATURE_TEXT } from './lib/match.js';
import { orderOutfit, startOutfitJob } from './lib/outfit.js';
import { CATEGORIES, OCCASIONS, suggestFor, styleMe } from './lib/stylist.js';
import { createGroqClient, GroqError } from './lib/groq.js';
import { runStylist } from './lib/agent.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const garmentDir = path.join(root, 'data', 'garments');
const catalog = JSON.parse(await readFile(path.join(root, 'data', 'catalog.json'), 'utf8'));

const ai = process.env.GROQ_API_KEY
  ? createGroqClient({ apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || undefined })
  : null;

const apiKey = process.env.YOUCAM_API_KEY;
const client = apiKey
  ? createYouCamClient({ apiKey, baseUrl: process.env.YOUCAM_BASE_URL })
  : createMockClient();

// Uploaded garment file ids, reused so each garment is only uploaded once.
const refCache = new Map();

const MIME = { '.jpg': 'image/jpg', '.jpeg': 'image/jpg', '.png': 'image/png' };

async function hasImage(item) {
  try {
    await access(path.join(garmentDir, item.image));
    return true;
  } catch {
    return false;
  }
}

function parseDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  return { buffer, contentType: m[1] === 'png' ? 'image/png' : 'image/jpg' };
}

async function garmentFileId(item) {
  if (refCache.has(item.id)) return refCache.get(item.id);
  const buffer = await readFile(path.join(garmentDir, item.image));
  const contentType = MIME[path.extname(item.image).toLowerCase()] || 'image/jpg';
  const id = await client.uploadImage(buffer, contentType, item.image);
  refCache.set(item.id, id);
  return id;
}

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(root, 'public')));
app.use('/garments', express.static(garmentDir));

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: client.mode, ai: Boolean(ai) }));

// Product photos don't change while the server runs, so check them once.
const withImage = new Set();
for (const item of catalog) if (await hasImage(item)) withImage.add(item.id);

// Reads the shopper's profile from the query string or JSON body.
function profileFrom(src = {}) {
  const raw = Array.isArray(src.needs) ? src.needs : String(src.needs || '').split(',');
  const needs = raw.map((s) => String(s).trim()).filter((k) => NEEDS[k]);
  const forWho = ['mens', 'womens'].includes(src.for) ? src.for : 'all';
  return { needs, forWho };
}

// Ranks the catalog for this shopper, keeping only what they shop for and what has a photo.
function rankedFor({ needs, forWho }) {
  const pool = catalog.filter(
    (i) => withImage.has(i.id) && (forWho === 'all' || i.for === forWho || i.for === 'unisex'),
  );
  return rankGarments(pool, needs).map((item) => ({
    ...item,
    featureText: item.features.map((f) => FEATURE_TEXT[f] || f),
  }));
}

app.get('/api/meta', (_req, res) => {
  res.json({
    needs: Object.entries(NEEDS).map(([id, n]) => ({ id, label: n.label, short: n.short })),
    categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, ...c })),
    occasions: Object.entries(OCCASIONS).map(([id, o]) => ({ id, label: o.label })),
  });
});

app.get('/api/shop', (req, res) => {
  const items = rankedFor(profileFrom(req.query));
  const category = req.query.category;
  res.json({ items: CATEGORIES[category] ? items.filter((i) => i.category === category) : items });
});

app.get('/api/products/:id', (req, res) => {
  const ranked = rankedFor(profileFrom(req.query));
  const item = ranked.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'unknown_garment' });
  res.json({ item, suggestions: suggestFor(item, ranked) });
});

app.post('/api/style-me', (req, res) => {
  const profile = profileFrom(req.body);
  const budget = Number(req.body?.budget) > 0 ? Number(req.body.budget) : null;
  const occasion = OCCASIONS[req.body?.occasion] ? req.body.occasion : 'everyday';
  res.json(styleMe(rankedFor(profile), { occasion, budget }));
});

// AI stylist: free-text (or spoken) request -> a full outfit with reasons.
app.post('/api/stylist', async (req, res) => {
  if (!ai) return res.status(503).json({ error: 'ai_unavailable' });
  const message = String(req.body?.message || '').trim().slice(0, 600);
  if (message.length < 3) return res.status(400).json({ error: 'empty_request' });
  try {
    const profile = profileFrom(req.body);
    res.json(await runStylist(ai, { message, profile: { needs: profile.needs, for: profile.forWho }, rankFor: rankedFor }));
  } catch (err) {
    sendError(res, err);
  }
});

// Voice input: a short recording -> text, so people can ask without typing.
app.post('/api/transcribe', express.raw({ type: 'audio/*', limit: '8mb' }), async (req, res) => {
  if (!ai) return res.status(503).json({ error: 'ai_unavailable' });
  if (!req.body?.length) return res.status(400).json({ error: 'empty_audio' });
  try {
    res.json({ text: await ai.transcribe(req.body, req.get('content-type')) });
  } catch (err) {
    sendError(res, err);
  }
});

// Outfit jobs run in the background; the page polls for progress.
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
let jobSeq = 0;

app.post('/api/outfit', async (req, res) => {
  const ids = Array.isArray(req.body?.garmentIds) ? req.body.garmentIds : [];
  const picked = ids.map((id) => catalog.find((g) => g.id === id));
  if (!picked.length || picked.includes(undefined)) return res.status(400).json({ error: 'unknown_garment' });
  for (const g of picked) {
    if (!withImage.has(g.id)) return res.status(400).json({ error: 'garment_image_missing' });
  }

  const photo = parseDataUrl(req.body?.photo);
  if (!photo) return res.status(400).json({ error: 'invalid_photo' });
  if (photo.buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'exceed_max_filesize' });

  try {
    const srcFileId = await client.uploadImage(photo.buffer, photo.contentType, 'me.jpg');
    const garments = orderOutfit(picked);
    const job = startOutfitJob(client, {
      srcFileId,
      garments,
      refIdFor: async (g) => {
        try {
          return await garmentFileId(g);
        } catch (err) {
          refCache.delete(g.id); // the cached id may have expired
          throw err;
        }
      },
    });
    const id = `job-${Date.now().toString(36)}-${++jobSeq}`;
    jobs.set(id, job);
    job.done.finally(() => setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref());
    res.json({ jobId: id, order: garments.map((g) => g.id) });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/outfit/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown_job' });
  const { state, code, url, steps } = job;
  res.json({ state, code, url, steps });
});

function sendError(res, err) {
  if (err instanceof GroqError) {
    console.error(`AI error ${err.status} ${err.code}: ${err.message}`);
    return res.status(err.status === 429 ? 429 : 502).json({ error: err.status === 429 ? 'ai_busy' : 'ai_error' });
  }
  if (err instanceof YouCamError) {
    console.error(`YouCam error ${err.status} ${err.code}: ${err.message}`);
    const status = err.status >= 400 && err.status < 500 ? 400 : 502;
    return res.status(status).json({ error: err.code });
  }
  console.error(err);
  res.status(500).json({ error: 'server_error' });
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`AdClo running at http://localhost:${port} (${client.mode} mode)`);
  if (client.mode === 'mock') console.log('No YOUCAM_API_KEY set: try-on returns your own photo.');
  console.log(ai ? `AI stylist on (${ai.model})` : 'No GROQ_API_KEY set: Style me uses rules only.');
});
