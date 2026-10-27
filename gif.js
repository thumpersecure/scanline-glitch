/* gif.js - animated GIF export (global GifExport; also module.exports in node).
 *
 * Encoder: vendored gifenc 1.0.3 (vendor/gifenc.esm.js), loaded lazily via
 * dynamic import('./vendor/gifenc.esm.js') (relative path).
 *
 * HONEST NOTE: micro.blog's real upload / file-size / dimension limits for GIFs are
 * UNCONFIRMED (research could not verify them). The PRESETS below are conservative
 * guesses (small width, ~15 fps, few dozen frames, aim ~1.5-4 MB). They are plain
 * editable constants: change them here, or pass overrides in encode() opts.
 *
 * API
 *   GifExport.PRESETS                      { microblog, small }
 *   GifExport.encode(getFrame, opts, onProgress) -> Promise<Blob image/gif>
 *     getFrame(i, n) -> {data,width,height} | Promise  (caller renders phase = i/n)
 *     opts: { preset:'microblog'|'small' | object, frames, fps, maxWidth, colors,
 *             dither:boolean, signal:AbortSignal, lib (test hook: pre-loaded gifenc) }
 *     onProgress(fraction 0..1, {stage:'palette'|'encode', frame, total, bytes})
 *     Rejects with an Error named 'AbortError' when signal aborts.
 *   GifExport.estimateBytes(w, h, frames, colors?) -> rough bytes (for >3 MB UI warning)
 *   GifExport.WARN_BYTES = 3e6
 */
