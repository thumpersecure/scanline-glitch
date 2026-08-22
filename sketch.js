// Scanline Displacement Glitch Lab — p5.js
// Technique: slice source into thin horizontal strips, shift each strip by
// Perlin noise + a diagonal depth gradient, split RGB channels per strip,
// then render multiple layers at increasing scale and blend them.

let srcImg = null;          // the source p5.Image
let params = {};
const MAXW = 900;           // working width cap for performance

function setup() {
  const wrap = document.getElementById('canvas-wrap');
  const c = createCanvas(640, 360);
  c.parent(wrap);
  pixelDensity(1);
  noLoop();
  makeNoiseSource();        // start with a procedural source
  wireControls();
  render();
}

// ---- controls -------------------------------------------------------------

const IDS = ['strip','amp','scale','diag','angle','rgb','spread',
             'layers','lscale','lop','seed'];

function readParams() {
  const v = id => parseFloat(document.getElementById(id).value);
  params = {
    strip: v('strip'), amp: v('amp'), scale: v('scale'),
    diag: v('diag'), angle: v('angle'),
    rgb: v('rgb'), spread: v('spread'),
    layers: v('layers'), lscale: v('lscale'), lop: v('lop'),
    blend: document.getElementById('blend').value,
    seed: v('seed'),
    animate: document.getElementById('animate').checked
  };
  // sync the number readouts
  const set = (id,val)=>{const o=document.getElementById(id);if(o)o.textContent=val;};
  set('stripOut',params.strip); set('ampOut',params.amp);
  set('scaleOut',params.scale.toFixed(3)); set('diagOut',params.diag.toFixed(2));
  set('angleOut',params.angle); set('rgbOut',params.rgb);
  set('spreadOut',params.spread.toFixed(1)); set('layersOut',params.layers);
  set('lscaleOut',params.lscale.toFixed(2)); set('lopOut',params.lop.toFixed(2));
  set('seedOut',params.seed);
}

function wireControls() {
  IDS.forEach(id => {
    document.getElementById(id).addEventListener('input', () => { render(); });
  });
  document.getElementById('blend').addEventListener('change', render);
  document.getElementById('genNoise').addEventListener('click', () => { makeNoiseSource(); render(); });
  document.getElementById('reset').addEventListener('click', resetControls);
  document.getElementById('reroll').addEventListener('click', () => {
    document.getElementById('seed').value = Math.floor(Math.random()*1000);
    render();
  });
  document.getElementById('save').addEventListener('click', () => {
    saveCanvas('scanline-glitch-' + document.getElementById('seed').value, 'png');
  });
  document.getElementById('animate').addEventListener('change', e => {
    if (e.target.checked) loop(); else { noLoop(); render(); }
  });
  document.getElementById('fileInput').addEventListener('change', handleFile);
}

function resetControls() {
  const defs = {strip:2,amp:40,scale:0.01,diag:0.6,angle:45,rgb:6,spread:1.0,
                layers:3,lscale:1.5,lop:0.5,seed:216};
  for (const k in defs) document.getElementById(k).value = defs[k];
  document.getElementById('blend').value = 'lighter';
  document.getElementById('animate').checked = false;
  noLoop(); render();
}

// ---- sources --------------------------------------------------------------

function handleFile(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image')) return;
  const url = URL.createObjectURL(file);
  loadImage(url, img => {
    srcImg = fitImage(img);
    resizeToSource();
    URL.revokeObjectURL(url);
    render();
  });
}

// Build a procedural "depth-ish" source from layered noise + bands.
function makeNoiseSource() {
  const w = 800, h = 450;
  const g = createGraphics(w, h);
  g.pixelDensity(1);
  g.loadPixels();
  const ns = 0.006;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = noise(x*ns, y*ns) * 0.7 + noise(x*ns*4, y*ns*4)*0.3;
      const band = 0.5 + 0.5*Math.sin((x*0.02) + (y*0.01));
      const v = constrain((n*0.7 + band*0.3) * 255, 0, 255);
      const i = 4*(y*w+x);
      g.pixels[i]   = v * 0.9 + 20;         // R
      g.pixels[i+1] = v;                    // G
      g.pixels[i+2] = 255 - v*0.6;          // B  (gives it colour depth)
      g.pixels[i+3] = 255;
    }
  }
  g.updatePixels();
  srcImg = g.get();
  resizeToSource();
}

function fitImage(img) {
  if (img.width <= MAXW) return img;
  const g = createGraphics(MAXW, Math.round(img.height * MAXW / img.width));
  g.pixelDensity(1);
  g.image(img, 0, 0, g.width, g.height);
  return g.get();
}

