// Styling rules: which pieces go together, and building a whole outfit automatically.
// Works on items already ranked by rankGarments (so each has `fit`, `reasons`, `warnings`).

export const CATEGORIES = {
  upper_body: { label: 'Tops', one: 'top' },
  lower_body: { label: 'Bottoms', one: 'bottoms' },
  outer: { label: 'Jackets', one: 'jacket' },
  shoes: { label: 'Shoes', one: 'shoes' },
  full_body: { label: 'Dresses', one: 'dress' },
};

// Which other categories can be worn with each one.
const GOES_WITH = {
  upper_body: ['lower_body', 'outer', 'shoes'],
  lower_body: ['upper_body', 'outer', 'shoes'],
  outer: ['upper_body', 'lower_body', 'full_body', 'shoes'],
  shoes: ['upper_body', 'lower_body', 'full_body', 'outer'],
  full_body: ['outer', 'shoes'],
};

export const OCCASIONS = {
  everyday: { label: 'Everyday', style: 'casual', slots: ['lower_body', 'upper_body', 'shoes'] },
  work: { label: 'Work', style: 'smart', slots: ['lower_body', 'upper_body', 'outer', 'shoes'] },
  night: { label: 'Night out', style: 'smart', slots: ['lower_body', 'upper_body', 'shoes'], dress: true },
  active: { label: 'Active', style: 'sport', slots: ['lower_body', 'upper_body', 'shoes'] },
  formal: { label: 'Wedding or formal', style: 'formal', slots: ['lower_body', 'upper_body', 'outer', 'shoes'], dress: true },
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// How well two pieces go together, 0-1, with a short human reason.
export function pairScore(a, b) {
  let color;
  let colorWhy;
  if (a.tone === 'neutral' || b.tone === 'neutral') {
    const n = a.tone === 'neutral' ? a : b;
    const other = n === a ? b : a;
    color = 1;
    colorWhy = a.color.name === b.color.name
      ? `Matching ${a.color.name} tones`
      : other.tone === 'neutral'
      ? `${cap(a.color.name)} and ${b.color.name} are an easy match`
      : `${cap(n.color.name)} lets the ${other.color.name} stand out`;
  } else if (a.bold && b.bold) {
    color = 0.2;
    colorWhy = `Two bold colours compete`;
  } else if (a.tone === b.tone) {
    color = 0.8;
    colorWhy = `${cap(a.color.name)} and ${b.color.name} share a ${a.tone} palette`;
  } else {
    color = 0.55;
    colorWhy = `${cap(a.color.name)} contrasts with ${b.color.name}`;
  }
  const shared = a.style.filter((s) => b.style.includes(s));
  const style = shared.length ? 1 : 0.3;
  const why = shared.length ? `${colorWhy} · both ${shared[0]}` : colorWhy;
  return { score: (color + style) / 2, why };
}

const fitOf = (item) => (item.fit ?? 60) / 100;
// Leave out pieces that actively work against the person's needs (e.g. back pockets when seated).
const usable = (item) => !item.warnings?.length;

// "Goes well with": the best matches from each other category.
export function suggestFor(item, ranked, { perSlot = 4 } = {}) {
  return GOES_WITH[item.category].map((category) => {
    const items = ranked
      .filter((o) => o.category === category && o.id !== item.id && usable(o))
      .map((o) => {
        const p = pairScore(item, o);
        return { ...o, pairWhy: p.why, match: 0.6 * p.score + 0.4 * fitOf(o) };
      })
      .sort((x, y) => y.match - x.match)
      .slice(0, perSlot);
    return { category, label: CATEGORIES[category].label, items };
  }).filter((g) => g.items.length);
}

const BOLD_WORDS = ['bright', 'bold', 'neon', 'loud', 'vivid', 'flashy'];
const DRESS_ORDER = ['full_body', 'lower_body', 'upper_body', 'outer', 'shoes'];

// Colour families, so "green" finds mint and teal, and "blue" finds navy.
const FAMILIES = {
  green: ['mint', 'teal', 'olive', 'sage', 'aqua'],
  blue: ['navy', 'sky blue', 'denim blue', 'aqua', 'teal'],
  red: ['red', 'coral', 'rust', 'burgundy'],
  pink: ['blush', 'coral', 'rose'],
  orange: ['rust', 'coral'],
  brown: ['brown', 'tan', 'rust', 'camel'],
  white: ['white', 'cream', 'stone'],
  beige: ['cream', 'stone', 'tan', 'blush'],
  grey: ['charcoal', 'stone'],
  gray: ['charcoal', 'stone'],
  black: ['black', 'charcoal'],
};

// True when a colour word ("red", "bright", "green") describes the item.
export function colorMatches(item, word) {
  const w = String(word).toLowerCase().trim();
  if (!w) return false;
  if (BOLD_WORDS.includes(w)) return Boolean(item.bold);
  if (['dark', 'muted', 'neutral', 'neutrals', 'plain'].includes(w)) return item.tone === 'neutral';
  const name = item.color.name.toLowerCase();
  if (name.includes(w) || w.includes(name)) return true;
  return Object.entries(FAMILIES).some(([family, names]) => w.includes(family) && names.includes(name));
}

// "Style me": builds a full outfit for an occasion and optional budget.
// Picks a base piece first (bottoms or a dress), then adds what goes best with everything chosen so far.
// Options: `only` limits it to some categories ("just a jacket"); colorsLike / colorsAvoid steer colour.
// Also returns the top alternatives for each slot, so the AI stylist can choose among them.
export function styleMe(ranked, {
  occasion = 'everyday', budget = null, only = [], colorsLike = [], colorsAvoid = [], alternatives = 3,
} = {}) {
  const occ = OCCASIONS[occasion] ?? OCCASIONS.everyday;
  const pool = ranked.filter(usable).filter((i) => !colorsAvoid.some((c) => colorMatches(i, c)));
  const styleBonus = (i) => (i.style.includes(occ.style) ? 1 : 0);
  const likeBonus = (i) => (colorsLike.some((c) => colorMatches(i, c)) ? 0.15 : 0);
  const score = (i, chosen) => {
    const pairs = chosen.map((c) => pairScore(c, i).score);
    const pair = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : 0.7;
    return 0.45 * fitOf(i) + 0.35 * pair + 0.2 * styleBonus(i) + likeBonus(i);
  };

  // Leave room in the budget for the remaining slots.
  const cheapest = (category) => Math.min(...pool.filter((i) => i.category === category).map((i) => i.price));
  // Once a men's or women's piece is chosen, the rest of the outfit stays in that section.
  const sameSection = (i, chosen) => {
    const section = chosen.find((c) => c.for !== 'unisex')?.for;
    return !section || i.for === 'unisex' || i.for === section;
  };
  const candidates = (category, chosen, spent, laterSlots) => {
    const reserve = laterSlots.reduce((s, c) => s + (Number.isFinite(cheapest(c)) ? cheapest(c) : 0), 0);
    return pool
      .filter((i) => i.category === category)
      .filter((i) => sameSection(i, chosen))
      .filter((i) => budget == null || spent + i.price + reserve <= budget)
      .sort((a, b) => score(b, chosen) - score(a, chosen));
  };

  let slots;
  const wanted = only.filter((c) => CATEGORIES[c]);
  if (wanted.length) {
    slots = DRESS_ORDER.filter((c) => wanted.includes(c));
  } else {
    slots = [...occ.slots];
    // Base piece: a dress if the occasion suits one and it scores better than bottoms.
    if (occ.dress) {
      const later = slots.filter((s) => s !== 'lower_body' && s !== 'upper_body');
      const [dress] = candidates('full_body', [], 0, later);
      const [bottoms] = candidates('lower_body', [], 0, slots.slice(1));
      if (dress && (!bottoms || score(dress, []) > score(bottoms, []))) slots = ['full_body', ...later];
    }
  }

  // If the budget can't cover every slot, drop the optional ones first (jacket, then shoes),
  // so an outfit never ends up without trousers or a top.
  if (budget != null && !wanted.length) {
    const minCost = (list) => list.reduce((s, c) => s + (Number.isFinite(cheapest(c)) ? cheapest(c) : 0), 0);
    for (const optional of ['outer', 'shoes']) {
      if (minCost(slots) <= budget) break;
      slots = slots.filter((c) => c !== optional);
    }
  }

  const chosen = [];
  const alts = {};
  let spent = 0;
  slots.forEach((category, i) => {
    const cands = candidates(category, chosen, spent, slots.slice(i + 1));
    if (!cands.length) return;
    alts[category] = cands.slice(0, alternatives).map((c) => c.id);
    chosen.push(cands[0]);
    spent += cands[0].price;
  });

  const base = chosen[0];
  const items = chosen.map((item) => ({
    ...item,
    why: [item.reasons[0], item === base ? null : pairScore(base, item).why].filter(Boolean),
  }));
  return {
    occasion: occ.label,
    items,
    total: spent,
    withinBudget: budget == null || spent <= budget,
    alternatives: alts,
  };
}
