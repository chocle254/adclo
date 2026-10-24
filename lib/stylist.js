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

// "Style me": builds a full outfit for an occasion and optional budget.
// Picks a base piece first (bottoms or a dress), then adds what goes best with everything chosen so far.
export function styleMe(ranked, { occasion = 'everyday', budget = null } = {}) {
  const occ = OCCASIONS[occasion] ?? OCCASIONS.everyday;
  const pool = ranked.filter(usable);
  const styleBonus = (i) => (i.style.includes(occ.style) ? 1 : 0);
  const score = (i, chosen) => {
    const pairs = chosen.map((c) => pairScore(c, i).score);
    const pair = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : 0.7;
    return 0.45 * fitOf(i) + 0.35 * pair + 0.2 * styleBonus(i);
  };

  // Leave room in the budget for the remaining slots.
  const cheapest = (category) => Math.min(...pool.filter((i) => i.category === category).map((i) => i.price));
  const pick = (category, chosen, spent, laterSlots) => {
    const reserve = laterSlots.reduce((s, c) => s + (Number.isFinite(cheapest(c)) ? cheapest(c) : 0), 0);
    const cands = pool
      .filter((i) => i.category === category)
      .filter((i) => budget == null || spent + i.price + reserve <= budget)
      .sort((a, b) => score(b, chosen) - score(a, chosen));
    return cands[0] ?? null;
  };

  // Base piece: a dress if the occasion suits one and it scores better than bottoms.
  let slots = [...occ.slots];
  if (occ.dress) {
    const later = slots.filter((s) => s !== 'lower_body' && s !== 'upper_body');
    const dress = pick('full_body', [], 0, later);
    const bottoms = pick('lower_body', [], 0, slots.slice(1));
    if (dress && (!bottoms || score(dress, []) > score(bottoms, []))) {
      slots = ['full_body', ...later];
    }
  }

  const chosen = [];
  let spent = 0;
  slots.forEach((category, i) => {
    const item = pick(category, chosen, spent, slots.slice(i + 1));
    if (!item) return;
    chosen.push(item);
    spent += item.price;
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
  };
}
