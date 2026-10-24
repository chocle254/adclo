// AdClo front end: a small hash-routed shopping app.
// Views: home, category, product, style me, your look. Sheets: profile, try-on.

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- Icons ----------
const ICONS = {
  bag: '<path d="M6 7h12l1 13H5L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'i');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
};

// Replaces a node's children, skipping empty values and flattening lists.
function mount(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k in node && !k.startsWith('aria') && k !== 'role') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
  return node;
}

// ---------- Storage (per-viewer conveniences only) ----------
const store = {
  load(key, fallback) {
    try { const v = localStorage.getItem(`adclo:${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem(`adclo:${key}`, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

// ---------- State ----------
const state = {
  meta: null,
  profile: store.load('profile', { needs: [], for: 'all', size: 'M', shoe: '41', done: false }),
  photo: store.load('photo', null),
  items: [],                                  // ranked catalog for this profile
  look: new Map(store.load('look', [])),      // category -> { id, size }
  tryon: null,                                // garments in the open try-on
  seen: new Map(),                            // items from AI results outside the current profile
  ai: false,
  pollTimer: null,
};
const byId = (id) => state.items.find((i) => i.id === id) ?? state.seen.get(id);
const saveLook = () => { store.save('look', [...state.look]); updateLookCount(); };

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || 'request_failed'), { code: json.error });
  return json;
}
const profileQuery = () => new URLSearchParams({ needs: state.profile.needs.join(','), for: state.profile.for }).toString();

async function refreshItems() {
  const { items } = await api(`/api/shop?${profileQuery()}`);
  state.items = items;
  // Drop look pieces that are no longer in this profile's catalog.
  for (const [cat, entry] of state.look) if (!byId(entry.id)) state.look.delete(cat);
  saveLook();
}

// ---------- Helpers ----------
const ERRORS = {
  error_pose: "We couldn't find your shoulders. Try a photo from the chest up, facing the camera.",
  error_no_face: 'Your face needs to be visible in the photo.',
  error_invalid_src: 'The photo needs to show your upper body, not just legs or feet.',
  error_multi_person: 'Only you should be in the photo.',
  error_apply_region_mismatch: "This piece doesn't match what's visible in your photo. For trousers or shoes, use a full-body photo.",
  error_editing_failed: "The try-on didn't change much. Try a clearer, brighter photo.",
  exceed_max_filesize: 'That photo is too large. Try a smaller one.',
  error_below_min_image_size: 'That photo is too small. Try a sharper one.',
  error_nsfw_content_detected: "The photo couldn't be processed. Try another.",
  garment_image_missing: "One of these pieces doesn't have a product photo yet.",
  invalid_photo: 'Please add a JPG or PNG photo first.',
  unknown_job: 'This try-on expired. Please try again.',
  CreditInsufficiency: 'The try-on service is out of credits.',
  InvalidAccessToken: 'The try-on service key is invalid.',
  timeout: 'This is taking longer than usual. Please try again.',
  network_error: "We couldn't reach the try-on service. Check your connection and try again.",
};
const explain = (code) => ERRORS[code] || 'Something went wrong. Please try again.';
const money = (n) => `$${n}`;
const catLabel = (id) => state.meta.categories.find((c) => c.id === id)?.label ?? '';
const firstCategory = () => state.meta.categories.find((c) => state.items.some((i) => i.category === c.id))?.id ?? 'upper_body';
const catOne = (id) => state.meta.categories.find((c) => c.id === id)?.one ?? 'piece';

function fitPill(item) {
  if (item.warnings?.length) return el('span', { class: 'pill warn' }, 'Check details');
  if (item.fit == null) return null;
  if (item.fit >= 70) return el('span', { class: 'pill good' }, `${item.fit}% fit`);
  if (item.fit >= 40) return el('span', { class: 'pill mid' }, 'Partial fit');
  return el('span', { class: 'pill' }, 'Few adaptive features');
}

const WAIST = { XS: '28', S: '30', M: '32', L: '34', XL: '36', XXL: '38' };
function suggestedSize(item) {
  const want = item.category === 'shoes' ? state.profile.shoe
    : /^\d+$/.test(item.sizes[0]) ? WAIST[state.profile.size] : state.profile.size;
  return item.sizes.includes(want) ? want : null;
}

let toastTimer;
function toast(text, link) {
  const t = $('#toast');
  mount(t, el('span', {}, text), link ? el('a', { href: link.href }, link.text) : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- Look ----------
function inLook(item) { return state.look.get(item.category)?.id === item.id; }

function toggleLook(item, size = suggestedSize(item)) {
  if (inLook(item)) {
    state.look.delete(item.category);
    saveLook();
    toast(`Removed ${item.name}`);
    return false;
  }
  // One piece per slot. A dress replaces a top and bottoms, and the other way round.
  state.look.set(item.category, { id: item.id, size });
  if (item.category === 'full_body') { state.look.delete('upper_body'); state.look.delete('lower_body'); }
  if (item.category === 'upper_body' || item.category === 'lower_body') state.look.delete('full_body');
  saveLook();
  toast('Added to your look', { href: '#/look', text: 'View' });
  return true;
}

function lookItems() {
  const order = ['full_body', 'lower_body', 'upper_body', 'outer', 'shoes'];
  return order.filter((c) => state.look.has(c)).map((c) => ({ ...byId(state.look.get(c).id), chosenSize: state.look.get(c).size }));
}

function updateLookCount() {
  const n = state.look.size;
  const badge = $('#look-count');
  badge.textContent = String(n);
  badge.hidden = n === 0;
  $('#look-btn').setAttribute('aria-label', `Your look, ${n} ${n === 1 ? 'item' : 'items'}`);
}

function lookButton(item, opts = {}) {
  const btn = el('button', { type: 'button', class: `btn ghost ${opts.small ? 'sm' : ''} ${opts.class || ''}` });
  const paint = () => {
    const on = inLook(item);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '✓ In your look' : opts.label || 'Add to look';
  };
  btn.addEventListener('click', () => { toggleLook(item, opts.size?.()); paint(); });
  paint();
  return btn;
}

// ---------- Product card ----------
function productCard(item, { reason } = {}) {
  return el('li', { class: 'card' },
    el('a', { href: `#/p/${item.id}` },
      el('div', { class: 'card-img' },
        el('img', { src: `/garments/${item.image}`, alt: '', loading: 'lazy' }),
        el('span', { class: 'pill-wrap' }, fitPill(item))),
      el('div', { class: 'card-body' },
        el('span', { class: 'card-type' }, item.type),
        el('h3', {}, item.name),
        el('span', { class: 'price' }, money(item.price)),
        reason ? el('span', { class: 'why' }, reason) : null)));
}

// ---------- Views ----------
const view = () => $('#view');

function profileStrip() {
  const p = state.profile;
  const needs = state.meta.needs.filter((n) => p.needs.includes(n.id));
  return el('div', { class: 'profile-strip' },
    el('strong', {}, 'Shopping for you:'),
    needs.length ? needs.map((n) => el('span', { class: 'tag' }, n.short)) : el('span', { class: 'muted' }, 'no needs set yet'),
    el('span', { class: 'tag' }, { mens: "Men's", womens: "Women's", all: 'Everything' }[p.for]),
    state.photo ? el('span', { class: 'tag' }, '📷 Photo added') : el('span', { class: 'tag' }, 'No photo yet'),
    el('button', { type: 'button', class: 'btn ghost sm', on: { click: openProfile } }, 'Edit'));
}

function viewHome() {
  const best = [...state.items].filter((i) => !i.warnings.length)
    .sort((a, b) => (b.fit ?? 50) - (a.fit ?? 50)).slice(0, 8);
  const cover = (cat) => state.items.find((i) => i.category === cat);

  mount(view(), 
    el('section', { class: 'hero' },
      el('div', {},
        el('h1', {}, 'Clothes that work the way you do.'),
        el('p', {}, 'Adaptive fashion ranked for your body and your day. See every piece on you, seated or standing, before you buy.'),
        el('div', { class: 'hero-actions' },
          el('a', { class: 'btn primary', href: '#/style' }, icon('spark'), 'Style me'),
          el('a', { class: 'btn ghost', href: `#/shop/${firstCategory()}` }, 'Browse the shop'))),
      el('div', { class: 'hero-art' },
        el('figure', {}, el('img', { src: '/demo/seated-sample.jpg', alt: 'A man in a wheelchair wearing a white shirt and tan trousers' }), el('figcaption', {}, 'Before')),
        el('figure', {}, el('img', { src: '/demo/seated-outfit-result.jpg', alt: 'The same man, now wearing a mint hoodie and charcoal trousers' }), el('figcaption', {}, 'Tried on')))),
    profileStrip(),

    el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', {}, 'Shop by category')),
      el('div', { class: 'tiles' }, state.meta.categories.map((c) => {
        const it = cover(c.id);
        const count = state.items.filter((i) => i.category === c.id).length;
        if (!it) return null;
        return el('a', { class: 'tile', href: `#/shop/${c.id}` },
          el('img', { src: `/garments/${it.image}`, alt: '' }),
          el('span', {}, c.label, el('small', {}, String(count))));
      }))),

    el('section', { class: 'section' },
      el('a', { class: 'style-banner', href: '#/style' },
        el('div', {}, el('h2', {}, 'Let AdClo style you'), el('p', {}, 'Pick an occasion and a budget. Get a complete outfit that works for your needs.')),
        el('span', { class: 'btn' }, icon('spark'), 'Style me'))),

    el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', {}, state.profile.needs.length ? 'Top picks for you' : 'Popular right now')),
      el('ul', { class: 'grid', role: 'list' }, best.map((i) => productCard(i, { reason: i.reasons[0] })))),
  );
}

