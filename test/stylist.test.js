import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pairScore, suggestFor, styleMe, colorMatches, CATEGORIES } from '../lib/stylist.js';
import { rankGarments } from '../lib/match.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
const byId = (id) => catalog.find((i) => i.id === id);

test('catalog items have the fields the stylist needs', () => {
  for (const i of catalog) {
    assert.ok(CATEGORIES[i.category], `${i.id} category`);
    assert.ok(i.color?.name && i.color?.hex, `${i.id} color`);
    assert.ok(['neutral', 'warm', 'cool'].includes(i.tone), `${i.id} tone`);
    assert.ok(i.style.length && i.sizes.length, `${i.id} style/sizes`);
    assert.ok(['mens', 'womens', 'unisex'].includes(i.for), `${i.id} for`);
  }
});

test('neutrals pair with anything, two bold colours clash', () => {
  assert.equal(pairScore(byId('seated-chino'), byId('velcro-polo')).score > 0.6, true);
  const clash = pairScore(byId('velcro-polo'), byId('zip-sneaker'));
  assert.ok(clash.score < 0.7);
  assert.match(clash.why, /bold/);
});

test('suggestions for trousers come from other categories, best first', () => {
  const ranked = rankGarments(catalog, ['seated']);
  const groups = suggestFor(byId('seated-chino'), ranked);
  assert.deepEqual(groups.map((g) => g.category), ['upper_body', 'outer', 'shoes']);
  for (const g of groups) {
    for (let i = 1; i < g.items.length; i++) assert.ok(g.items[i - 1].match >= g.items[i].match);
    assert.ok(g.items.every((x) => x.pairWhy));
  }
});

test('suggestions skip items that fail the user\'s needs', () => {
  const ranked = rankGarments(catalog, ['seated']);
  const groups = suggestFor(byId('magnetic-oxford'), ranked);
  const bottoms = groups.find((g) => g.category === 'lower_body').items.map((i) => i.id);
  assert.ok(!bottoms.includes('classic-jeans'));
});

test('style me builds one piece per slot for work', () => {
  const ranked = rankGarments(catalog, ['seated', 'dexterity']);
  const look = styleMe(ranked, { occasion: 'work' });
  const cats = look.items.map((i) => i.category);
  assert.equal(new Set(cats).size, cats.length);
  assert.ok(cats.includes('shoes'));
  assert.ok(look.items.every((i) => i.why.length));
  assert.equal(look.total, look.items.reduce((s, i) => s + i.price, 0));
});

test('style me respects the budget', () => {
  const ranked = rankGarments(catalog, ['seated']);
  const look = styleMe(ranked, { occasion: 'everyday', budget: 150 });
  assert.ok(look.total <= 150, `total ${look.total}`);
  assert.ok(look.withinBudget);
  assert.ok(look.items.length >= 2);
});

test('formal can pick a dress instead of top and bottoms', () => {
  const womens = catalog.filter((i) => i.for !== 'mens');
  const look = styleMe(rankGarments(womens, ['assisted']), { occasion: 'formal' });
  const cats = look.items.map((i) => i.category);
  if (cats.includes('full_body')) {
    assert.ok(!cats.includes('upper_body') && !cats.includes('lower_body'));
  }
  assert.ok(look.items.length >= 2);
});

test('colour words match items', () => {
  assert.ok(colorMatches(byId('velcro-polo'), 'bright'));
  assert.ok(!colorMatches(byId('seated-chino'), 'bright'));
  assert.ok(colorMatches(byId('navy-blazer'), 'navy'));
  assert.ok(colorMatches(byId('seated-chino'), 'neutral'));
});

test('avoiding bright colours leaves bold pieces out', () => {
  const look = styleMe(rankGarments(catalog, []), { occasion: 'everyday', colorsAvoid: ['bright'] });
  assert.ok(look.items.length >= 2);
  assert.ok(look.items.every((i) => !i.bold));
});

test('"just a jacket" returns only jackets, with alternatives', () => {
  const look = styleMe(rankGarments(catalog, ['seated']), { only: ['outer'] });
  assert.deepEqual(look.items.map((i) => i.category), ['outer']);
  assert.ok(look.alternatives.outer.length >= 2);
  assert.equal(look.alternatives.outer[0], look.items[0].id);
});

test('colour families: green finds mint, blue finds navy', () => {
  assert.ok(colorMatches(byId('port-access-hoodie'), 'green'));
  assert.ok(colorMatches(byId('navy-blazer'), 'blue'));
  assert.ok(!colorMatches(byId('velcro-polo'), 'green'));
});

test('an outfit never mixes men\'s and women\'s pieces', () => {
  for (const occasion of ['everyday', 'work', 'night', 'formal', 'active']) {
    const look = styleMe(rankGarments(catalog, ['seated', 'one_hand']), { occasion });
    const sections = new Set(look.items.map((i) => i.for).filter((f) => f !== 'unisex'));
    assert.ok(sections.size <= 1, `${occasion}: ${[...sections]}`);
  }
});

test('a tight budget drops the jacket or shoes, never the trousers or top', () => {
  const mens = catalog.filter((i) => i.for !== 'womens');
  for (const budget of [120, 160, 200]) {
    const look = styleMe(rankGarments(mens, ['seated', 'one_hand']), { occasion: 'formal', budget, colorsAvoid: ['bright'] });
    const cats = look.items.map((i) => i.category);
    assert.ok(cats.includes('full_body') || (cats.includes('lower_body') && cats.includes('upper_body')), `${budget}: ${cats}`);
    assert.ok(look.total <= budget, `${budget}: ${look.total}`);
  }
});