(function (root) {
  'use strict';

  // ---- editable constants (conservative guesses; micro.blog limits UNCONFIRMED) ----
  var PRESETS = {
    microblog: { label: 'micro.blog', maxWidth: 640, frames: 20, fps: 15, colors: 256, dither: true },
    small:     { label: 'Small',      maxWidth: 400, frames: 20, fps: 20, colors: 64,  dither: false }
  };
  var WARN_BYTES = 3 * 1000 * 1000;
  // Empirical bytes-per-pixel-per-frame (measured: moderate noise ~0.4 @128c, worst-case white noise ~0.9 @128c); rough on purpose.
  var BPP = { 256: 0.45, 128: 0.4, 64: 0.3, 32: 0.25 };

  var libPromise = null;
  function loadLib(opts) {
    if (opts && opts.lib) return Promise.resolve(opts.lib);
    if (!libPromise) {
      libPromise = import('./vendor/gifenc.esm.js').catch(function (e) { libPromise = null; throw e; });
    }
    return libPromise;
  }

  function abortError() {
    var e;
    try { e = new DOMException('GIF export cancelled', 'AbortError'); }
    catch (_) { e = new Error('GIF export cancelled'); e.name = 'AbortError'; }
    return e;
  }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }

  function yieldTick() {
    return new Promise(function (res) { setTimeout(res, 0); });
  }

  // Area-average downscale (box filter). Returns same object if no resize needed.
  function downscale(src, maxW) {
    var sw = src.width, sh = src.height;
    if (!maxW || sw <= maxW) return src;
    var dw = Math.max(1, Math.round(maxW)), dh = Math.max(1, Math.round(sh * dw / sw));
    var out = new Uint8ClampedArray(dw * dh * 4), s = src.data;
    var xr = sw / dw, yr = sh / dh;
    // precompute x ranges
    var x0 = new Int32Array(dw), x1 = new Int32Array(dw);
    for (var x = 0; x < dw; x++) {
      x0[x] = Math.floor(x * xr);
      x1[x] = Math.max(x0[x] + 1, Math.min(sw, Math.floor((x + 1) * xr)));
    }
    for (var y = 0; y < dh; y++) {
      var ya = Math.floor(y * yr), yb = Math.max(ya + 1, Math.min(sh, Math.floor((y + 1) * yr)));
      for (var xx = 0; xx < dw; xx++) {
        var r = 0, g = 0, b = 0, n = 0;
        for (var yy = ya; yy < yb; yy++) {
          var o = (yy * sw + x0[xx]) * 4;
          for (var k = x0[xx]; k < x1[xx]; k++, o += 4) { r += s[o]; g += s[o + 1]; b += s[o + 2]; n++; }
        }
        var d = (y * dw + xx) * 4;
        out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
      }
    }
    return { data: out, width: dw, height: dh };
  }

  // 4x4 Bayer ordered dither (in place on a copy), amplitude in 0..255 levels.
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function orderedDither(f, colors) {
    var amp = 255 / Math.pow(colors, 1 / 3) * 0.5; // ~half a palette step per channel
    var d = new Uint8ClampedArray(f.data), w = f.width, h = f.height;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var t = ((BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * amp, o = (y * w + x) * 4;
      d[o] += t; d[o + 1] += t; d[o + 2] += t;
    }
    return { data: d, width: w, height: h };
  }

  function resolveOpts(opts) {
    opts = opts || {};
    var base = typeof opts.preset === 'object' && opts.preset ? opts.preset : (PRESETS[opts.preset] || PRESETS.microblog);
    var o = {};
    for (var k in base) o[k] = base[k];
    ['frames', 'fps', 'maxWidth', 'colors', 'dither'].forEach(function (k) { if (opts[k] != null) o[k] = opts[k]; });
    o.frames = Math.max(2, Math.floor(o.frames));
    o.colors = Math.min(256, Math.max(2, Math.floor(o.colors)));
    o.delay = Math.round(1000 / o.fps);
    return o;
  }

  function encode(getFrame, opts, onProgress) {
    opts = opts || {};
    var signal = opts.signal, cfg = resolveOpts(opts), n = cfg.frames;
    var report = function (f, info) { if (onProgress) { try { onProgress(Math.min(1, f), info); } catch (_) {} } };

    return loadLib(opts).then(async function (lib) {
      checkAbort(signal);
      var GIFEncoder = lib.GIFEncoder, quantize = lib.quantize, applyPalette = lib.applyPalette;
      if (!GIFEncoder || !quantize || !applyPalette) throw new Error('gifenc failed to load');

      // Frame fetch (+ downscale + optional dither); sample frames cached for reuse.
      var cache = {};
      var sampleIdx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4)];
      var isSample = {}; sampleIdx.forEach(function (i) { isSample[i] = true; });
      async function fetchFrame(i) {
        if (cache[i]) return cache[i];
        var f = await getFrame(i, n);
        checkAbort(signal);
        f = downscale(f, cfg.maxWidth);
        if (cfg.dither) f = orderedDither(f, cfg.colors);
        if (isSample[i]) cache[i] = f;
        return f;
      }

      // 1) pooled global palette from frames 0, n/4, n/2, 3n/4
      var parts = [], total = 0, w = 0, h = 0, uniq = Object.keys(isSample).map(Number);
      for (var s = 0; s < uniq.length; s++) {
        var f = await fetchFrame(uniq[s]);
        w = f.width; h = f.height;
        parts.push(f.data); total += f.data.length;
        report(0.1 * (s + 1) / uniq.length, { stage: 'palette', frame: s + 1, total: uniq.length, bytes: 0 });
        await yieldTick(); checkAbort(signal);
      }
      var pool = new Uint8Array(total), off = 0;
      parts.forEach(function (p) { pool.set(p, off); off += p.length; });
      var palette = quantize(pool, cfg.colors, { format: 'rgb565' });
      pool = null; await yieldTick(); checkAbort(signal);

      // 2) encode all frames with that single palette
      var gif = GIFEncoder();
      for (var i = 0; i < n; i++) {
        var fr = await fetchFrame(i);
        if (fr.width !== w || fr.height !== h) throw new Error('frame size changed mid-export');
        var index = applyPalette(fr.data, palette, 'rgb565');
        gif.writeFrame(index, w, h, { palette: i === 0 ? palette : undefined, delay: cfg.delay, repeat: 0 });
        delete cache[i]; // free after use (palette stage cached copies only)
        report(0.1 + 0.9 * (i + 1) / n, { stage: 'encode', frame: i + 1, total: n, bytes: gif.bytesView().length });
        await yieldTick(); checkAbort(signal);
      }
      gif.finish();
      return new Blob([gif.bytesView()], { type: 'image/gif' });
    });
  }

  function estimateBytes(w, h, frames, colors) {
    var c = colors || 128, key = c >= 256 ? 256 : c >= 128 ? 128 : c >= 64 ? 64 : 32;
    return Math.round(w * h * frames * BPP[key]) + 800;
  }

  var api = { PRESETS: PRESETS, WARN_BYTES: WARN_BYTES, encode: encode, estimateBytes: estimateBytes,
              _downscale: downscale };
  root.GifExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