function viewShop(category) {
  if (!state.meta.categories.some((c) => c.id === category)) return go('#/');
  const items = state.items.filter((i) => i.category === category);
  mount(view(), 
    el('h1', { class: 'page-title' }, catLabel(category)),
    el('p', { class: 'muted' }, `${items.length} pieces · ${state.profile.needs.length ? 'best fit for you first' : 'set your needs to rank these for you'}`),
    el('ul', { class: 'grid section', role: 'list' }, items.map((i) => productCard(i, { reason: i.reasons[0] || i.featureText[0] }))),
  );
}

async function viewProduct(id) {
  mount(view(), el('div', { class: 'pdp' }, el('div', { class: 'pdp-media shimmer', style: 'aspect-ratio:3/4;border-radius:24px' })));
  let data;
  try { data = await api(`/api/products/${encodeURIComponent(id)}?${profileQuery()}`); } catch { return go('#/'); }
  const { item, suggestions } = data;
  let size = state.look.get(item.category)?.id === item.id ? state.look.get(item.category).size : suggestedSize(item);
  const mySize = suggestedSize(item);

  const sizes = el('fieldset', { class: 'sizes' },
    el('legend', { class: 'sr-only' }, 'Size'),
    item.sizes.map((s) => el('label', {},
      el('input', { type: 'radio', name: 'size', value: s, checked: s === size, on: { change: () => { size = s; if (inLook(item)) { state.look.set(item.category, { id: item.id, size }); saveLook(); } } } }),
      el('span', {}, s),
      s === mySize ? el('em', { class: 'yours', 'aria-label': 'your size' }, 'YOU') : null)));

  const whyList = el('ul', { class: 'checks' },
    (state.profile.needs.length && item.reasons.length ? item.reasons : item.featureText).map((r) => el('li', {}, r)),
    item.warnings.map((w) => el('li', { class: 'warn' }, w)));

  const tryBtn = el('button', { type: 'button', class: 'btn primary full', on: { click: () => openTryOn([item]) } }, icon('camera'), 'Try it on me');

  const looks = suggestions.map((g) => el('div', { class: 'rail-group' },
    el('h3', {}, g.label),
    el('ul', { class: 'rail', role: 'list' }, g.items.map((s) => {
      const li = productCard(s, { reason: s.pairWhy });
      li.append(lookButton(s, { small: true, class: 'add', label: `Add ${catOne(s.category)}` }));
      return li;
    }))));

  mount(view(), 
    el('a', { class: 'back', href: `#/shop/${item.category}` }, icon('back'), catLabel(item.category)),
    el('div', { class: 'pdp' },
      el('div', { class: 'pdp-media' }, el('img', { src: `/garments/${item.image}`, alt: `${item.name} in ${item.color.name}` })),
      el('div', { class: 'pdp-info' },
        el('div', {},
          el('span', { class: 'card-type' }, item.type),
          el('h1', {}, item.name),
          el('p', { class: 'muted' }, el('span', { class: 'swatch', style: `background:${item.color.hex}` }), ` ${item.color.name[0].toUpperCase()}${item.color.name.slice(1)}`)),
        el('div', { class: 'pdp-price' }, money(item.price), fitPill(item),
          item.fit != null ? el('span', { class: 'muted small' }, `meets ${item.needsMet} of ${item.needsTotal} of your needs`) : null),
        el('div', {}, el('div', { class: 'label-row' }, 'Size', mySize ? el('span', {}, `Your usual: ${mySize}`) : el('span', {}, 'Pick your size')), sizes),
        el('div', { class: 'pdp-actions' },
          tryBtn,
          lookButton(item, { size: () => size }),
          el('a', { class: 'btn ghost', href: item.buyUrl, target: '_blank', rel: 'noopener' }, 'Buy from store')),
        el('section', { class: 'panel' }, el('h2', {}, state.profile.needs.length ? 'Why it works for you' : 'Adaptive features'), whyList),
        el('p', { class: 'muted' }, item.description))),
    suggestions.length ? el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', {}, 'Complete the look'),
        el('a', { href: '#/look' }, 'View your look')),
      el('p', { class: 'muted' }, `Pieces that go with the ${item.color.name} ${item.type.toLowerCase()} and suit your needs.`),
      looks) : null,
  );
}

