import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runStylist, understand, cleanLanguage } from '../lib/agent.js';
import { rankGarments } from '../lib/match.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
const rankFor = ({ needs, forWho }) => rankGarments(
  catalog.filter((i) => forWho === 'all' || i.for === forWho || i.for === 'unisex'), needs,
).map((i) => ({ ...i, featureText: i.features }));

// A fake AI that returns scripted replies in order.
function fakeAi(...replies) {
  const calls = [];
  return {
    calls,
    async chatJSON(messages) {
      calls.push(messages);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(messages) : r;
    },
  };
}

test('offensive phrases are replaced', () => {
  assert.equal(cleanLanguage('Outfit for someone wheelchair-bound'), 'Outfit for someone a wheelchair user');
  assert.equal(cleanLanguage('He suffers from MS'), 'He has MS');
  assert.equal(cleanLanguage('Great for special needs'), 'Great for access needs');
});

test('understand keeps only known values and merges profile needs', async () => {
  const ai = fakeAi({
    occasion: 'party', budget: '199.6', needs: ['one_hand', 'flying'], for: 'robots',
    only: ['outer', 'hats'], colors_avoid: ['Bright'], summary: 'You are wheelchair bound and need a coat.',
  });
  const plan = await understand(ai, 'x', { needs: ['seated'], for: 'all' });
  assert.equal(plan.occasion, 'everyday');
  assert.equal(plan.budget, 200);
  assert.deepEqual(plan.needs.sort(), ['one_hand', 'seated']);
  assert.equal(plan.for, null);
  assert.deepEqual(plan.only, ['outer']);
  assert.deepEqual(plan.colorsAvoid, ['bright']);
  assert.doesNotMatch(plan.summary, /bound/i);
});

test('the AI can only pick from the shortlist; bad picks fall back to the rules', async () => {
  const ai = fakeAi(
    { occasion: 'work', budget: null, needs: ['seated'], for: 'mens', only: [], colors_like: [], colors_avoid: [], summary: 'You need a work outfit.' },
    (messages) => {
      const { shortlist } = JSON.parse(messages[1].content);
      const picks = shortlist.map((s, n) => ({
        category: s.category,
        id: n === 0 ? 'made-up-trousers' : s.options[s.options.length - 1].id,
        why: 'Great pick.',
      }));
      return { intro: 'Here you go.', picks };
    },
  );
  const out = await runStylist(ai, { message: 'work clothes', profile: { needs: [], for: 'all' }, rankFor });
  assert.equal(out.source, 'ai');
  assert.equal(out.items[0].aiWhy, null); // invented id was rejected
  assert.ok(out.items.slice(1).every((i) => i.aiWhy === 'Great pick.'));
  assert.ok(out.items.every((i) => catalog.some((c) => c.id === i.id)));
  assert.equal(out.plan.for, 'mens');
});

test('over-budget AI picks are replaced by the rules outfit', async () => {
  const ai = fakeAi(
    { occasion: 'everyday', budget: 150, needs: [], only: [], summary: 'ok' },
    (messages) => {
      const { shortlist } = JSON.parse(messages[1].content);
      // pick the most expensive option in each slot
      return { intro: 'x', picks: shortlist.map((s) => ({ category: s.category, id: [...s.options].sort((a, b) => b.price - a.price)[0].id, why: 'y' })) };
    },
  );
  const out = await runStylist(ai, { message: 'cheap', profile: { needs: [], for: 'all' }, rankFor });
  assert.ok(out.total <= 150);
  assert.ok(out.withinBudget);
});

test('if the choosing step fails, the rules outfit is still returned', async () => {
  const ai = fakeAi({ occasion: 'formal', budget: null, needs: ['assisted'], only: [], summary: 'ok' }, new Error('down'));
  const out = await runStylist(ai, { message: 'formal', profile: { needs: [], for: 'womens' }, rankFor });
  assert.equal(out.source, 'rules');
  assert.ok(out.items.length >= 2);
});
