// Matches garments to a person's needs. This is the core of the app:
// the try-on shows how it looks, this decides whether it will work for them.

// Each need lists garment features that help (with weight) and ones that get in the way.
// `enough` is the weight at which the need counts as fully covered.
const ALL = ['upper_body', 'lower_body', 'outer', 'shoes', 'full_body'];

// `applies` lists the categories where a need matters (being seated doesn't change which shoes work).
export const NEEDS = {
  seated: {
    label: 'I sit most of the day (wheelchair or chair)',
    short: 'Seated',
    applies: ['lower_body', 'outer', 'full_body'],
    enough: 5,
    wants: { seated_cut: 3, no_back_pockets: 2, stretch: 1 },
    avoids: { back_pockets: 2, long_hem: 1 },
  },
  dexterity: {
    label: 'Buttons and zips are hard for my hands',
    short: 'Easy fastening',
    applies: ALL,
    enough: 3,
    wants: { magnetic_closure: 3, velcro_closure: 2, pull_on: 2, elastic_laces: 2, zip_around: 2, pull_loops: 2, zip_pull_loop: 1 },
    avoids: { small_buttons: 3 },
  },
  one_hand: {
    label: 'I dress with one hand',
    short: 'One-handed',
    applies: ALL,
    enough: 4,
    wants: { one_hand_dress: 3, magnetic_closure: 2, elastic_laces: 2, zip_around: 2, pull_loops: 1, pull_on: 1 },
    avoids: { small_buttons: 2, back_closure: 2 },
  },
  assisted: {
    label: 'Someone helps me get dressed',
    short: 'Assisted dressing',
    applies: ALL,
    enough: 3,
    wants: { side_opening: 3, open_back: 3, zip_around: 2, wide_neck: 1 },
    avoids: {},
  },
  sensory: {
    label: 'Tags, seams or rough fabric bother me',
    short: 'Sensory-friendly',
    applies: ['upper_body', 'lower_body', 'full_body'],
    enough: 4,
    wants: { tagless: 2, flat_seams: 2, soft_fabric: 1 },
    avoids: { scratchy_fabric: 3 },
  },
  limb: {
    label: 'I use a prosthetic, brace or have a limb difference',
    short: 'Prosthetic or brace',
    applies: ['lower_body', 'shoes', 'upper_body'],
    enough: 3,
    wants: { side_zip_legs: 3, wide_opening: 3, wide_leg_opening: 2, adjustable_sleeves: 2 },
    avoids: {},
  },
  medical: {
    label: 'I need access for a port, tube or ostomy',
    short: 'Medical access',
    applies: ['upper_body', 'lower_body', 'full_body'],
    enough: 3,
    wants: { port_access: 3, abdominal_access: 3, high_rise_waist: 1 },
    avoids: {},
  },
};

export const FEATURE_TEXT = {
  seated_cut: "Cut for sitting, so it doesn't bunch or ride up",
  no_back_pockets: 'No back pockets to press into your skin',
  back_pockets: 'Has back pockets, which can cause pressure when seated',
  stretch: 'Stretch fabric moves with you',
  long_hem: 'Long hem may catch in wheels',
  magnetic_closure: 'Magnetic closures that snap shut on their own',
  velcro_closure: 'Hook-and-loop closures instead of buttons',
  pull_on: 'Pull-on, with no fastening needed',
  zip_pull_loop: 'Large zip pull loop that is easy to grip',
  pull_loops: 'Loops at the waist to pull them up without gripping the fabric',
  zip_around: 'Zip opens the whole shoe, so your foot slides in from above',
  wide_opening: 'Extra-wide opening that fits orthotics and braces',
  elastic_laces: 'Elastic laces, so there is nothing to tie',
  small_buttons: 'Has small buttons',
  one_hand_dress: 'Designed to put on with one hand',
  back_closure: 'Fastens at the back',
  side_opening: 'Opens at the side for easier help dressing',
  open_back: 'Opens at the back, so it goes on without lifting your arms',
  wide_neck: 'Wide neck opening',
  tagless: 'Tagless',
  flat_seams: 'Flat seams that do not rub',
  soft_fabric: 'Soft, smooth fabric',
  scratchy_fabric: 'Fabric may feel scratchy',
  side_zip_legs: 'Side-zip legs for a prosthetic or brace',
  wide_leg_opening: 'Wide leg opening',
  adjustable_sleeves: 'Adjustable sleeve length',
  port_access: 'Hidden zip for port or IV access',
  abdominal_access: 'Discreet opening for tube or ostomy access',
  high_rise_waist: 'High-rise waist that sits clear of the abdomen',
};

const AVOID_PENALTY = 15;

// Returns items sorted best-first, each with {fit, needsMet, reasons, warnings}.
// fit is 0-100: average coverage of the needs that apply to the item, minus penalties.
export function rankGarments(items, selectedNeeds) {
  const needs = selectedNeeds.filter((k) => NEEDS[k]);

  const scored = items.map((item, index) => {
    const has = new Set(item.features);
    const reasons = [];
    const warnings = [];
    let coverage = 0;
    let needsMet = 0;
    let penalties = 0;

    const relevant = needs.filter((key) => NEEDS[key].applies.includes(item.category));
    for (const key of relevant) {
      const need = NEEDS[key];
      let gained = 0;
      for (const [feature, weight] of Object.entries(need.wants)) {
        if (has.has(feature)) {
          gained += weight;
          if (!reasons.includes(FEATURE_TEXT[feature])) reasons.push(FEATURE_TEXT[feature]);
        }
      }
      if (gained > 0) needsMet++;
      coverage += Math.min(gained, need.enough) / need.enough;

      for (const feature of Object.keys(need.avoids)) {
        if (has.has(feature) && !warnings.includes(FEATURE_TEXT[feature])) {
          warnings.push(FEATURE_TEXT[feature]);
          penalties++;
        }
      }
    }

    // fit is null when none of the person's needs apply to this kind of item.
    const fit = relevant.length
      ? Math.max(0, Math.round((100 * coverage) / relevant.length) - penalties * AVOID_PENALTY)
      : null;

    return { ...item, fit, needsMet, needsTotal: relevant.length, reasons, warnings, index };
  });

  // Items the needs don't apply to sit in the middle (treated as 50).
  if (needs.length) scored.sort((a, b) => (b.fit ?? 50) - (a.fit ?? 50) || a.index - b.index);
  return scored.map(({ index, ...rest }) => rest);
}
