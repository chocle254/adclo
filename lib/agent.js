// The AI stylist. Three steps:
//   1. understand: the AI turns a free-text request into a structured plan
//   2. shortlist:  our own matching rules find pieces that meet the person's needs
//   3. choose:     the AI picks from that shortlist and explains each pick
// The AI can only choose real catalog pieces that already passed the needs check,
// so it can't invent clothes or recommend something that works against someone's body.

import { NEEDS } from './match.js';
import { CATEGORIES, OCCASIONS, styleMe } from './stylist.js';

const LANGUAGE_RULES = `Language rules (very important):
- Use respectful, person-first language. Describe what people do or need, never label them.
- Never use: "wheelchair-bound", "confined to a wheelchair", "suffers from", "victim", "handicapped", "crippled", "special needs", "invalid", "differently abled".
- Say "uses a wheelchair", "sits most of the day", "dresses with one hand" instead.
- Be warm and practical, not pitying.`;

// Safety net in case the model slips.
const REPLACEMENTS = [
  [/\bwheelchair[\s-]*bound\b/gi, 'a wheelchair user'],
  [/\bconfined to (a|their|his|her) wheelchair\b/gi, 'uses a wheelchair'],
  [/\bsuffer(s|ing)? from\b/gi, 'has'],
  [/\bhandicapped\b/gi, 'disabled'],
  [/\bspecial needs\b/gi, 'access needs'],
  [/\bdifferently[\s-]abled\b/gi, 'disabled'],
  [/\bcrippled?\b/gi, 'disabled'],
];
export function cleanLanguage(text) {
  let out = String(text ?? '');
  for (const [re, sub] of REPLACEMENTS) out = out.replace(re, sub);
  return out.trim();
}

const asList = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);

// Step 1: free text -> plan. Keeps only values we understand.
export async function understand(ai, message, profile) {
  const needList = Object.entries(NEEDS).map(([id, n]) => `${id} (${n.label})`).join('; ');
  const raw = await ai.chatJSON([
    {
      role: 'system',
      content: `You turn a clothing request into JSON for an adaptive fashion shop.
Keys:
- occasion: one of ${Object.keys(OCCASIONS).join(', ')}
- budget: total budget in dollars as a number, or null
- needs: array of need ids the person mentions. Choose from: ${needList}
- for: "mens", "womens" or null if not said
- only: categories they ask for, if they want specific pieces rather than a full outfit. Empty array means a full outfit. Categories:
  upper_body = shirts, tops, blouses, polos, t-shirts, hoodies
  lower_body = trousers, pants, jeans, joggers, chinos
  outer = jackets, coats, blazers (anything worn over a top, including "warm" layers)
  shoes = shoes, sneakers, trainers, boots
  full_body = dresses, jumpsuits
- colors_like: colour words they want
- colors_avoid: colour words they don't want (use "bright" for loud colours)
- summary: one short sentence restating the request to the person, in second person ("You need...").
${LANGUAGE_RULES}
Reply with JSON only.`,
    },
    { role: 'user', content: message },
  ], { temperature: 0.1 });

  const needs = [...new Set([...profile.needs, ...asList(raw.needs).filter((k) => NEEDS[k])])];
  const budget = Number(raw.budget) > 0 ? Math.round(Number(raw.budget)) : null;
  return {
    occasion: OCCASIONS[raw.occasion] ? raw.occasion : 'everyday',
    budget,
    needs,
    for: ['mens', 'womens'].includes(raw.for) ? raw.for : null,
    only: asList(raw.only).filter((c) => CATEGORIES[c]),
    colorsLike: asList(raw.colors_like).slice(0, 5),
    colorsAvoid: asList(raw.colors_avoid).slice(0, 5),
    summary: cleanLanguage(raw.summary || ''),
  };
}

