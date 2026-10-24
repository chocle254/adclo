// Full-outfit try-on: garments are put on one at a time, each result becoming the photo for the next.
// The page drives the steps (see /api/tryon/* in server.js); this decides the order.

// Dress in a natural order: trousers first, then top, then jacket.
const LAYER = { full_body: 0, lower_body: 1, shoes: 2, upper_body: 3, auto: 3, outer: 4 };

// Keeps one garment per slot (the last one picked wins) and puts them in dressing order.
// A full-body piece (like a dress) replaces any separate top or bottom.
export function orderOutfit(garments) {
  const bySlot = new Map();
  for (const g of garments) bySlot.set(g.category, g);
  if (bySlot.has('full_body')) {
    bySlot.delete('upper_body');
    bySlot.delete('lower_body');
  }
  return [...bySlot.values()].sort((a, b) => (LAYER[a.category] ?? 3) - (LAYER[b.category] ?? 3));
}
