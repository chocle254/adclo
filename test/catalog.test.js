import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { FEATURE_TEXT } from '../lib/match.js';
import { CATEGORIES } from '../lib/stylist.js';

// The real shop catalog (logic tests use test/fixtures/catalog.json).
const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));

test('every product links to its own product page, not a search', () => {
  for (const i of catalog) {
    assert.match(i.buyUrl, /^https:\/\/[^/]+\/products\/[^/?#]+$/, i.id);
  }
});

test('every product has a photo, a known currency, and features with text', () => {
  for (const i of catalog) {
    assert.ok(existsSync(new URL(`../public/garments/${i.image}`, import.meta.url)), `missing photo for ${i.id}`);
    assert.ok(['CAD', 'USD'].includes(i.currency), i.id);
    assert.ok(i.brand, i.id);
    assert.ok(CATEGORIES[i.category], i.id);
    for (const f of i.features) assert.ok(FEATURE_TEXT[f], `missing text for ${f}`);
  }
});

test('ids are unique', () => {
  assert.equal(new Set(catalog.map((i) => i.id)).size, catalog.length);
});