const EXAMPLES = [
  "My cousin's wedding is Saturday. I dress with one hand and I'm in my chair all day. Nothing bright, about $200.",
  'Just a warm jacket for work, something in navy or brown.',
  'Comfy weekend clothes. Tags drive me crazy and I love green.',
];

function viewStyle() {
  const occ = store.load('occasion', 'everyday');
  const budget = store.load('budget', '');
  const result = el('div', { class: 'section', 'aria-live': 'polite' });
  const showLoading = () => mount(result, el('div', { class: 'shimmer', style: 'height:180px;border-radius:18px' }));

  // --- Ask the AI stylist (type or speak) ---
  const box = el('textarea', {
    id: 'ask', name: 'ask', rows: 3, maxLength: 600,
    placeholder: 'For example: a job interview next week, I use a wheelchair and buttons are hard. Under $250.',
  });
  box.value = store.load('ask', '');
  const voiceStatus = el('p', { class: 'muted small voice-status', role: 'status' });
  const mic = voiceButton(box, voiceStatus, () => askForm.requestSubmit());
  const askForm = el('form', { class: 'ask panel' },
    el('label', { for: 'ask', class: 'ask-label' }, icon('spark'), 'Tell AdClo what you need'),
    el('p', { class: 'muted small' }, 'The occasion, what makes dressing hard, colours you like or avoid, your budget. Type it or say it.'),
    el('div', { class: 'ask-row' }, box, mic),
    voiceStatus,
    el('div', { class: 'examples' }, EXAMPLES.map((ex) => el('button', {
      type: 'button', class: 'chip example',
      on: { click: () => { box.value = ex; box.focus(); } },
    }, ex))),
    el('button', { type: 'submit', class: 'btn accent' }, icon('spark'), 'Style me'));

  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = box.value.trim();
    if (message.length < 3) { box.focus(); return; }
    store.save('ask', message);
    showLoading();
    try {
      const look = await api('/api/stylist', { message, needs: state.profile.needs, for: state.profile.for });
      renderStyled(look, result);
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      mount(result, el('div', { class: 'empty' }, el('h2', {}, 'The stylist is busy'),
        el('p', {}, ex.code === 'ai_busy' ? 'Too many requests right now. Try again in a minute, or use the quick picks below.' : "We couldn't reach the AI stylist. Try the quick picks below.")));
    }
  });

  // --- Quick picks (no AI needed) ---
  const form = el('form', { class: 'style-form' },
    el('fieldset', { class: 'choice-row' },
      el('legend', {}, "What's the occasion?"),
      state.meta.occasions.map((o) => el('label', {},
        el('input', { type: 'radio', name: 'occasion', value: o.id, checked: o.id === occ }),
        el('span', {}, o.label)))),
    el('fieldset', { class: 'choice-row' },
      el('legend', {}, 'Budget for the whole outfit'),
      [['', 'No limit'], ['150', 'Under $150'], ['200', 'Under $200'], ['300', 'Under $300']].map(([v, l]) => el('label', {},
        el('input', { type: 'radio', name: 'budget', value: v, checked: v === budget }),
        el('span', {}, l)))),
    el('button', { type: 'submit', class: state.ai ? 'btn ghost' : 'btn accent' }, icon('spark'), state.ai ? 'Style me with these' : 'Style me'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const occasion = fd.get('occasion');
    const b = fd.get('budget') || '';
    store.save('occasion', occasion);
    store.save('budget', b);
    showLoading();
    const look = await api('/api/style-me', { needs: state.profile.needs, for: state.profile.for, occasion, budget: b || null });
    renderStyled(look, result);
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  mount(view(),
    el('h1', { class: 'page-title' }, 'Style me'),
    el('p', { class: 'muted' }, 'AdClo puts together a complete outfit that suits your needs, the occasion and your budget, then shows it on you.'),
    profileStrip(),
    state.ai ? el('div', { class: 'section' }, askForm) : null,
    el('div', { class: 'section' },
      state.ai ? el('h2', { class: 'sub-head' }, 'Or choose quickly') : null,
      form),
    result,
  );
}

// Record a short voice note, turn it into text, then submit.
function voiceButton(box, status, onDone) {
  const btn = el('button', { type: 'button', class: 'icon-btn mic', 'aria-label': 'Speak your request', 'aria-pressed': 'false' }, icon('mic'));
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { btn.hidden = true; return btn; }
  let rec = null;
  let chunks = [];
  let stopTimer;
  const stop = () => { clearTimeout(stopTimer); if (rec?.state === 'recording') rec.stop(); };

  btn.addEventListener('click', async () => {
    if (rec?.state === 'recording') return stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      status.textContent = 'Microphone access was blocked. You can type instead.';
      return;
    }
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    rec.addEventListener('stop', async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.remove('on');
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 2000) { status.textContent = "Didn't catch that. Tap the mic and try again."; return; }
      status.textContent = 'Writing down what you said…';
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const json = await res.json();
        if (!res.ok || !json.text) throw new Error();
        box.value = json.text;
        status.textContent = 'Got it. Styling you now.';
        onDone();
      } catch {
        status.textContent = "Sorry, that didn't work. Try again or type your request.";
      }
    });
    rec.start();
    btn.setAttribute('aria-pressed', 'true');
    btn.classList.add('on');
    status.textContent = 'Listening… tap the mic again when you are done.';
    stopTimer = setTimeout(stop, 30_000);
  });
  return btn;
}

