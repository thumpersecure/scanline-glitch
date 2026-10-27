/* Scanline glitch engine: pure typed-array logic, no DOM, no p5, no Math.random.
 * Browser: window.GlitchEngine.  Node: module.exports.
 *
 * Technique: slice the image into horizontal strips, shift each strip sideways
 * by seeded noise (+ a centred depth ramp), shift R and B in OPPOSITE directions,
 * then composite several scaled layers with a blend mode. Everything is row
 * copies with wrap-around indexing, so any shift magnitude leaves no gaps.
 * Noise is sampled on a circle in (x, y) of the 3rd/4th lattice axes, so
 * render(phase=0) is byte-identical to render(phase=1): seamless GIF loops.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GlitchEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- level table (index 0 = null / custom) -------------------------------
  // Contract blends (screen/difference/overlay) retuned to 'normal' for every level: those blends brighten or
  // invert flat regions, so intensity stopped rising with level on real photos. Intensity now comes from
  // displacement + RGB offset + layer count; other blends stay available as manual sliders in the UI.
  // scale = noise freq per px at 1080 wide (converted to the working width).
  var LEVELS = [null,
    { strip: 24, ampPct: 0.8, rgbPx1080: 2,  layers: 1, lscale: 1.03, lop: 1.0, blend: 'normal',     diag: 0.00, angle: 90, scale: 0.006 },
    { strip: 20, ampPct: 1.2, rgbPx1080: 3,  layers: 2, lscale: 1.04, lop: 0.5, blend: 'normal',     diag: 0.10, angle: 90, scale: 0.007 },
    { strip: 16, ampPct: 1.5, rgbPx1080: 4,  layers: 2, lscale: 1.05, lop: 0.5, blend: 'normal',     diag: 0.20, angle: 90, scale: 0.009 },
    { strip: 12, ampPct: 2.5, rgbPx1080: 6,  layers: 3, lscale: 1.06, lop: 0.6, blend: 'normal',     diag: 0.35, angle: 90, scale: 0.011 },
    { strip: 8,  ampPct: 4.0, rgbPx1080: 10, layers: 4, lscale: 1.08, lop: 0.8, blend: 'normal',     diag: 0.50, angle: 90, scale: 0.014 }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function paramsFromLevel(level, width, seed) {
    var lv = clamp(Math.round(level) || 1, 1, 5);
    var L = LEVELS[lv], k = width / 1080;
    return {
      strip: clamp(Math.round(L.strip * k), 1, 32),
      amp: L.ampPct / 100 * width,
      scale: clamp(L.scale / k, 0.002, 0.05),
      diag: L.diag,
      angle: L.angle,
      rgb: clamp(L.rgbPx1080 * k, 0, 40),
      spread: 0.25,
      layers: L.layers,
      lscale: L.lscale,
      lop: L.lop,
      blend: L.blend,
      seed: seed == null ? 216 : (seed | 0),
      level: level === 0 ? 0 : lv
    };
  }

  // ---- seeded value noise (3D lattice, quintic interpolation) --------------
  function fmix(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16; return h;
  }
  function lat(x, y, z, s) {
    var h = fmix((s + Math.imul(x, 0x27d4eb2d)) | 0);
    h = fmix((h + Math.imul(y, 0x165667b1)) | 0);
    h = fmix((h + Math.imul(z, 0x9e3779b1)) | 0);
    return (h >>> 0) / 4294967296;
  }
  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function noise3(x, y, z, s) {
    var x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    var fx = fade(x - x0), fy = fade(y - y0), fz = fade(z - z0);
    var a = lat(x0, y0, z0, s), b = lat(x0 + 1, y0, z0, s);
    var c = lat(x0, y0 + 1, z0, s), d = lat(x0 + 1, y0 + 1, z0, s);
    var e = lat(x0, y0, z0 + 1, s), f = lat(x0 + 1, y0, z0 + 1, s);
    var g = lat(x0, y0 + 1, z0 + 1, s), hh = lat(x0 + 1, y0 + 1, z0 + 1, s);
    var ab = a + (b - a) * fx, cd = c + (d - c) * fx;
    var ef = e + (f - e) * fx, gh = g + (hh - g) * fx;
    var l0 = ab + (cd - ab) * fy, l1 = ef + (gh - ef) * fy;
    return l0 + (l1 - l0) * fz;
  }

  // ---- blend LUTs: lut[(base<<8)|top] ---------------------------------------
  var LUTS = {};
  function blendFn(mode, a, b) {
    switch (mode) {
      case 'screen':     return 255 - ((255 - a) * (255 - b) / 255);
      case 'add':        return Math.min(255, a + b);
      case 'difference': return Math.abs(a - b);
      case 'multiply':   return a * b / 255;
      case 'overlay':    return a < 128 ? 2 * a * b / 255 : 255 - 2 * (255 - a) * (255 - b) / 255;
      default:           return b;
    }
  }
  function getLut(mode) {
    if (!LUTS[mode]) {
      var t = new Uint8Array(65536);
      for (var a = 0; a < 256; a++) for (var b = 0; b < 256; b++)
        t[(a << 8) | b] = Math.round(clamp(blendFn(mode, a, b), 0, 255));
      LUTS[mode] = t;
    }
    return LUTS[mode];
  }

  // ---- render ----------------------------------------------------------------
  var CIRCLE_R = 1.0; // radius of the phase circle in noise-lattice units

  function render(src, p, phase, out) {
    var w = src.width, h = src.height, sd = src.data, n = w * h * 4;
    var data;
    if (out && out.data && out.data.length === n) data = out.data;
    else data = new Uint8ClampedArray(n);

    var ph = (phase || 0); ph -= Math.floor(ph);
    var cz = CIRCLE_R * Math.cos(2 * Math.PI * ph);
    var cw = CIRCLE_R * Math.sin(2 * Math.PI * ph);
    // third/fourth axes: (cz, cw) -> use z=cz, and fold cw into x offset so the
    // loop is a closed 2D curve through a 3D lattice.
    var seed = fmix((p.seed | 0) + 0x5bd1e995);

    var strip = clamp(Math.round(p.strip) || 1, 1, 1 << 20);
    var layers = clamp(Math.round(p.layers) || 1, 1, 4);
    var amp = +p.amp || 0, scale = +p.scale || 0.01;
    var diag = +p.diag || 0, rgb = +p.rgb || 0, spread = +p.spread || 0;
    var angF = Math.sin((p.angle == null ? 90 : p.angle) * Math.PI / 180);
    var lscale = Math.max(1, +p.lscale || 1);
    var opi = Math.round(clamp(p.lop == null ? 1 : p.lop, 0, 1) * 256);
    var lut = getLut(p.blend || 'normal');
    var nStrips = Math.ceil(h / strip);
    var shR = new Int32Array(nStrips), shG = new Int32Array(nStrips), shB = new Int32Array(nStrips);
    var xm = new Int32Array(w);
    var cxm = (w - 1) / 2, cym = (h - 1) / 2;

    for (var li = 0; li < layers; li++) {
      var sc = Math.pow(lscale, li);
      var lseed = (seed + Math.imul(li + 1, 0x9e3779b1)) | 0;
      var rgbL = rgb * (1 + spread * li);

      for (var s = 0; s < nStrips; s++) {
        var yc = Math.min(h - 1, s * strip + strip / 2);
        var ny = yc * scale;
        var n1 = noise3(ny + cw, 0.5 + cz, 0.25, lseed) * 2 - 1;
        var n2 = noise3(ny * 4 + 11.3 + cw, 7.7 + cz, 3.1, lseed) * 2 - 1;
        var nn = clamp((0.7 * n1 + 0.3 * n2) * 1.5, -1, 1);
        var depth = (yc / h - 0.5) * 2 * amp * diag * angF;
        var base = nn * amp + depth;
        var jit = 0.7 + 0.6 * noise3(ny * 2 + 31.7 + cw, 5.5 + cz, 9.9, lseed);
        var off = rgbL * jit;
        var rs = Math.round(base + off), gs = Math.round(base), bs = Math.round(base - off);
        shR[s] = ((rs % w) + w) % w;
        shG[s] = ((gs % w) + w) % w;
        shB[s] = ((bs % w) + w) % w;
      }
      for (var x = 0; x < w; x++) {
        var xs = Math.round((x - cxm) / sc + cxm);
        xm[x] = xs < 0 ? 0 : xs > w - 1 ? w - 1 : xs;
      }

      for (var y = 0; y < h; y++) {
        var ys = li === 0 ? y : Math.round((y - cym) / sc + cym);
        if (ys < 0) ys = 0; else if (ys > h - 1) ys = h - 1;
        var si = (ys / strip) | 0;
        var sr = shR[si], sg = shG[si], sb = shB[si];
        var rb = ys * w, ob = y * w * 4;
        for (var xx = 0; xx < w; xx++) {
          var sx = xm[xx];
          var tr = sx - sr; if (tr < 0) tr += w;
          var tg = sx - sg; if (tg < 0) tg += w;
          var tb = sx - sb; if (tb < 0) tb += w;
          var r = sd[(rb + tr) * 4], g = sd[(rb + tg) * 4 + 1], b = sd[(rb + tb) * 4 + 2];
          var o = ob + xx * 4;
          if (li === 0) {
            data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
          } else {
            var a0 = data[o], a1 = data[o + 1], a2 = data[o + 2];
            data[o]     = a0 + (((lut[(a0 << 8) | r] - a0) * opi) >> 8);
            data[o + 1] = a1 + (((lut[(a1 << 8) | g] - a1) * opi) >> 8);
            data[o + 2] = a2 + (((lut[(a2 << 8) | b] - a2) * opi) >> 8);
          }
        }
      }
    }
    return { data: data, width: w, height: h };
  }

  // ---- depth map ------------------------------------------------------------
  // White = near. Vertical ramp (bottom nearer, matching the displacement ramp
  // that grows with y) plus a gentle centre bulge so parallax has a subject.
  function depthMap(width, height, params) {
    var data = new Uint8ClampedArray(width * height * 4);
    var d = params && params.diag != null ? clamp(params.diag, 0, 1) : 0.3;
    var wRamp = 0.8, wBulge = 0.2 + 0.1 * d;
    var norm = wRamp + wBulge;
    for (var y = 0; y < height; y++) {
      var ty = height > 1 ? y / (height - 1) : 0.5;
      for (var x = 0; x < width; x++) {
        var tx = width > 1 ? x / (width - 1) : 0.5;
        var bulge = 1 - Math.abs(tx * 2 - 1);
        var v = Math.round(255 * (wRamp * ty + wBulge * bulge * (1 - Math.abs(ty * 2 - 1) * 0.5)) / norm);
        var o = (y * width + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
      }
    }
    return { data: data, width: width, height: height };
  }

  // ---- procedural source ----------------------------------------------------
  function makeProceduralSource(w, h, seed) {
    var s = fmix((seed == null ? 216 : seed | 0) + 0x1234567);
    var data = new Uint8ClampedArray(w * h * 4);
    function mix(a, b, t) { return a + (b - a) * t; }
    for (var y = 0; y < h; y++) {
      var ty = y / h;
      for (var x = 0; x < w; x++) {
        var tx = x / w;
        // sky gradient
        var r = mix(30, 250, ty), g = mix(40, 150, ty), b = mix(120, 110, ty);
        // sun disc
        var dx = tx - 0.68, dy = (ty - 0.42) * (h / w);
        var dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < 0.11) { r = 255; g = 230; b = 150; }
        else if (dd < 0.16) { var k = (0.16 - dd) / 0.05; r = mix(r, 255, k * 0.6); g = mix(g, 200, k * 0.6); b = mix(b, 130, k * 0.4); }
        // blocky skyline: columns with different heights
        var col = Math.floor(tx * 14);
        var bh = 0.52 + 0.3 * lat(col, 1, 0, s);
        if (ty > bh) {
          var shade = 0.25 + 0.45 * lat(col, 2, 0, s);
          r = 30 * shade + 10; g = 35 * shade + 12; b = 70 * shade + 25;
          // lit windows
          var wx = (tx * 14 - col) * 6, wy = (ty - bh) * 40;
          if ((wx % 1) > 0.35 && (wy % 1) > 0.4 && lat(Math.floor(wx) + col * 7, Math.floor(wy), 5, s) > 0.55) { r = 255; g = 214; b = 110; }
        }
        // ground stripe + foreground band
        if (ty > 0.9) { r = 200; g = 60; b = 90; }
        // soft noise texture
        var nz = noise3(x * 0.03, y * 0.03, 2, s) * 28 - 14;
        var o = (y * w + x) * 4;
        data[o] = r + nz; data[o + 1] = g + nz; data[o + 2] = b + nz; data[o + 3] = 255;
      }
    }
    return { data: data, width: w, height: h };
  }

  function fitSize(w, h, maxW) {
    if (!(w > 0) || !(h > 0)) return { w: 1, h: 1 };
    if (!(maxW > 0) || w <= maxW) return { w: Math.round(w), h: Math.round(h) };
    return { w: Math.round(maxW), h: Math.max(1, Math.round(h * maxW / w)) };
  }

  return {
    LEVELS: LEVELS,
    paramsFromLevel: paramsFromLevel,
    render: render,
    depthMap: depthMap,
    makeProceduralSource: makeProceduralSource,
    fitSize: fitSize
  };
});
