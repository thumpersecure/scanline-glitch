/* Scanline Glitch Lab - UI wiring (vanilla, no p5).
 * Talks to window.GlitchEngine (engine.js) and window.GifExport (gif.js).
 * No storage is used (nothing persisted), so nothing can throw from it.
 *
 * Notes
 *  - Preview and PNG export both use the "working size": the source is
 *    downscaled to at most MAX_W (1080) px wide, never upscaled.
 *  - One requestAnimationFrame scheduler. Event handlers only set `dirty`.
 */
(function () {
  'use strict';

  var MAX_W = 1080;          // working width cap (preview AND PNG export)
  var LOOP_MS = 3000;        // animation loop length
  var DEFAULT_LEVEL = 3;
  var DEFAULT_SEED = 216;
  var GIF_WARN_BYTES = 3 * 1000 * 1000;   // same convention as GifExport.WARN_BYTES
  var SLIDERS = ['strip', 'amp', 'scale', 'diag', 'angle', 'rgb', 'spread',
                 'layers', 'lscale', 'lop', 'seed'];

  function $(id) { return document.getElementById(id); }

  var el = {};
  ['out', 'fileInput', 'genSource', 'levels', 'blend', 'reroll', 'reset', 'animate',
   'savePng', 'saveDepth', 'gifPreset', 'saveGif', 'gifCancel', 'gifProgress',
   'gifInfo', 'status', 'dropzone'].forEach(function (id) { el[id] = $(id); });
  SLIDERS.forEach(function (id) { el[id] = $(id); });

  var statusTimer = 0;
  function setStatus(msg, kind) {
    if (!el.status) { if (window.console) console.log('[status]', msg); return; }
    el.status.textContent = msg || '';
    el.status.setAttribute('data-kind', kind || 'info');
    if (el.status.classList) {
      el.status.classList.toggle('error', kind === 'error');
      el.status.classList.toggle('warn', kind === 'warn');
    }
  }

  var E = window.GlitchEngine;
  if (!E || typeof E.render !== 'function' || typeof E.paramsFromLevel !== 'function') {
    setStatus('Error: engine.js did not load (GlitchEngine missing). Reload the page.', 'error');
    return;
  }
  if (!el.out || !el.out.getContext) {
    if (window.console) console.error('canvas#out missing');
    return;
  }

  // ---- state (all reused, no per-event allocation) ----
  var ctx = el.out.getContext('2d');
  var srcCanvas = document.createElement('canvas');
  srcCanvas.getContext = (function (g) { return function (t, o) { return g.call(this, t, t === '2d' ? { willReadFrequently: true } : o); }; })(srcCanvas.getContext);   // holds the working-size source pixels
  var src = null;                                     // {data,width,height}
  var P = { strip: 16, amp: 10, scale: 0.01, diag: 0.2, angle: 45, rgb: 4, spread: 1,
            layers: 2, lscale: 1.5, lop: 0.7, blend: 'normal', seed: DEFAULT_SEED, level: DEFAULT_LEVEL };
  var imageData = null;          // ImageData for the visible canvas
  var outObj = null;             // {data,width,height} handed to engine.render
  var dirty = true, raf = 0, animOn = false, exporting = false, t0 = 0, phase = 0;
  var loadToken = 0;
  var stem = '', stemKey = '';
  var exportCtl = null;          // AbortController while a GIF is encoding

  // ---- helpers ----
  function decimals(inp) {
    var s = String(inp.step || '1'), i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function showOut(id) {
    var o = $(id + 'Out');
    if (o) o.textContent = Number(el[id].value).toFixed(decimals(el[id]));
  }
  function setSlider(id, v) {
    var inp = el[id];
    if (!inp) return;
    inp.value = v;
    P[id] = parseFloat(inp.value);   // read back: browser clamps/snaps to min/max/step
    showOut(id);
  }
  function syncControlsFromP() {
    for (var i = 0; i < SLIDERS.length; i++) setSlider(SLIDERS[i], P[SLIDERS[i]]);
    if (el.blend) { el.blend.value = P.blend; if (el.blend.value !== P.blend) P.blend = el.blend.value; }
    markLevelButtons();
  }
  function markLevelButtons() {
    if (!el.levels) return;
    var btns = el.levels.querySelectorAll('button[data-level]');
    for (var i = 0; i < btns.length; i++) {
      var on = Number(btns[i].getAttribute('data-level')) === P.level;
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      if (btns[i].classList) btns[i].classList.toggle('active', on);
    }
  }
  function stamp() {
    var d = new Date(), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
           p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  // Name stem is fixed until params/source change, so PNG and depth share a stem.
  function currentStem() {
    var key = [P.level, P.seed, P.strip, P.amp, P.scale, P.diag, P.angle, P.rgb, P.spread,
               P.layers, P.lscale, P.lop, P.blend, src ? src.width + 'x' + src.height : ''].join('|');
    if (key !== stemKey || !stem) {
      stemKey = key;
      stem = 'glitch_L' + (P.level || 'custom') + '_seed' + P.seed + '_' + stamp();
    }
    return stem;
  }

  // ---- scheduler ----
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
  function markDirty() { dirty = true; schedule(); }
  function frame(ts) {
    raf = 0;
    var running = animOn && !exporting;
    if (running) {
      phase = ((ts - t0) / LOOP_MS) % 1;
      if (phase < 0) phase += 1;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      try { drawPreview(); }
      catch (err) { setStatus('Render error: ' + err.message, 'error'); if (window.console) console.error(err); animOn = false; if (el.animate) el.animate.checked = false; }
    }
    if (animOn && !exporting) schedule();
  }
  function drawPreview() {
    if (!src) return;
    if (!imageData || imageData.width !== src.width || imageData.height !== src.height) {
      imageData = ctx.createImageData(src.width, src.height);
      outObj = { data: imageData.data, width: src.width, height: src.height };
      el.out.width = src.width; el.out.height = src.height;
    }
    var r = E.render(src, P, animOn ? phase : 0, outObj);
    if (r && r.data && r.data !== imageData.data) imageData.data.set(r.data);
    ctx.putImageData(imageData, 0, 0);
  }

  // ---- source handling ----
  function setSourceFromCanvasSize(w, h) {
    srcCanvas.width = w; srcCanvas.height = h;
  }
  function adoptSource() {
    var w = srcCanvas.width, h = srcCanvas.height;
    var id = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
    src = { data: id.data, width: w, height: h };
    imageData = null;
    if (el.amp) el.amp.max = Math.max(1, Math.round(w * 0.1));
    if (P.level > 0) {
      var q = E.paramsFromLevel(P.level, w, P.seed);
      for (var k in q) if (Object.prototype.hasOwnProperty.call(q, k)) P[k] = q[k];
      P.level = q.level != null ? q.level : P.level;
    }
    syncControlsFromP();
    updateGifInfo();
    markDirty();
  }
  function useProcedural() {
    loadToken++;
    var w = 800, h = 450;
    var s = E.makeProceduralSource(w, h, 216);
    setSourceFromCanvasSize(w, h);
    var id = new ImageData(new Uint8ClampedArray(s.data), w, h);
    srcCanvas.getContext('2d').putImageData(id, 0, 0);
    adoptSource();
  }
  function drawToSource(drawable, iw, ih) {
    var fit = E.fitSize ? E.fitSize(iw, ih, MAX_W) : { w: Math.min(iw, MAX_W), h: Math.round(ih * Math.min(1, MAX_W / iw)) };
    setSourceFromCanvasSize(fit.w, fit.h);
    var c = srcCanvas.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.fillStyle = '#fff';            // flatten transparency onto white, not black
    c.fillRect(0, 0, fit.w, fit.h);
    c.drawImage(drawable, 0, 0, fit.w, fit.h);
  }
  function decodeFile(file) {
    if (typeof createImageBitmap === 'function') {
      return Promise.resolve().then(function () {   // sync throws (old Safari) become rejections
        return createImageBitmap(file, { imageOrientation: 'from-image' });
      }).catch(function () {
        return createImageBitmap(file);
      }).catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); res(im); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode failed')); };
      im.src = url;
    });
  }
  function loadFile(file) {
    if (!file) return;
    var token = ++loadToken;
    setStatus('Loading ' + file.name + '...');
    decodeFile(file).then(function (img) {
      if (token !== loadToken) { if (img.close) img.close(); return; }
      var iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
      if (!iw || !ih) throw new Error('empty image');
      try { drawToSource(img, iw, ih); } finally { if (img.close) img.close(); }
      adoptSource();
      setStatus('Loaded ' + file.name + ' (' + src.width + 'x' + src.height + ').');
    }).catch(function () {
      if (token !== loadToken) return;
      setStatus('Could not read "' + file.name + '". Use a JPG, PNG, WebP or GIF (HEIC from iPhone is not supported by most browsers - export as JPG first).', 'error');
    });
  }

  // ---- downloads ----
  var dlLink = document.createElement('a');
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    dlLink.href = url; dlLink.download = name;
    document.body.appendChild(dlLink);
    dlLink.click();
    document.body.removeChild(dlLink);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function canvasBlob(c, type) {
    return new Promise(function (res, rej) {
      c.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob failed')); }, type || 'image/png');
    });
  }
  function rgbaToCanvas(d) {
    var c = document.createElement('canvas');
    c.width = d.width; c.height = d.height;
    c.getContext('2d').putImageData(new ImageData(d.data, d.width, d.height), 0, 0);
    return c;
  }
  function savePng() {
    if (!src) return;
    var name = currentStem() + '.png';
    var d = E.render(src, P, 0, null);   // phase 0, independent of animation state
    canvasBlob(rgbaToCanvas(d)).then(function (b) {
      download(b, name);
      setStatus('Saved ' + name + ' (' + d.width + 'x' + d.height + '). Also save the depth map to get the 3D effect.');
    }).catch(function (e) { setStatus('PNG export failed: ' + e.message, 'error'); });
  }
  function saveDepth() {
    if (!src) return;
    if (typeof E.depthMap !== 'function') { setStatus('Depth map unavailable (engine too old).', 'error'); return; }
    var base = currentStem();
    var d = E.depthMap(src.width, src.height, P);
    canvasBlob(rgbaToCanvas(d)).then(function (b) {
      download(b, base + '_depth.png');
      setStatus('Saved ' + base + '_depth.png. Save ' + base + '.png too and post both files together via the facebook.com web composer (white = near is UNCONFIRMED).');
    }).catch(function (e) { setStatus('Depth export failed: ' + e.message, 'error'); });
  }

  // ---- GIF ----
  function gifPreset() {
    var G = window.GifExport;
    if (!G || !G.PRESETS) return null;
    return G.PRESETS[el.gifPreset ? el.gifPreset.value : 'microblog'] || G.PRESETS.microblog || null;
  }
  function gifDims(preset) {
    var f = Math.min(1, preset.maxWidth / src.width);
    return { f: f, w: Math.max(1, Math.round(src.width * f)), h: Math.max(1, Math.round(src.height * f)) };
  }
  function updateGifInfo() {
    if (!el.gifInfo) return;
    var G = window.GifExport, p = gifPreset();
    if (!G || !p || !src) { el.gifInfo.textContent = G ? '' : 'GIF export unavailable (gif.js not loaded).'; return; }
    var dm = gifDims(p);
    var est = G.estimateBytes ? G.estimateBytes(dm.w, dm.h, p.frames, p.colors) : 0;
    el.gifInfo.textContent = dm.w + 'x' + dm.h + ', ' + p.frames + ' frames @ ' + p.fps + ' fps, est. ~' +
      (est / 1e6).toFixed(1) + ' MB' + (est > GIF_WARN_BYTES ? ' - over 3 MB, may be too large for micro.blog' : '');
    el.gifInfo.classList && el.gifInfo.classList.toggle('warn', est > GIF_WARN_BYTES);
  }
  function setExporting(on) {
    exporting = on;
    [el.savePng, el.saveDepth, el.saveGif, el.gifPreset, el.genSource, el.fileInput, el.reroll, el.reset].forEach(function (b) { if (b) b.disabled = on; });
    if (el.gifCancel) el.gifCancel.disabled = !on;
    if (el.gifProgress) { el.gifProgress.hidden = !on; el.gifProgress.value = 0; el.gifProgress.max = 1; }
    if (!on && animOn) { t0 = performance.now() - phase * LOOP_MS; schedule(); }
  }
  function saveGif() {
    var G = window.GifExport, p = gifPreset();
    if (!G || typeof G.encode !== 'function' || !p) { setStatus('GIF export unavailable (gif.js did not load).', 'error'); return; }
    if (!src || exporting) return;
    var dm = gifDims(p), f = dm.f;
    // Scaled source + params so the look matches the preview at the smaller size.
    var sc = document.createElement('canvas');
    sc.width = dm.w; sc.height = dm.h;
    var sctx = sc.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(srcCanvas, 0, 0, dm.w, dm.h);
    var sd = sctx.getImageData(0, 0, dm.w, dm.h);
    var gsrc = { data: sd.data, width: dm.w, height: dm.h };
    var gp = {};
    for (var k in P) gp[k] = P[k];
    gp.strip = Math.max(1, Math.round(P.strip * f));
    gp.amp = P.amp * f; gp.rgb = P.rgb * f; gp.scale = P.scale / f;
    var name = currentStem() + '.gif';
    exportCtl = (typeof AbortController === 'function') ? new AbortController() : null;
    setExporting(true);
    setStatus('Encoding GIF...');
    var opts = {};
    for (var pk in p) opts[pk] = p[pk];
    opts.signal = exportCtl ? exportCtl.signal : undefined;
    opts.width = dm.w; opts.height = dm.h;
    G.encode(function (i, n) {
      return E.render(gsrc, gp, i / n, null);   // fresh buffer: gif.js caches sample frames
    }, opts, function (a, b) {
      if (el.gifProgress) el.gifProgress.value = Math.max(0, Math.min(1, a));
    }).then(function (blob) {
      download(blob, name);
      var mb = blob.size / 1048576;
      setStatus('Saved ' + name + ' (' + mb.toFixed(2) + ' MB)' + (blob.size > GIF_WARN_BYTES ? ' - over 3 MB, micro.blog may reject or recompress it. Try the "small" preset.' : '.'),
                blob.size > GIF_WARN_BYTES ? 'warn' : 'info');
      if (el.gifInfo) el.gifInfo.textContent = dm.w + 'x' + dm.h + ', ' + p.frames + ' frames, actual ' + mb.toFixed(2) + ' MB';
    }).catch(function (e) {
      if (e && (e.name === 'AbortError' || /abort|cancel/i.test(e.message || ''))) setStatus('GIF export cancelled.');
      else setStatus('GIF export failed: ' + (e && e.message || e), 'error');
    }).then(function () { exportCtl = null; setExporting(false); updateGifInfo(); });
  }

  // ---- wiring ----
  function onSlider(e) {
    var id = e.target.id;
    P[id] = parseFloat(e.target.value);
    showOut(id);
    if (id !== 'seed' && P.level !== 0) { P.level = 0; markLevelButtons(); }
    markDirty();
  }
  function applyLevel(n) {
    if (!src) return;
    var q = E.paramsFromLevel(n, src.width, P.seed);
    for (var k in q) if (Object.prototype.hasOwnProperty.call(q, k)) P[k] = q[k];
    P.level = n;
    P.seed = q.seed != null ? q.seed : P.seed;
    syncControlsFromP();
    markDirty();
  }

  SLIDERS.forEach(function (id) { if (el[id]) el[id].addEventListener('input', onSlider); });
  if (el.blend) el.blend.addEventListener('change', function () {
    P.blend = el.blend.value;
    if (P.level !== 0) { P.level = 0; markLevelButtons(); }
    markDirty();
  });
  if (el.levels) el.levels.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-level]') : null;
    if (b && !exporting) applyLevel(Number(b.getAttribute('data-level')));
  });
  if (el.reroll) el.reroll.addEventListener('click', function () {
    setSlider('seed', Math.floor(Math.random() * 1000));
    markDirty();
  });
  if (el.reset) el.reset.addEventListener('click', function () {
    P.seed = DEFAULT_SEED;
    animOn = false; phase = 0;
    if (el.animate) el.animate.checked = false;
    applyLevel(DEFAULT_LEVEL);
  });
  if (el.animate) el.animate.addEventListener('change', function () {
    animOn = el.animate.checked;
    if (animOn) t0 = performance.now(); else phase = 0;
    markDirty();
  });
  if (el.genSource) el.genSource.addEventListener('click', function () { useProcedural(); setStatus('Using the procedural test image.'); });
  if (el.fileInput) el.fileInput.addEventListener('change', function () {
    var f = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';          // allow re-picking the same file
    if (f) loadFile(f);
  });
  if (el.savePng) el.savePng.addEventListener('click', savePng);
  if (el.saveDepth) el.saveDepth.addEventListener('click', saveDepth);
  if (el.saveGif) el.saveGif.addEventListener('click', saveGif);
  if (el.gifCancel) el.gifCancel.addEventListener('click', function () { if (exportCtl) exportCtl.abort(); });
  if (el.gifPreset) el.gifPreset.addEventListener('change', updateGifInfo);

  // drag and drop (whole window blocked from navigating away)
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  var dz = el.dropzone || el.out;
  dz.addEventListener('dragenter', function (e) { e.preventDefault(); if (dz.classList) dz.classList.add('dragover'); });
  dz.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (dz.classList) dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', function () { dz.classList && dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList && dz.classList.remove('dragover');
    if (exporting) return;
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  if (el.gifCancel) el.gifCancel.disabled = true;
  if (el.gifProgress) el.gifProgress.hidden = true;
  if (!window.GifExport) {
    if (el.saveGif) el.saveGif.disabled = true;
    if (el.gifInfo) el.gifInfo.textContent = 'GIF export unavailable (gif.js not loaded).';
  }

  // ---- boot ----
  useProcedural();
  applyLevel(DEFAULT_LEVEL);
  setStatus('Ready. Upload a photo or drop one on the preview.');
})();
