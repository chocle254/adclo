import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import catalog from './data/catalog.json' with { type: 'json' };
import { createYouCamClient, createMockClient, YouCamError } from './lib/youcam.js';
import { rankGarments, NEEDS, FEATURE_TEXT } from './lib/match.js';
import { orderOutfit } from './lib/outfit.js';
import { CATEGORIES, OCCASIONS, suggestFor, styleMe } from './lib/stylist.js';
import { createGroqClient, GroqError } from './lib/groq.js';
import { runStylist } from './lib/agent.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

const ai = process.env.GROQ_API_KEY
  ? createGroqClient({ apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || undefined })
  : null;

const apiKey = process.env.YOUCAM_API_KEY;
const client = apiKey
  ? createYouCamClient({ apiKey, baseUrl: process.env.YOUCAM_BASE_URL })
  : createMockClient();

// Where product photos can be fetched from the internet. On Vercel this is the production domain,
// so YouCam downloads garments by URL. Locally there is none, so garments are uploaded instead.
const publicBase = process.env.PUBLIC_BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null);

// Uploaded garment file ids, reused while this server instance is alive.
const refCache = new Map();
const MIME = { '.jpg': 'image/jpg', '.jpeg': 'image/jpg', '.png': 'image/png' };

async function garmentRef(item) {
  if (publicBase && client.mode === 'live') return { refFileUrl: `${publicBase}/garments/${item.image}` };
  if (!refCache.has(item.id)) {
    const buffer = await readFile(path.join(publicDir, 'garments', item.image));
    const contentType = MIME[path.extname(item.image).toLowerCase()] || 'image/jpg';
    refCache.set(item.id, await client.uploadImage(buffer, contentType, item.image));
  }
  return { refFileId: refCache.get(item.id) };
}

function parseDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { buffer: Buffer.from(m[2], 'base64'), contentType: m[1] === 'png' ? 'image/png' : 'image/jpg' };
}

// Reads the shopper's profile from the query string or JSON body.
function profileFrom(src = {}) {
  const raw = Array.isArray(src.needs) ? src.needs : String(src.needs || '').split(',');
  const needs = raw.map((s) => String(s).trim()).filter((k) => NEEDS[k]);
  const forWho = ['mens', 'womens'].includes(src.for) ? src.for : 'all';
  return { needs, forWho };
}

// Ranks the catalog for this shopper, keeping only what they shop for.
function rankedFor({ needs, forWho }) {
  const pool = catalog.filter((i) => forWho === 'all' || i.for === forWho || i.for === 'unisex');
  return rankGarments(pool, needs).map((item) => ({
    ...item,
    featureText: item.features.map((f) => FEATURE_TEXT[f] || f),
  }));
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(publicDir)); // Vercel serves public/ from its CDN; this is for local runs.

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: client.mode, ai: Boolean(ai) }));

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
app.post('/api/transcribe', express.raw({ type: 'audio/*', limit: '4mb' }), async (req, res) => {
  if (!ai) return res.status(503).json({ error: 'ai_unavailable' });
  if (!req.body?.length) return res.status(400).json({ error: 'empty_audio' });
  try {
    res.json({ text: await ai.transcribe(req.body, req.get('content-type')) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- Try-on ----
// Stateless, so it works on serverless hosts. The page drives the steps:
//   1. POST /api/tryon/start  -> uploads the photo, returns its file id and the dressing order
//   2. POST /api/tryon/step   -> dresses one piece on a photo (the original or the last result)
//   3. GET  /api/tryon/:task  -> checks whether that step is done

const byId = (id) => catalog.find((g) => g.id === id);

app.post('/api/tryon/start', async (req, res) => {
  const ids = Array.isArray(req.body?.garmentIds) ? req.body.garmentIds.slice(0, 5) : [];
  const picked = ids.map(byId);
  if (!picked.length || picked.includes(undefined)) return res.status(400).json({ error: 'unknown_garment' });

  const photo = parseDataUrl(req.body?.photo);
  if (!photo) return res.status(400).json({ error: 'invalid_photo' });
  if (photo.buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'exceed_max_filesize' });

  try {
    const fileId = await client.uploadImage(photo.buffer, photo.contentType, 'me.jpg');
    res.json({ fileId, order: orderOutfit(picked).map((g) => g.id) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/tryon/step', async (req, res) => {
  const item = byId(req.body?.garmentId);
  if (!item) return res.status(400).json({ error: 'unknown_garment' });

  const { srcFileId, srcUrl } = req.body ?? {};
  const okUrl = typeof srcUrl === 'string'
    && (srcUrl.startsWith('https://') || (client.mode === 'mock' && srcUrl.startsWith('data:image/')));
  if (!srcFileId && !okUrl) return res.status(400).json({ error: 'invalid_photo' });

  try {
    const taskId = await client.startTryOn({
      ...(okUrl ? { srcFileUrl: srcUrl } : { srcFileId: String(srcFileId) }),
      ...(await garmentRef(item)),
      category: item.category,
    });
    res.json({ taskId });
  } catch (err) {
    refCache.delete(item.id); // an uploaded garment id may have expired
    sendError(res, err);
  }
});

app.get('/api/tryon/:taskId', async (req, res) => {
  try {
    res.json(await client.getTryOn(req.params.taskId));
  } catch (err) {
    sendError(res, err);
  }
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

// Vercel imports the app and handles requests itself; locally we start a server.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`AdClo running at http://localhost:${port} (${client.mode} mode)`);
    if (client.mode === 'mock') console.log('No YOUCAM_API_KEY set: try-on returns your own photo.');
    console.log(ai ? `AI stylist on (${ai.model})` : 'No GROQ_API_KEY set: Style me uses rules only.');
  });
}

export default app;
