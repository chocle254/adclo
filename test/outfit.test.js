import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { orderOutfit } from '../lib/outfit.js';

const top = { id: 'top', name: 'Top', category: 'upper_body' };
const top2 = { id: 'top2', name: 'Top 2', category: 'upper_body' };
const pants = { id: 'pants', name: 'Pants', category: 'lower_body' };
const coat = { id: 'coat', name: 'Coat', category: 'outer' };
const dress = { id: 'dress', name: 'Dress', category: 'full_body' };

test('dresses bottoms first, then top, then jacket', () => {
  assert.deepEqual(orderOutfit([coat, top, pants]).map((g) => g.id), ['pants', 'top', 'coat']);
});

test('keeps one piece per slot, last pick wins', () => {
  assert.deepEqual(orderOutfit([top, top2]).map((g) => g.id), ['top2']);
});

test('a full-body piece replaces top and bottoms', () => {
  assert.deepEqual(orderOutfit([top, pants, dress, coat]).map((g) => g.id), ['dress', 'coat']);
});

test('every catalog item has a product photo', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
  for (const item of catalog) {
    assert.ok(existsSync(new URL(`../public/garments/${item.image}`, import.meta.url)), item.image);
  }
});