function renderStyled(look, target) {
  if (!look.items.length) {
    mount(target, el('div', { class: 'empty' }, el('h2', {}, 'Nothing fits that yet'), el('p', {}, 'Try a higher budget, fewer colour limits or a different occasion.')));
    return;
  }
  for (const i of look.items) state.seen.set(i.id, i);
  const items = look.items.map((i) => ({ ...(byId(i.id) || {}), ...i }));
  const plan = look.plan;
  const needLabels = plan ? state.meta.needs.filter((n) => plan.needs.includes(n.id)).map((n) => n.short) : [];
  const heard = plan ? el('div', { class: 'heard panel' },
    el('span', { class: 'card-type' }, 'What I heard'),
    el('p', {}, plan.summary || ''),
    el('div', { class: 'tags' },
      el('span', { class: 'tag' }, look.occasion),
      plan.budget ? el('span', { class: 'tag' }, `Up to ${money(plan.budget)}`) : null,
      needLabels.map((n) => el('span', { class: 'tag' }, n)),
      plan.colorsLike.map((c) => el('span', { class: 'tag' }, `Likes ${c}`)),
      plan.colorsAvoid.map((c) => el('span', { class: 'tag' }, `No ${c}`)))) : null;

  mount(target,
    heard,
    el('div', { class: 'section-head' },
      el('h2', {}, items.length === 1 ? `Your pick` : `Your ${look.occasion.toLowerCase()} look`),
      look.source === 'ai' ? el('span', { class: 'pill mid' }, icon('spark'), 'AI stylist') : null),
    look.intro ? el('p', { class: 'intro' }, look.intro) : null,
    el('ul', { class: 'look-list', role: 'list' }, items.map((i) => el('li', { class: 'look-row' },
      el('a', { href: `#/p/${i.id}` }, el('img', { src: `/garments/${i.image}`, alt: '' })),
      el('div', {},
        el('span', { class: 'card-type' }, catOne(i.category)),
        el('a', { class: 'name', href: `#/p/${i.id}` }, el('h3', {}, i.name)),
        el('span', { class: 'price' }, money(i.price)),
        el('ul', {}, (i.aiWhy ? [i.aiWhy] : i.why).map((w) => el('li', {}, w))))))),
    el('div', { class: 'total-bar' },
      el('div', {}, el('span', { class: 'muted' }, items.length > 1 ? 'Full outfit ' : 'Price '), el('strong', {}, money(look.total))),
      el('div', { class: 'hero-actions' },
        el('button', { type: 'button', class: 'btn ghost', on: { click: () => {
          for (const i of items) {
            state.look.set(i.category, { id: i.id, size: suggestedSize(i) });
            if (i.category === 'full_body') { state.look.delete('upper_body'); state.look.delete('lower_body'); }
          }
          if (items.some((i) => i.category === 'upper_body' || i.category === 'lower_body')) state.look.delete('full_body');
          saveLook();
          toast('Saved to your look', { href: '#/look', text: 'View' });
        } } }, 'Save to my look'),
        el('button', { type: 'button', class: 'btn primary', on: { click: () => openTryOn(items) } }, icon('camera'), items.length > 1 ? 'Try it all on me' : 'Try it on me'))),
  );
}

