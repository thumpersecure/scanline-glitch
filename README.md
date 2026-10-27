# Scanline Displacement Glitch Lab

A browser-based **scanline-displacement + RGB-offset glitch** tool with a **3D reveal**
mode. Upload a photo and pick an intensity **level 1–5**. The exported image looks
glitched as a flat picture, and a depth-parallax viewer at one tilt angle shifts every
strip back so the original reappears. Also exports a depth map and a GIF sized for
micro.blog. Everything runs client-side — nothing is uploaded anywhere.

**▶ Live tool:** https://thumpersecure.github.io/scanline-glitch/

## The idea: reveal mode (default)

Facebook / iOS "3D photos" fake parallax: they shift pixels sideways by their depth value
as you tilt. Reveal mode runs that in reverse:

1. Slice the image into strips and shift each one sideways (the glitch).
2. Write a **depth map** where each strip's gray level encodes its exact shift.
3. At one tilt angle the viewer shifts every strip back by that amount and the original
   reappears. At the flat angle, and either side of the reveal angle, it stays displaced
   and gets worse the further you go.

The page has a **Tilt preview** slider that simulates this: `0` = the flat image you would
post, `1.00` = the reveal. In the simulator the reconstruction is exact (mean difference
0.000) when RGB offset is 0. The R/B colour fringe is not depth-driven, so with RGB offset
on, a fringe stays at every angle by design.

### What is and is not confirmed

- **Confirmed here:** the pre-warp + depth-map math, in the simulator, from the exported
  PNG + depth PNG alone (a viewer given only those two files recovers the original).
- **Unconfirmed — test one real upload:**
  - Whether Facebook uses *your* depth map instead of estimating depth itself. If it
    estimates its own, the reveal will not line up.
  - Polarity (white = near vs black = near — sources disagree; use **Flip depth polarity**
    if the reveal appears on the wrong tilt side) and how far Facebook actually tilts
    (the reveal angle depends on that scale).
  - Delivery: on facebook.com the documented route is dragging `<name>.png` and
    `<name>_depth.png` into the composer. On iPhone the Facebook app reads depth *embedded*
    in the photo; a 2019 walkthrough used the DepthCam app to embed it. Neither is
    confirmed for 2026. iOS Photos' own "Spatial Scene" estimates depth itself, so a
    supplied map does not apply there.
- Rows are edge-clamped (parallax cannot wrap pixels), so a sliver of at most the max
  shift appears at the left/right edges.

## How the glitch works

1. **Slice** into horizontal strips (`strip` px tall).
2. **Displace** each strip by seeded noise(y) × `amp` plus a centred depth ramp (`diag`).
3. **RGB offset** — R and B shift in *opposite* directions, G stays put.
4. *(classic mode only)* **Layer** 1–4 scaled passes and blend them. Scaled layers can't be
   undone by parallax, so reveal mode uses a single layer with normal blending.

Displacement uses row copies; any shift size leaves no gaps in classic mode.

## Levels 1–5

Pure intensity levels, scaled to image width (tuned at 1080 px). All use normal blending.

| Level | Strip | Displacement | RGB offset | Layers | Opacity |
|---|---|---|---|---|---|
| 1 | 24 | 0.8 % of width | 2 px | 1 | 1.0 |
| 2 | 20 | 1.2 % | 3 px | 2 | 0.5 |
| 3 | 16 | 1.5 % | 4 px | 2 | 0.5 |
| 4 | 12 | 2.5 % | 6 px | 3 | 0.6 |
| 5 | 8 | 4.0 % | 10 px | 4 | 0.8 |

(Layers/opacity apply to classic mode; reveal mode always renders one layer.) Touching a
slider switches to *custom*. Level 5 shifts up to ~5 % of the width, which is probably more
than a real 3D photo tilts, so the reveal may only be partial at high levels — calibrate
with one upload.

## Exports

| Button | Output |
|---|---|
| Download PNG | `reveal_L<level>_seed<n>_<timestamp>.png` (`glitch_…` in classic mode) |
| Download depth map | `<same name>_depth.png`, same size, grayscale. In reveal mode each gray band is one strip's shift |
| Export GIF | reveal mode: a looping **tilt sweep** that shows the reveal; classic mode: seamless noise loop |

Uploads are scaled to a 1080 px working width.

### GIF presets (micro.blog)

| Preset | Width | Frames | Colors | Measured size |
|---|---|---|---|---|
| micro.blog | 640 px | 20 @ ~14 fps | 256, dithered | ~1.4–2.5 MB on test photos |
| Small | 400 px | 20 | 64 | ~0.4 MB |

**micro.blog's real upload/size limits are unconfirmed** — conservative guesses (edit
`PRESETS` in `gif.js`). The UI warns above 3 MB.

## Controls

| Control | Effect |
|---|---|
| Reveal mode / Tilt preview / Flip polarity | 3D reveal and its simulator |
| Level 1–5 | preset intensity |
| Strip height / Displacement / Noise scale / Diagonal depth | the slicing |
| RGB offset / spread | channel split (set RGB to 0 for a clean reveal) |
| Layers / scale / opacity / blend | classic mode only |
| Seed | deterministic: same seed + settings = same image |
| Animate | reveal mode: sweeps the tilt; classic mode: evolves the noise |

## Architecture

No build step, no CDN at runtime.

| File | Role |
|---|---|
| `engine.js` | pure seeded renderer, `buildReveal`, `simulateTilt` (browser + node) |
| `gif.js` | GIF export; encoder vendored at `vendor/gifenc.esm.js` (gifenc 1.0.3) |
| `app.js` | UI wiring, single `requestAnimationFrame` scheduler, downloads |
| `index.html`, `style.css` | markup and responsive styles |

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## License

MIT — see [LICENSE](LICENSE).
