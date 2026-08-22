# Scanline Displacement Glitch Lab

An interactive, browser-based **horizontal line-displacement (scanline) glitch**
generator. Upload an image (or generate a procedural source), then tune every
parameter of the effect and export a PNG. Everything runs client-side — nothing
is uploaded anywhere.

**▶ Live tool:** https://thumpersecure.github.io/scanline-glitch/

## The technique

This is *not* a single filter — it's built by stacking distorted rows of pixels:

1. **Slice** the source into thin horizontal strips (1–16 px).
2. **Displace** each strip horizontally by a Perlin-`noise(y)` value **plus a
   diagonal depth gradient**, so the shift ramps across the frame (the
   "diagonal depth set") instead of jittering randomly.
3. **RGB split** — the R, G and B channels are drawn at slightly different
   per-strip offsets, producing the muted colour fringing ("muted RBG lines").
4. **Layer** 1–4 passes at increasing scales (1→2×) and blend them (screen /
   add / difference / overlay / multiply) for the woven interference texture.

Each **seed** is one "experiment" — change the parameters + seed to explore the
space, then download the frame.

## Controls

| Group | What it does |
|-------|--------------|
| Strip height | thickness of each displaced row |
| Displacement amount | max horizontal shift in px |
| Noise scale | how fast the displacement varies down the image |
| Diagonal strength / angle | the diagonal depth gradient |
| Channel offset / spread | RGB split amount |
| Layers / layer scale / opacity / blend | multi-pass compositing |
| Seed | reproducible randomness; reroll for a new experiment |
| Animate | evolve the noise over time |

## Recipes to try

- **Classic VHS tear** — strip 2, amount 60, noise scale 0.02, diagonal 0.2, RGB 8, layers 2, blend `screen`.
- **Diagonal depth sweep** ("Experiment 216") — strip 1, amount 40, diagonal 0.8 @ 45°, RGB 6, layers 3, scale 1.5, blend `add`.
- **Woven interference** — strip 1, amount 30, layers 4, layer scale 1.8, opacity 0.4, blend `difference`.
- **Subtle print fringe** — strip 3, amount 12, RGB 4, spread 2, layers 1.

Reroll the **seed** on any recipe to get a new "experiment" with the same character.

## Run locally

It's static — just serve the folder:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Tech

[p5.js](https://p5js.org) (loaded from CDN). Single-file logic in `sketch.js`.

## License

MIT — see [LICENSE](LICENSE).