function viewLook() {
  const items = lookItems();
  if (!items.length) {
    mount(view(), el('div', { class: 'empty' },
      el('h2', {}, 'Your look is empty'),
      el('p', {}, 'Add pieces from the shop, or let AdClo put an outfit together for you.'),
      el('div', { class: 'hero-actions', style: 'justify-content:center' },
        el('a', { class: 'btn primary', href: '#/style' }, icon('spark'), 'Style me'),
        el('a', { class: 'btn ghost', href: `#/shop/${firstCategory()}` }, 'Browse'))));
    return;
  }
  const total = items.reduce((s, i) => s + i.price, 0);
  const missing = ['upper_body', 'lower_body', 'outer', 'shoes'].filter((c) => !state.look.has(c) && !(state.look.has('full_body') && (c === 'upper_body' || c === 'lower_body')));
  mount(view(), 
    el('h1', { class: 'page-title' }, 'Your look'),
    el('p', { class: 'muted' }, `${items.length} ${items.length === 1 ? 'piece' : 'pieces'}. Try them on together, then buy each from its store.`),
    el('ul', { class: 'look-list section', role: 'list' }, items.map((i) => el('li', { class: 'look-row' },
      el('a', { href: `#/p/${i.id}` }, el('img', { src: `/garments/${i.image}`, alt: '' })),
      el('div', {},
        el('span', { class: 'card-type' }, catOne(i.category)),
        el('a', { class: 'name', href: `#/p/${i.id}` }, el('h3', {}, i.name)),
        el('span', { class: 'price' }, money(i.price)),
        el('span', { class: 'muted small' }, i.chosenSize ? ` · Size ${i.chosenSize}` : ' · Pick a size'),
        i.reasons[0] ? el('ul', {}, el('li', {}, i.reasons[0])) : null),
      el('div', { class: 'row-actions' },
        el('a', { class: 'btn primary sm', href: i.buyUrl, target: '_blank', rel: 'noopener', 'aria-label': `Buy ${i.name}` }, 'Buy'),
        el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { state.look.delete(i.category); saveLook(); viewLook(); } }, 'aria-label': `Remove ${i.name}` }, 'Remove'))))),
    el('div', { class: 'total-bar' },
      el('div', {}, el('span', { class: 'muted' }, 'Total '), el('strong', {}, money(total))),
      el('button', { type: 'button', class: 'btn primary', on: { click: () => openTryOn(items) } }, icon('camera'), items.length > 1 ? 'Try the full look on me' : 'Try it on me')),
    missing.length ? el('p', { class: 'muted section' }, 'Add ',
      missing.map((c, n) => [n ? (n === missing.length - 1 ? ' or ' : ', ') : '', el('a', { href: `#/shop/${c}` }, catOne(c))]),
      ' to finish the outfit.') : null,
  );
}

