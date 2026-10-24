import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankGarments, NEEDS, FEATURE_TEXT } from '../lib/match.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));

test('every feature in needs and catalog has user-facing text', () => {
  for (const need of Object.values(NEEDS)) {
    for (const f of [...Object.keys(need.wants), ...Object.keys(need.avoids)]) {
      assert.ok(FEATURE_TEXT[f], `missing text for ${f}`);
    }
  }
  for (const item of catalog) for (const f of item.features) assert.ok(FEATURE_TEXT[f], `missing text for ${f}`);
});

test('seated users get seated-cut trousers above standard jeans', () => {
  const ranked = rankGarments(catalog, ['seated']);
  const ids = ranked.map((i) => i.id);
  assert.ok(ids.indexOf('seated-chino') < ids.indexOf('classic-jeans'));
  const jeans = ranked.find((i) => i.id === 'classic-jeans');
  assert.equal(jeans.fit, 0);
  assert.ok(jeans.warnings.length >= 1);
});

test('dexterity need penalises small buttons', () => {
  const ranked = rankGarments(catalog, ['dexterity']);
  const jeans = ranked.find((i) => i.id === 'classic-jeans');
  assert.equal(jeans.fit, 0);
  assert.ok(jeans.warnings.some((w) => /small buttons/i.test(w)));
});

test('fit is 100 when an item fully covers a single need', () => {
  const [top] = rankGarments(catalog, ['medical']);
  assert.equal(top.fit, 100);
  assert.equal(top.needsMet, 1);
});

test('no needs keeps catalog order and null fit', () => {
  const ranked = rankGarments(catalog, []);
  assert.deepEqual(ranked.map((i) => i.id), catalog.map((i) => i.id));
  assert.equal(ranked[0].fit, null);
});

test('unknown needs are ignored', () => {
  const ranked = rankGarments(catalog, ['nope', 'seated']);
  assert.equal(ranked[0].needsTotal, 1);
});

test('needs only count for categories they apply to', () => {
  const ranked = rankGarments(catalog, ['seated']);
  const shoe = ranked.find((i) => i.category === 'shoes');
  assert.equal(shoe.fit, null);
  assert.equal(shoe.needsTotal, 0);
  const both = rankGarments(catalog, ['seated', 'dexterity']).find((i) => i.id === 'zip-sneaker');
  assert.equal(both.needsTotal, 1);
});

test('every need lists the categories it applies to', () => {
  for (const [k, n] of Object.entries(NEEDS)) assert.ok(n.applies?.length && n.short, k);
});

test('seated cut matters more than generic stretch for seated users', () => {
  const ranked = rankGarments(catalog, ['seated']);
  const chino = ranked.find((i) => i.id === 'seated-chino');
  const jogger = ranked.find((i) => i.id === 'side-zip-jogger');
  assert.equal(chino.fit, 100);
  assert.ok(jogger.fit < chino.fit);
});

test('every need has a reachable enough threshold', () => {
  for (const [key, need] of Object.entries(NEEDS)) {
    const total = Object.values(need.wants).reduce((a, b) => a + b, 0);
    assert.ok(need.enough > 0 && need.enough <= total, key);
  }
});
