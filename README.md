# AdClo

**AdClo** (adaptive clothing) helps you find clothes that work for how you live, then shows them on you, seated the way you actually sit.

About 80 million people worldwide need a wheelchair (WHO), and many more live with limited hand
movement, limb differences, or medical devices. Most online try-on tools assume a standing model,
and most shopping filters only cover size and colour. AdClo starts from the problem
("buttons are hard for my hands", "I sit all day") and ranks garments by whether they solve it,
then uses **YouCam AI Clothes Virtual Try-On** to show the piece on the shopper's own photo.

## How it works

AdClo is a shopping app built around a **fit profile**: what makes dressing hard (sitting all day,
limited grip, one-handed dressing, assisted dressing, sensory needs, a prosthetic or brace, medical
access), who you shop for, your usual sizes and a photo of you.

- **Shop by category**: tops, bottoms, jackets, shoes and dresses. Every piece is ranked by how well
  it fits your needs, with plain reasons ("No back pockets to press into your skin") and warnings.
- **Product page**: sizes (your usual size is marked), why it works for you, **Try it on me**, and
  **Complete the look**, which suggests matching pieces from other categories with a reason
  ("Charcoal lets the sky blue stand out · both smart").
- **Style me**: pick an occasion and a budget and AdClo builds a whole outfit that fits your needs.
- **Your look**: the pieces you picked, one per slot. Try them all on together, then buy each one.
- **Full-outfit try-on**: try-ons are chained. Bottoms first, then top, jacket and shoes, each step
  using the previous result as the photo. Your own shoes are kept unless you try on new ones.

Core logic lives in `lib/`: `match.js` (needs to features), `stylist.js` (pairing and outfits),
`outfit.js` (chained try-ons) and `youcam.js` (API client).

## YouCam API used

| Step | Endpoint |
|---|---|
| Upload image | `POST /s2s/v2.0/file/...`, then `PUT` to the signed URL |
| Start try-on | `POST /s2s/v2.0/task/cloth-v4` with `garment_category` `upper_body`, `lower_body`, `outer`, `shoes` or `full_body`. Later steps pass the previous result as `src_file_url`. `change_shoes: false` keeps the person's own shoes. |
| Get result | `GET /s2s/v2.0/task/cloth-v4/{task_id}` |

Tested on a photo of a person seated in a wheelchair: tops, trousers, shoes and a two-piece chained
outfit all work, with the face, hands and chair left unchanged.

## Run it

Needs Node 20 or later.

```bash
npm install
cp .env.example .env      # add your YOUCAM_API_KEY
npm start                 # http://localhost:3000
```

Without an API key the app runs in **demo mode**: everything works, but the "try-on" returns your own
photo, so you can build the UI without spending API units.

### Garment images

Put product photos in `data/garments/` using the file names in `data/catalog.json`. Use front-facing
shots of a single garment. Trousers work best as photos of the garment being worn. Items without a
photo still appear in results, but their try-on button is disabled.

## Tests

```bash
npm test
```

## Accessibility

The app works with a keyboard and a screen reader, uses large touch targets (48px or more), supports
dark mode and reduced motion, announces try-on progress through a live region, and explains errors in
plain language.

## License

MIT