// ---------- Router ----------
const routes = [
  [/^#?\/?$/, viewHome],
  [/^#\/shop\/([\w-]+)$/, viewShop],
  [/^#\/p\/([\w-]+)$/, viewProduct],
  [/^#\/style$/, viewStyle],
  [/^#\/look$/, viewLook],
];
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

async function render() {
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    await fn(...m.slice(1));
    paintNav(hash);
    window.scrollTo(0, 0);
    $('#view').focus({ preventScroll: true });
    return;
  }
  go('#/');
}
window.addEventListener('hashchange', render);

function paintNav(hash) {
  for (const a of document.querySelectorAll('#cat-nav a')) {
    const current = hash === a.getAttribute('href') || (hash.startsWith('#/p/') && a.dataset.cat === byId(hash.slice(4))?.category);
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function buildNav() {
  mount($('#cat-nav'), 
    el('a', { class: 'chip spark', href: '#/style' }, icon('spark'), 'Style me'),
    state.meta.categories.filter((c) => state.items.some((i) => i.category === c.id)).map((c) => {
      const a = el('a', { class: 'chip', href: `#/shop/${c.id}` }, c.label);
      a.dataset.cat = c.id;
      return a;
    }));
}

// ---------- Profile sheet ----------
const profileDlg = $('#profile');
const MIN_W = 512, MIN_H = 384, MAX_SIDE = 2048;
let draftPhoto = null;

function openProfile() {
  const p = state.profile;
  mount($('#profile-needs'), ...state.meta.needs.map((n) => el('label', { class: 'need' },
    el('input', { type: 'checkbox', name: 'need', value: n.id, checked: p.needs.includes(n.id) }),
    el('span', {}, n.label))));
  const f = $('#profile-form');
  f.elements.for.value = p.for;
  f.elements.size.value = p.size;
  f.elements.shoe.value = p.shoe;
  draftPhoto = state.photo;
  paintPhoto();
  profileDlg.showModal();
}

function paintPhoto() {
  const img = $('#profile-photo');
  img.hidden = !draftPhoto;
  if (draftPhoto) img.src = draftPhoto;
  $('#photo-label').textContent = draftPhoto ? 'Change photo' : 'Choose or take a photo';
}

// Resize in the browser so uploads stay small and within YouCam's limits.
function loadPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const { naturalWidth: w, naturalHeight: h } = img;
      if (Math.max(w, h) < MIN_W || Math.min(w, h) < MIN_H) return reject(new Error('error_below_min_image_size'));
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      const canvas = el('canvas', { width: Math.round(w * scale), height: Math.round(h * scale) });
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => reject(new Error('invalid_photo'));
    img.src = URL.createObjectURL(file);
  });
}

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const err = $('#photo-error');
  err.hidden = true;
  if (!file) return;
  try {
    draftPhoto = await loadPhoto(file);
    paintPhoto();
  } catch (ex) {
    err.textContent = explain(ex.message);
    err.hidden = false;
  }
});

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  state.profile = {
    needs: [...f.querySelectorAll('input[name="need"]:checked')].map((i) => i.value),
    for: f.elements.for.value || 'all',
    size: f.elements.size.value,
    shoe: f.elements.shoe.value,
    done: true,
  };
  state.photo = draftPhoto;
  store.save('profile', state.profile);
  store.save('photo', state.photo);
  profileDlg.close();
  await refreshItems();
  buildNav();
  render();
  toast('Profile saved. Everything is ranked for you.');
});