// Step 3: the AI picks one piece per slot from the shortlist and explains why.
// Falls back to the rules-based pick for any slot it gets wrong, and to the whole
// rules-based outfit if its picks go over budget.
export async function choose(ai, { message, plan, look, byId }) {
  const shortlist = Object.entries(look.alternatives).map(([category, ids]) => ({
    category,
    options: ids.map((id) => {
      const i = byId(id);
      return {
        id, name: i.name, price: i.price, colour: i.color.name, style: i.style,
        helps_with: i.reasons.length ? i.reasons : i.featureText.slice(0, 3),
      };
    }),
  }));

  const raw = await ai.chatJSON([
    {
      role: 'system',
      content: `You are AdClo's stylist for adaptive clothing. Pick exactly one option per category from the shortlist to make one outfit that suits the request.
Rules:
- Only use ids from the shortlist.
- Keep the total at or under the budget if there is one.
- Prefer pieces whose "helps_with" matches the person's needs, and colours that go together.
- For each pick write "why": max 22 words, mention one concrete adaptive feature from helps_with and how it looks with the rest. Don't invent features.
- Also write "intro": one or two warm sentences to the person about the outfit (max 40 words).
- Also write "spoken": what you'd say out loud if you were a friend helping them shop, talking to them face to face. It is read aloud by a voice, so:
  - Sound like a real person chatting, not a script or an announcement. Relaxed, warm, a little personality. Contractions, short sentences, the odd "so" or "honestly" is fine, but don't overdo fillers.
  - Don't repeat the intro or the "why" lines. Just talk them through it naturally: the vibe, one or two pieces by casual names ("the blue shirt", "those zip-up high-tops"), and the one thing that makes dressing easier for them.
  - Round money ("about two-forty all in"), no decimals, no currency codes, no lists, no brand legal names, no emoji, no markdown, no stage directions.
  - 2 to 4 sentences, max 55 words.
${LANGUAGE_RULES}
Reply as JSON: {"intro": string, "spoken": string, "picks": [{"category": string, "id": string, "why": string}]}`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        request: message,
        occasion: OCCASIONS[plan.occasion].label,
        budget: plan.budget,
        needs: plan.needs.map((k) => NEEDS[k].label),
        colours_to_avoid: plan.colorsAvoid,
        shortlist,
      }),
    },
  ], { temperature: 0.4 });

  const picks = Array.isArray(raw.picks) ? raw.picks : [];
  const items = look.items.map((ruleItem) => {
    const allowed = look.alternatives[ruleItem.category] ?? [];
    const p = picks.find((x) => x?.category === ruleItem.category && allowed.includes(x?.id));
    if (!p) return { ...ruleItem, aiWhy: null };
    const chosen = byId(p.id);
    return { ...chosen, why: ruleItem.id === chosen.id ? ruleItem.why : [chosen.reasons[0]].filter(Boolean), aiWhy: cleanLanguage(p.why).slice(0, 220) || null };
  });

  const total = items.reduce((s, i) => s + i.price, 0);
  if (plan.budget != null && total > plan.budget) {
    return { items: look.items.map((i) => ({ ...i, aiWhy: null })), total: look.total, intro: null, spoken: null, usedAi: false };
  }
  return {
    items, total,
    intro: cleanLanguage(raw.intro || '').slice(0, 300) || null,
    spoken: cleanLanguage(String(raw.spoken || '')).replace(/[*_#`]/g, '').slice(0, 420) || null,
    usedAi: items.some((i) => i.aiWhy),
  };
}

// The whole flow. `rankFor(profile)` returns the catalog ranked for a profile.
export async function runStylist(ai, { message, profile, rankFor }) {
  const plan = await understand(ai, message, profile);
  const shopFor = plan.for ?? profile.for;
  const ranked = rankFor({ needs: plan.needs, forWho: shopFor });
  const byId = (id) => ranked.find((i) => i.id === id);
  const look = styleMe(ranked, {
    occasion: plan.occasion, budget: plan.budget, only: plan.only,
    colorsLike: plan.colorsLike, colorsAvoid: plan.colorsAvoid,
  });

  let result = { items: look.items, total: look.total, intro: null, spoken: null, usedAi: false };
  if (look.items.length) {
    try {
      result = await choose(ai, { message, plan, look, byId });
    } catch {
      // The rules-based outfit is still a good answer if the second AI step fails.
    }
  }

  return {
    plan: { ...plan, for: shopFor },
    occasion: OCCASIONS[plan.occasion].label,
    items: result.items,
    total: result.total,
    withinBudget: plan.budget == null || result.total <= plan.budget,
    intro: result.intro,
    spoken: result.spoken || spokenFallback(result.items),
    source: result.usedAi ? 'ai' : 'rules',
  };
}

// Something friendly to say when the AI didn't write a spoken reply.
export function spokenFallback(items) {
  if (!items.length) return "Hmm, I couldn't find anything that fits all of that. Maybe loosen the budget or the colours and I'll try again.";
  const names = items.map((i) => `the ${i.color.name} ${i.type.toLowerCase()}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `Okay, so here's what I'd go for. ${list[0].toUpperCase()}${list.slice(1)}. Have a look at why each one works for you below.`;
}