function resizeToSource() {
  if (!srcImg) return;
  resizeCanvas(srcImg.width, srcImg.height);
}

// ---- the glitch -----------------------------------------------------------

// Render one displaced pass into a graphics buffer.
function glitchPass(pass, t) {
  readParamsIfNeeded();
  const w = srcImg.width, h = srcImg.height;
  const g = createGraphics(w, h);
  g.pixelDensity(1);
  g.background(0);

  const angRad = params.angle * Math.PI / 180;
  const dx = Math.cos(angRad), dy = Math.sin(angRad);
  const diagRange = params.diag * params.amp;
  const seedOff = params.seed * 0.137 + pass * 53.3;

  for (let y = 0; y < h; y += params.strip) {
    const sh = Math.min(params.strip, h - y);
    // diagonal depth gradient: projection of (x=0,y) along the angle,
    // normalised across the diagonal extent of the image
    const proj = (0*dx + y*dy) / (Math.abs(w*dx) + Math.abs(h*dy) + 1);
    const diagShift = (proj - 0.5) * 2 * diagRange;

    // per-row noise displacement (animated by t when enabled)
    const n = noise(y * params.scale, seedOff + t) * 2 - 1;
    const base = n * params.amp + diagShift;

    // per-channel offsets — the "muted RBG lines"
    const off = params.rgb * (1 + pass * 0.3);
    const rShift = base + off * params.spread;
    const gShift = base;
    const bShift = base - off * params.spread;

    // draw each channel-shifted copy of the strip; blend adds them together
    g.push();
    g.blendMode(ADD);
    drawChannelStrip(g, y, sh, rShift, 'r');
    drawChannelStrip(g, y, sh, gShift, 'g');
    drawChannelStrip(g, y, sh, bShift, 'b');
    g.pop();
  }
  return g;
}

// Cache channel-isolated versions of the source so per-strip drawing is cheap.
let chanCache = null, chanCacheKey = '';
function ensureChannels() {
  const key = srcImg.width + 'x' + srcImg.height;
  if (chanCache && chanCacheKey === key) return;
  const w = srcImg.width, h = srcImg.height;
  srcImg.loadPixels();
  const mk = which => {
    const g = createGraphics(w, h); g.pixelDensity(1); g.loadPixels();
    for (let i = 0; i < srcImg.pixels.length; i += 4) {
      g.pixels[i]   = which==='r'?srcImg.pixels[i]:0;
      g.pixels[i+1] = which==='g'?srcImg.pixels[i+1]:0;
      g.pixels[i+2] = which==='b'?srcImg.pixels[i+2]:0;
      g.pixels[i+3] = 255;
    }
    g.updatePixels(); return g;
  };
  chanCache = { r: mk('r'), g: mk('g'), b: mk('b') };
  chanCacheKey = key;
}

function drawChannelStrip(g, y, sh, shift, which) {
  const w = srcImg.width;
  const img = chanCache[which];
  // draw the strip twice (offset ± width) so it wraps instead of leaving gaps
  g.image(img, Math.round(shift), y, w, sh, 0, y, w, sh);
  g.image(img, Math.round(shift) - w, y, w, sh, 0, y, w, sh);
  g.image(img, Math.round(shift) + w, y, w, sh, 0, y, w, sh);
}

let _paramsRead = false;
function readParamsIfNeeded(){ if(!_paramsRead){ readParams(); _paramsRead=true; } }

function render() {
  if (!srcImg) return;
  readParams();
  ensureChannels();
  background(0);
  const t = params.animate ? frameCount * 0.01 : 0;

  const modeMap = {screen:SCREEN, lighter:ADD, difference:DIFFERENCE,
                   overlay:OVERLAY, multiply:MULTIPLY};

  for (let p = 0; p < params.layers; p++) {
    const scaleF = lerp(1, params.lscale, params.layers>1 ? p/(params.layers-1) : 0);
    const layer = glitchPass(p, t);
    push();
    if (p === 0) blendMode(BLEND); else blendMode(modeMap[params.blend] || ADD);
    tint(255, p === 0 ? 255 : params.lop * 255);
    // draw scaled from centre for the interference / woven look
    const dw = width * scaleF, dh = height * scaleF;
    image(layer, (width-dw)/2, (height-dh)/2, dw, dh);
    pop();
  }
  blendMode(BLEND);
}

function draw() {
  // only used when animating
  if (params.animate) render();
}