// ---------- Try-on sheet ----------
const tryDlg = $('#tryon');
const setStatus = (t) => { $('#tryon-status').textContent = t; };

function openTryOn(garments) {
  state.tryon = garments;
  $('#tryon-title').textContent = garments.length > 1 ? 'Your full look' : garments[0].name;
  const total = garments.reduce((s, g) => s + g.price, 0);
  mount($('#tryon-items'), 
    ...garments.map((g) => el('li', {},
      el('span', {}, el('strong', {}, g.name), ` · ${money(g.price)}`, el('span', { class: 'why' }, g.reasons?.[0] || g.featureText?.[0] || '')),
      el('a', { class: 'btn primary sm', href: g.buyUrl, target: '_blank', rel: 'noopener', 'aria-label': `Buy ${g.name}` }, 'Buy'))),
    garments.length > 1 ? el('li', {}, el('span', { class: 'total' }, 'Full look'), el('span', { class: 'total' }, money(total))) : null);
  mount($('#tryon-steps'), );
  $('#tryon-photo').hidden = true;
  $('#retry').hidden = true;
  tryDlg.showModal();

  if (!state.photo) {
    $('#before').removeAttribute('src');
    mount($('#after-wrap'), );
    setStatus('Add a photo of you first. Sitting in your chair is perfect.');
    $('#tryon-photo').hidden = false;
    return;
  }
  $('#before').src = state.photo;
  runTryOn();
}

