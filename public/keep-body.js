// Keeps a try-on true to the person's real body.
// Try-on AI draws trousers on two full legs, so on a photo of someone with a limb difference
// it invents a leg. We find the person's outline in their original photo, keep the new
// garment only inside that outline, and put the original photo back everywhere else.
// Runs in the browser, and only for shoppers who tick the limb-difference need.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

let segmenterP = null;
function segmenter() {
  segmenterP ??= (async () => {
    const { ImageSegmenter, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    return ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })().catch((err) => { segmenterP = null; throw err; });
  return segmenterP;
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('image_load_failed'));
  img.src = src;
});

// The person's outline (hair, skin, clothes) as an alpha mask the size of the photo.
// The model sees 256x256, so we also run it on overlapping tiles to get sharp edges
// around legs and feet, and keep the highest score per pixel.
const masks = new Map();
async function personMask(photoUrl) {
  if (masks.has(photoUrl)) return masks.get(photoUrl);
  const seg = await segmenter();
  const img = await loadImage(photoUrl);
  const W = img.naturalWidth, H = img.naturalHeight;
  const person = seg.getLabels().map((l, i) => i).filter((i) => !/background|others/.test(seg.getLabels()[i]));
  const prob = new Float32Array(W * H);

  const pass = (sx, sy, sw, sh) => {
    const c = new OffscreenCanvas(sw, sh);
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = seg.segment(c);
    const parts = person.map((i) => out.confidenceMasks[i]);
    const mw = parts[0].width, mh = parts[0].height;
    const data = parts.map((m) => m.getAsFloat32Array());
    for (let y = 0; y < sh; y++) {
      const my = Math.min(mh - 1, Math.floor((y * mh) / sh)) * mw;
      for (let x = 0; x < sw; x++) {
        const k = my + Math.min(mw - 1, Math.floor((x * mw) / sw));
        let v = 0;
        for (const d of data) v += d[k];
        const p = (sy + y) * W + sx + x;
        if (v > prob[p]) prob[p] = v;
      }
    }
    out.close();
  };
  pass(0, 0, W, H);
  const T = Math.round(Math.min(W, H) * 0.6);
  for (const fy of [0, 0.5, 1]) for (const fx of [0, 0.5, 1]) pass(Math.round((W - T) * fx), Math.round((H - T) * fy), T, T);

  const hard = new OffscreenCanvas(W, H);
  const hx = hard.getContext('2d');
  const px = hx.createImageData(W, H);
  for (let i = 0; i < prob.length; i++) px.data[i * 4 + 3] = prob[i] > 0.5 ? 255 : 0;
  hx.putImageData(px, 0, 0);

  // Grow the outline a little so new hems and cuffs aren't clipped, then soften the edge.
  const s = Math.max(W, H) / 1200;
  const grown = new OffscreenCanvas(W, H);
  const gx = grown.getContext('2d');
  gx.filter = `blur(${4 * s}px)`;
  gx.drawImage(hard, 0, 0);
  const gd = gx.getImageData(0, 0, W, H);
  for (let i = 3; i < gd.data.length; i += 4) gd.data[i] = gd.data[i] > 20 ? 255 : 0;
  gx.putImageData(gd, 0, 0);
  const soft = new OffscreenCanvas(W, H);
  const sx = soft.getContext('2d');
  sx.filter = `blur(${2 * s}px)`;
  sx.drawImage(grown, 0, 0);

  const mask = { canvas: soft, W, H };
  masks.set(photoUrl, mask);
  return mask;
}

// Starts the model download early (e.g. when the try-on sheet opens).
export function warmUp(photoUrl) { personMask(photoUrl).catch(() => {}); }

// Returns a JPEG data URL: `resultUrl` inside the person's original outline, `baseUrl` outside it.
// `photoUrl` is their original photo; `baseUrl` is the picture before this garment went on.
export async function keepRealBody({ photoUrl, baseUrl, resultUrl }) {
  const mask = await personMask(photoUrl);
  const [base, result] = await Promise.all([loadImage(baseUrl), loadImage(resultUrl)]);
  const { W, H } = mask;
  const out = new OffscreenCanvas(W, H);
  const ox = out.getContext('2d');
  ox.drawImage(result, 0, 0, W, H);
  ox.globalCompositeOperation = 'destination-in';
  ox.drawImage(mask.canvas, 0, 0);
  ox.globalCompositeOperation = 'destination-over';
  ox.drawImage(base, 0, 0, W, H);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
