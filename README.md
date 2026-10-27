# Scanline Displacement Glitch Lab

A browser-based **scanline-displacement + RGB-offset glitch** tool. Upload a photo
and pick an intensity **level 1–5** to make it look "off"; export a PNG, a
companion depth map, or a looping GIF sized for micro.blog. Everything runs
client-side — nothing is uploaded anywhere.

**▶ Live tool:** https://thumpersecure.github.io/scanline-glitch/

## The idea

The posted photo should look glitched as a flat image. The experiment is whether
Facebook's **3D Photo** conversion (depth parallax) pulls the strips back toward
alignment when you tilt it. Be aware of what is and isn't known:

- **Experimental / untested.** No public example of glitch art built to resolve
  under Facebook 3D parallax was found. Expect a *partial* reveal at best.
- Facebook either estimates depth itself (ML) or accepts a grayscale depth map
  posted with the photo. The `<name>_depth` filename convention and "white = near"
  come from third-party tutorials, **not Facebook docs — unconfirmed**, as are
  size limits and whether the mobile app supports it. Test with one upload.
- The synthetic depth ramp only helps if Facebook actually uses the exported map.
  Otherwise its own ML depth will not match, and the reveal is approximate.

## How the effect works

1. **Slice** the image into horizontal strips (`strip` px tall).
2. **Displace** each strip horizontally by seeded noise(y) × `amp` plus a
   centred depth ramp (`diag`) that grows with y.
3. **RGB offset** — R and B shift in *opposite* directions (G stays put), scaled
   by `rgb` px; this is the main "off" cue because parallax does not cancel it.
4. **Layer** 1–4 passes at growing scale (`lscale`) and composite them.

Displacement uses row copies with modulo wrap, so any shift size leaves no gaps.

## Levels 1–5

Levels are pure intensity. They scale with image width (tuned at 1080 px), so a
small image gets proportionally smaller shifts. All levels use normal blending —
screen/difference/overlay made intensity stop rising on real photos, so those
blends are left as manual options only.

| Level | Strip | Displacement | RGB offset | Layers | Opacity |
|---|---|---|---|---|---|
| 1 | 24 | 0.8 % of width | 2 px | 1 | 1.0 |
| 2 | 20 | 1.2 % | 3 px | 2 | 0.5 |
| 3 | 16 | 1.5 % | 4 px | 2 | 0.5 |
| 4 | 12 | 2.5 % | 6 px | 3 | 0.6 |
| 5 | 8 | 4.0 % | 10 px | 4 | 0.8 |

Touching any slider switches to *custom*. The numbers are starting points, not
validated against Facebook.

## Exports

| Button | Output |
|---|---|
| Download PNG | `glitch_L<level>_seed<n>_<timestamp>.png` at the working size |
| Download depth map | `<same name>_depth.png`, same dimensions, grayscale, white = near |
| Download GIF | seamless-loop animated GIF with progress, size estimate, and Cancel |

Large uploads are scaled to a 1080 px working width.

### GIF presets (micro.blog)

| Preset | Width | Frames | Colors | Measured size |
|---|---|---|---|---|
| micro.blog | 640 px | 20 @ ~14 fps | 256, dithered | ~2.3–2.4 MB on a test photo |
| Small | 400 px | 20 | 64 | ~0.4 MB |

**micro.blog's real upload/size limits are unconfirmed** — these are conservative
guesses (edit `PRESETS` in `gif.js`). The UI warns above 3 MB. Posting one test
GIF is the only reliable check. Loops are seamless: noise is sampled on a circle,
so frame 0 equals frame N.

## Controls

| Control | Effect |
|---|---|
| Level 1–5 | preset intensity |
| Strip height | thickness of each displaced row |
| Displacement | max horizontal shift (px) |
| Noise scale | how fast displacement varies down the image |
| Diagonal depth | strength of the centred depth ramp |
| RGB offset / spread | channel split amount |
| Layers / scale / opacity / blend | multi-pass compositing |
| Seed | deterministic: same seed + settings = same image |
| Animate | evolve over a 3 s loop |

## Architecture

No build step, no CDN at runtime (p5.js was removed).

| File | Role |
|---|---|
| `engine.js` | pure, seeded typed-array renderer (browser + node) |
| `gif.js` | GIF export; encoder vendored at `vendor/gifenc.esm.js` (gifenc 1.0.3) |
| `app.js` | UI wiring, single `requestAnimationFrame` scheduler, downloads |
| `index.html`, `style.css` | markup and responsive styles |

Fixed in this rewrite: leaked canvases (every render), Animate never starting,
unseeded noise (same seed gave a different image each load), and ~30k canvas
calls per slider event.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## License

MIT — see [LICENSE](LICENSE).