async function runTryOn() {
  const garments = state.tryon;
  clearTimeout(state.pollTimer);
  $('#retry').hidden = true;
  mount($('#after-wrap'), el('div', { class: 'spinner', 'aria-hidden': 'true' }));
  setStatus(garments.length > 1
    ? `Dressing you one piece at a time. About ${20 * garments.length} seconds.`
    : 'Dressing you. This takes about 20 seconds.');

  try {
    const { jobId } = await api('/api/outfit', { photo: state.photo, garmentIds: garments.map((g) => g.id) });
    let shown = null;
    const label = { pending: 'waiting', running: 'dressing…', done: 'done', error: 'failed' };
    const poll = async () => {
      if (state.tryon !== garments || !tryDlg.open) return;
      try {
        const job = await api(`/api/outfit/${encodeURIComponent(jobId)}`);
        $('#tryon-steps').hidden = job.steps.length < 2;
        mount($('#tryon-steps'), ...job.steps.map((s) => {
          const li = el('li', {}, `${s.name}: ${label[s.state]}`);
          li.dataset.state = s.state;
          return li;
        }));
        if (job.url && job.url !== shown) {
          shown = job.url;
          const done = job.steps.filter((s) => s.state === 'done').map((s) => s.name);
          mount($('#after-wrap'), el('img', { src: job.url, alt: `You wearing the ${done.join(' and ')}` }));
        }
        if (job.state === 'done') return setStatus(garments.length > 1 ? 'Here is your full look.' : 'Here you are. Tap Buy if it works for you.');
        if (job.state === 'error') return showError(job.code, Boolean(job.url));
        state.pollTimer = setTimeout(poll, 2000);
      } catch (ex) { showError(ex.code); }
    };
    poll();
  } catch (ex) { showError(ex.code); }
}

function showError(code, keepImage = false) {
  if (!keepImage) mount($('#after-wrap'), );
  setStatus(keepImage ? `We dressed you partway. ${explain(code)}` : explain(code));
  $('#retry').hidden = false;
}

$('#retry').addEventListener('click', runTryOn);
$('#tryon-photo').addEventListener('click', () => { tryDlg.close(); openProfile(); });
tryDlg.addEventListener('close', () => clearTimeout(state.pollTimer));
for (const b of document.querySelectorAll('[data-close]')) {
  b.append(icon('close'));
  b.addEventListener('click', () => b.closest('dialog').close());
}

// ---------- Theme ----------
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const btn = $('#theme-btn');
  mount(btn, icon(dark ? 'sun' : 'moon'));
  btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
$('#theme-btn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  store.save('theme', next);
  applyTheme(next);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.load('theme', null)));

// ---------- Start ----------
async function start() {
  applyTheme(store.load('theme', null));
  $('#profile-btn').append(icon('user'));
  $('#look-btn').prepend(icon('bag'));
  const [meta, health] = await Promise.all([api('/api/meta'), api('/api/health').catch(() => ({}))]);
  state.meta = meta;
  if (health.mode === 'mock') { $('#mode').textContent = 'Demo mode'; $('#mode').hidden = false; }
  state.ai = Boolean(health.ai);
  await refreshItems();
  buildNav();
  await render();
  if (!state.profile.done) openProfile();
}
start();
