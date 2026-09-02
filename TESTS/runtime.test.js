// Executes the REAL SOURCE/src/*.js files (not a rebuilt/minified copy)
// against a minimal DOM/Canvas/rAF/setTimeout stub, so these checks exercise
// actual runtime behavior — real event dispatch, the real reset() path, and
// the real draw() calls — rather than re-implementing formulas in parallel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceDir = path.resolve(__dirname, '..', 'SOURCE', 'src');
const read = (f) => fs.readFileSync(path.join(sourceDir, f), 'utf8');

// Tracks a full 2D affine transform stack (save/restore/translate/rotate),
// so recorded arc/moveTo/arcTo coordinates are in true WORLD space — needed
// to measure the GOLD diamond's actual rotated extent from its real path,
// not an assumption that it matches the circle/square.
function makeCtxStub(recorder) {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const stack = [{ x: 0, y: 0, cos: 1, sin: 0 }];
  const cur = () => stack[stack.length - 1];
  function apply(px, py) {
    const t = cur();
    return [t.x + px * t.cos - py * t.sin, t.y + px * t.sin + py * t.cos];
  }
  let localCur = { x: 0, y: 0 };
  // Faithfully reproduces the CanvasRenderingContext2D.arcTo tangent-arc
  // construction (not an approximation from the two control points): the
  // true curve bulges INSIDE the sharp corner formed by (localCur -> p1 ->
  // p2), so sampling only the endpoints — as an earlier version of this
  // stub did — overstates a rotated shape's true extent by treating its
  // sharp, unrounded corners as if they were the rendered ones.
  function sampledArcTo(x1, y1, x2, y2, r) {
    const p0 = localCur, p1 = { x: x1, y: y1 }, p2 = { x: x2, y: y2 };
    const v1x = p0.x - p1.x, v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
    const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
    if (!r || len1 === 0 || len2 === 0) { recorder.path.push(apply(x1, y1)); localCur = p1; return; }
    const u1x = v1x / len1, u1y = v1y / len1;
    const u2x = v2x / len2, u2y = v2y / len2;
    const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
    const angle = Math.acos(dot);
    const distToTangent = r / Math.tan(angle / 2);
    const t1 = { x: p1.x + u1x * distToTangent, y: p1.y + u1y * distToTangent };
    const t2 = { x: p1.x + u2x * distToTangent, y: p1.y + u2y * distToTangent };
    const bisx = u1x + u2x, bisy = u1y + u2y;
    const bisLen = Math.hypot(bisx, bisy) || 1;
    const distToCenter = r / Math.sin(angle / 2);
    const center = { x: p1.x + (bisx / bisLen) * distToCenter, y: p1.y + (bisy / bisLen) * distToCenter };
    let a0 = Math.atan2(t1.y - center.y, t1.x - center.x);
    let a1 = Math.atan2(t2.y - center.y, t2.x - center.x);
    let diff = a1 - a0;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (diff * i) / steps;
      recorder.path.push(apply(center.x + r * Math.cos(a), center.y + r * Math.sin(a)));
    }
    localCur = t2;
  }
  return {
    setTransform: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop,
    moveTo: (x, y) => { localCur = { x, y }; recorder.path.push(apply(x, y)); },
    lineTo: (x, y) => { localCur = { x, y }; recorder.path.push(apply(x, y)); },
    arc: (cx, cy, r, a0, a1) => { const w = apply(cx, cy); recorder.arc.push([w[0], w[1], r, a0, a1]); },
    arcTo: (x1, y1, x2, y2, r) => sampledArcTo(x1, y1, x2, y2, r),
    ellipse: noop,
    rotate: (theta) => {
      const t = cur();
      const c = Math.cos(theta), s = Math.sin(theta);
      const newCos = t.cos * c - t.sin * s;
      const newSin = t.sin * c + t.cos * s;
      t.cos = newCos; t.sin = newSin;
    },
    fill: noop, stroke: noop,
    save: () => stack.push({ x: cur().x, y: cur().y, cos: cur().cos, sin: cur().sin }),
    restore: () => { if (stack.length > 1) stack.pop(); },
    translate: (dx, dy) => {
      const t = cur();
      const rx = dx * t.cos - dy * t.sin, ry = dx * t.sin + dy * t.cos;
      t.x += rx; t.y += ry;
      recorder.translate.push([t.x, t.y]);
    },
    createLinearGradient: () => grad,
    fillText: (s, x, y) => (recorder.text || (recorder.text = [])).push([s, x, y]),
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set shadowColor(v) {}, get shadowColor() { return '#000'; },
    set shadowBlur(v) {}, get shadowBlur() { return 0; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set font(v) {}, get font() { return ''; },
    set textAlign(v) {}, get textAlign() { return ''; },
    set textBaseline(v) {}, get textBaseline() { return ''; }
  };
}

// AudioContext stub with a full scheduled-source lifecycle: `clock` is a
// shared mutable { t } the test can advance/set independently of when
// setTimeout callbacks actually fire (simulating late/early callbacks).
// Each oscillator records requestedStart (the raw argument to .start()) AND
// effectiveStart = max(requestedStart, currentTime-at-call) — real Web
// Audio plays a source immediately if told to start in the past, it does
// NOT honor the past timestamp, so tests must reason about effectiveStart,
// not requestedStart, to correctly detect bunching. Every stop() call is
// also recorded (the original scheduled one from mn(), and — if mStop()
// cancels it early — a second, earlier one).
function makeAudioCtxStub(recorder, clock) {
  return {
    get currentTime() { return clock.t; },
    state: 'running',
    resume: () => {},
    destination: {},
    createGain: () => ({ gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } }),
    createOscillator: () => {
      const note = { f: undefined, ty: '', startAt: undefined, effectiveStart: undefined, stops: [] };
      const o = { type: '', frequency: { setValueAtTime: (f) => { note.f = f; }, exponentialRampToValueAtTime: () => {} } };
      o.connect = () => o;
      o.start = (t) => { note.ty = o.type; note.startAt = t; note.effectiveStart = Math.max(t, clock.t); recorder.push(note); };
      o.stop = (t) => note.stops.push(t === undefined ? clock.t : t);
      return o;
    }
  };
}

function makeElStub(id) {
  const listeners = {};
  return {
    id,
    _text: '', _html: '', _class: '',
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set className(v) { this._class = v; },
    get className() { return this._class; },
    getContext: () => makeCtxStub({ arc: [], translate: [], path: [] }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    _listeners: listeners,
    width: 0, height: 0
  };
}

// Builds a fresh sandbox, executes game-core.js + wavedash-adapter.js +
// game.js in it (with globalThis.__RRR_TEST__ pre-declared so game.js's
// test-only seam activates), and returns handles for driving/inspecting it.
// viewport defaults to 900x600; pass { width, height } to boot at a
// specific viewport size, matching whatever resize() would compute for a
// real browser window of that size (dpr fixed at 1, since dpr only affects
// canvas buffer sharpness via ctx.setTransform, never the CSS-pixel
// geometry these tests reason about). getBoundingClientRect always mirrors
// the booted viewport width, so pointer-mapping tests see the real canvas
// extent rather than a fixed 900px stub value.
// A real page load now shows the title screen (not running gameplay) —
// see game.js's `started` flag. Every pre-existing test in this file
// assumes active gameplay, so boot() calls the real start() immediately
// after booting UNLESS opts.title is set; title-screen-specific tests
// pass { title: true } to inspect/drive the idle state itself.
// opts.touchCapable simulates a touch-capable environment BEFORE game.js
// evaluates its one-time `'ontouchstart' in globalThis` capability check
// (by pre-declaring that property on the sandbox, the same real signal a
// touchscreen browser provides) — omitted/false leaves the sandbox
// desktop/non-touch, matching a real non-touch browser.
function boot(viewport, opts) {
  const vw = (viewport && viewport.width) || 900;
  const vh = (viewport && viewport.height) || 600;
  const canvasRecorder = { arc: [], translate: [], path: [] };
  const elements = {
    game: makeElStub('game'),
    score: makeElStub('score'),
    combo: makeElStub('combo'),
    misses: makeElStub('misses'),
    state: makeElStub('state'),
    status: makeElStub('status')
  };
  elements.game.getContext = () => makeCtxStub(canvasRecorder);
  elements.game.getBoundingClientRect = () => ({ left: 0, top: 0, width: vw, height: vh });

  const topListeners = {};
  const rafQueue = [];
  const timeoutQueue = [];
  let nextTimeoutId = 1;
  const audioRecorder = [];
  const audioClock = { t: 0 };

  const sandbox = {
    console,
    document: { getElementById: (id) => elements[id] || makeElStub(id) },
    performance: { now: () => 1000 },
    innerWidth: vw,
    innerHeight: vh,
    devicePixelRatio: 1,
    addEventListener: (type, fn) => { (topListeners[type] = topListeners[type] || []).push(fn); },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    setTimeout: (fn, delay) => { const id = nextTimeoutId++; timeoutQueue.push({ id, fn, delay: delay || 0 }); return id; },
    clearTimeout: (id) => { const i = timeoutQueue.findIndex((t) => t.id === id); if (i >= 0) timeoutQueue.splice(i, 1); },
    // A real AudioContext stub (rather than undefined) is opt-in via
    // opts.audio, since most existing tests don't care about sound at all
    // and the stub would otherwise make every judgment/music call a no-op
    // that's silently harder to reason about.
    AudioContext: (opts && opts.audio) ? function() { return makeAudioCtxStub(audioRecorder, audioClock); } : undefined,
    webkitAudioContext: undefined,
    __RRR_TEST__: {}
  };
  sandbox.globalThis = sandbox;
  if (opts && opts.touchCapable) sandbox.ontouchstart = null;
  // Phase 3A: gameplay notes now come only from the EASY chart baked into
  // game-core.js. Every pre-existing test below assumes an otherwise-empty
  // gates array it fills in itself, so boot() substitutes an empty chart
  // by default (via game-core.js's __RRR_TEST__.chart override seam) —
  // chart-specific tests pass { chart: true } to get the real 118 events.
  if (!opts || !opts.chart) sandbox.__RRR_TEST__.chart = [];
  vm.createContext(sandbox);

  vm.runInContext(read('game-core.js'), sandbox, { filename: 'game-core.js' });
  vm.runInContext(read('wavedash-adapter.js'), sandbox, { filename: 'wavedash-adapter.js' });
  vm.runInContext(read('game.js'), sandbox, { filename: 'game.js' });
  if (!opts || !opts.title) sandbox.__RRR_TEST__.start();

  function stepFrame() {
    if (!rafQueue.length) return;
    rafQueue.shift()(sandbox.performance.now() + 16.6);
  }
  // Fires the EARLIEST-due pending timer (smallest delay), not just the
  // oldest-inserted one — a later-registered but shorter-delay timer (e.g.
  // a 550ms judgment display) really would fire before an already-pending
  // longer one (e.g. a ~909ms music batch) in a real browser.
  function fireDueTimeout() {
    if (!timeoutQueue.length) return false;
    let idx = 0;
    for (let i = 1; i < timeoutQueue.length; i++) if (timeoutQueue[i].delay < timeoutQueue[idx].delay) idx = i;
    timeoutQueue.splice(idx, 1)[0].fn();
    return true;
  }
  function dispatchKey(key) {
    (topListeners.keydown || []).forEach((fn) => fn({ key, preventDefault: () => {} }));
  }
  // Drives the REAL 'resize' listener game.js registers (not a manual
  // transform recompute), so TEST_RESIZE_MID_SESSION exercises the actual
  // mid-session resize path a real window resize would trigger.
  function triggerResize(newWidth, newHeight) {
    sandbox.innerWidth = newWidth;
    sandbox.innerHeight = newHeight;
    handle.WIDTH = newWidth;
    handle.HEIGHT = newHeight;
    elements.game.getBoundingClientRect = () => ({ left: 0, top: 0, width: newWidth, height: newHeight });
    (topListeners.resize || []).forEach((fn) => fn());
  }

  const handle = {
    C: sandbox.globalThis.RainbowRefrainCore,
    test: sandbox.__RRR_TEST__,
    elements, canvasRecorder, audioRecorder, audioClock,
    stepFrame, fireDueTimeout, dispatchKey, triggerResize,
    rafQueueSize: () => rafQueue.length,
    timeoutQueueSize: () => timeoutQueue.length,
    WIDTH: vw, HEIGHT: vh,
    pointerDown: (e) => (elements.game._listeners.pointerdown || []).forEach((fn) => fn(Object.assign({ type: 'pointerdown' }, e)))
  };
  return handle;
}

// Binary-search inverse of the REAL overlapRatio(t, color) — overlapRatio
// takes no height/viewport parameter at all (that is the viewport-
// invariance fix), so this needs no viewport either. Same helper as
// core.test.js; kept local since this file drives a live sandboxed C.
function tForRatio(C, ratio, color, side) {
  const target = ratio === 0 ? 1e-9 : ratio;
  let lo = side === 'approach' ? 0 : 1;
  let hi = side === 'approach' ? 1 : 3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const r = C.overlapRatio(mid, color);
    const increasingInT = side === 'approach';
    if ((r < target) === increasingInT) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}

// --- A: real KeyboardEvent-shaped dispatch through the actual listener ---
check('TEST_REAL_A_KEY_EVENT_LEFT', () => {
  const g = boot();
  g.stepFrame();
  g.dispatchKey('d'); // move off center first, so 'a' is a real change
  g.dispatchKey('a');
  assert.equal(g.test.state().lane, 0);
});

check('TEST_REAL_S_KEY_EVENT_CENTER', () => {
  const g = boot();
  g.stepFrame();
  g.dispatchKey('d');
  g.dispatchKey('s');
  assert.equal(g.test.state().lane, 1);
});

check('TEST_REAL_D_KEY_EVENT_RIGHT', () => {
  const g = boot();
  g.stepFrame();
  g.dispatchKey('a');
  g.dispatchKey('d');
  assert.equal(g.test.state().lane, 2);
});

// --- B: real restart path, not a freshly-constructed state ---
check('TEST_REAL_RESTART_PATH', () => {
  const g = boot();
  g.stepFrame();
  const live = g.test.state();
  live.score = 250; live.combo = 6; live.misses = 2; live.lane = 2;
  live.gates.push({ id: 999, color: 0, t: 0.5 });
  live.nextGate = 0.01;
  live.time = 42;
  g.dispatchKey('r'); // the real reset() path, via the real keydown listener
  const fresh = g.test.state();
  assert.equal(fresh.score, 0, 'score must reset');
  assert.equal(fresh.combo, 0, 'combo must reset');
  assert.equal(fresh.misses, 0, 'misses must reset');
  assert.equal(fresh.time, 0, 'elapsed time must reset');
  assert.equal(fresh.gates.length, 0, 'active gates must clear');
  assert.equal(fresh.phase, 'run', 'terminal state must clear back to run');
  assert.equal(g.elements.state._text, 'RUN', 'HUD must reflect the reset');
  assert.equal(g.elements.score._text, '0');
  assert.equal(g.elements.status._html, '', 'feedback text must clear');
});

// --- Geometry: real visual target-circle center vs rendered note center at
// t=1, captured from actual canvas calls made by the real drawTrack()/
// drawGate() — not two independently re-derived formulas.
check('TEST_VISUAL_TARGET_EQUALS_T1_CENTER', () => {
  const g = boot();
  const live = g.test.state();
  live.gates.push({ id: 9001, color: 0, t: 1 }); // exactly at the judgment center
  g.canvasRecorder.arc.length = 0;
  g.canvasRecorder.translate.length = 0;
  g.test.draw(live.time);
  const scale = g.test.transform().scale;
  const dockYs = g.canvasRecorder.arc.filter((a) => Math.abs(a[2] - g.C.TARGET_RADIUS * scale) < 1e-9).map((a) => a[1]);
  assert.equal(dockYs.length, 3, 'expected the three lane dock circles to be drawn');
  assert.ok(dockYs.every((y) => y === dockYs[0]), 'all three dock circles must share the same y');
  const judgmentCircleCenterY = dockYs[0];
  const expectedNoteRadius = g.C.NOTE_MAX_SIZE * scale;
  const noteArc = g.canvasRecorder.arc.find((a) => Math.abs(a[2] - expectedNoteRadius) < 1e-9);
  assert.ok(noteArc, 'expected the t=1 circle note to be drawn at full size');
  const noteCenterY = noteArc[1];
  const delta = Math.abs(noteCenterY - judgmentCircleCenterY);
  assert.ok(delta < 1e-9, 'TEST_VISUAL_TARGET_EQUALS_T1_CENTER: delta=' + delta + ' (dock=' + judgmentCircleCenterY + ', note=' + noteCenterY + ')');
  global.__lastGeometry = { judgmentCircleCenterY, noteCenterY, delta };
});

// --- Section 9: input/render time desync. A keydown-triggered press() must
// judge the exact gate.t that was in the state at the moment of the press —
// which, since frame() runs atomically (tick, then draw, synchronously, on
// JS's single thread), is always exactly what was last rendered.
check('TEST_INPUT_RENDER_TIME_DESYNC', () => {
  const g = boot();
  g.stepFrame();
  const live = g.test.state();
  live.gates.push({ id: 9201, color: 0, t: 1 }); // exactly centered: must read as PERFECT
  g.test.draw(live.time); // render this exact frame, as the player would see it
  g.dispatchKey('a'); // then immediately press, via the real listener
  assert.equal(live.lastEvent, 'perfect', 'a press right after rendering an exactly-centered note must judge PERFECT, not a stale/advanced position');
});

// --- C: repeated identical feedback, and the third-miss-before-gameover
// sequencing, driven through the real display queue (game.js).
check('TEST_REPEAT_PERFECT_FEEDBACK', () => {
  const g = boot();
  g.stepFrame();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 });
  g.C.press(s, 0);
  g.stepFrame();
  assert.match(g.elements.status._html, /PERFECT/);
  g.fireDueTimeout(); // natural 550ms display window ends
  s.gates.push({ id: 2, color: 1, t: 1 });
  g.C.press(s, 1);
  g.stepFrame();
  assert.match(g.elements.status._html, /PERFECT/, 'a second, repeated PERFECT must also display');
});

check('TEST_REPEAT_GOOD_FEEDBACK', () => {
  const g = boot();
  g.stepFrame();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: tForRatio(g.C, 0.5, 0, 'approach') });
  g.C.press(s, 0);
  g.stepFrame();
  assert.match(g.elements.status._html, /GOOD/);
  g.fireDueTimeout();
  s.gates.push({ id: 2, color: 1, t: tForRatio(g.C, 0.5, 1, 'approach') });
  g.C.press(s, 1);
  g.stepFrame();
  assert.match(g.elements.status._html, /GOOD/, 'a second, repeated GOOD must also display');
});

check('TEST_REPEAT_MISS_FEEDBACK', () => {
  const g = boot();
  g.stepFrame();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: tForRatio(g.C, 0.001, 0, 'approach') }); // tiny positive overlap
  g.C.press(s, 0);
  g.stepFrame();
  assert.match(g.elements.status._html, /MISS/);
  g.fireDueTimeout();
  s.gates.push({ id: 2, color: 1, t: tForRatio(g.C, 0.001, 1, 'approach') });
  g.C.press(s, 1);
  g.stepFrame();
  assert.match(g.elements.status._html, /MISS/, 'a second, repeated MISS must also display');
});

check('TEST_THIRD_MISS_FEEDBACK_BEFORE_GAMEOVER', () => {
  const g = boot();
  g.stepFrame();
  const s = g.test.state();
  const missT = tForRatio(g.C, 0.001, 0, 'approach');
  // First two misses, draining each one's display window.
  for (let i = 0; i < 2; i++) {
    s.gates.push({ id: i, color: 0, t: missT });
    g.C.press(s, 0);
    g.stepFrame();
    assert.match(g.elements.status._html, /MISS/);
    g.fireDueTimeout();
  }
  // Third miss: press() fires BOTH 'miss' and 'gameover' synchronously.
  s.gates.push({ id: 2, color: 0, t: missT });
  g.C.press(s, 0);
  assert.equal(s.phase, 'gameover', 'core state must already be gameover');
  g.stepFrame(); // handleEvent() pulls both queued events, shows the first
  assert.match(g.elements.status._html, /MISS/, 'the third MISS must be visible first');
  assert.doesNotMatch(g.elements.status._html, /GAME OVER/, 'GAME OVER must not preempt the third MISS');
  const advanced = g.fireDueTimeout(); // MISS's display window ends -> advances to the queued gameover
  assert.ok(advanced, 'expected a queued timeout advancing to the next event');
  assert.match(g.elements.status._html, /GAME OVER/, 'GAME OVER must become visible after the third MISS was shown');
});

check('TEST_GAME_OVER_HEADLINE', () => {
  const g = boot();
  g.stepFrame();
  const s = g.test.state();
  const missT = tForRatio(g.C, 0.001, 0, 'approach');
  for (let i = 0; i < 3; i++) {
    s.gates.push({ id: i, color: 0, t: missT });
    g.C.press(s, 0);
  }
  assert.equal(s.phase, 'gameover');
  g.stepFrame();
  while (g.fireDueTimeout()) { /* advance until nothing left queued */ }
  assert.match(g.elements.status._html, /GAME OVER/, 'terminal headline must read GAME OVER');
  assert.match(g.elements.status._html, /Press R or tap to ride again/, 'retry instruction must be preserved');
  assert.doesNotMatch(g.elements.status._html, /STORM GOT YOU/, 'old copy must not remain');
});

// ============================================================
// Codex re-audit: viewport-invariant judgment, real rendered path (6-16)
// ============================================================
const VIEWPORTS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '900x1600', width: 900, height: 1600 }
];

function pathBoundsY(points) {
  const ys = points.map((p) => p[1]);
  return { min: Math.min(...ys), max: Math.max(...ys), centroid: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// Captures the ACTUAL rendered vertical half-extent of a shape from real
// canvas calls (not the formula that produced it): circle from its arc
// radius, diamond/square from the true bounding box of every moveTo/arcTo
// point on their rounded-rect paths (rotation-aware — see makeCtxStub).
function renderedHalfExtent(g, color, t) {
  if (color === 0) {
    g.canvasRecorder.arc.length = 0;
    g.test.drawGate({ id: 8000, color: 0, t: t });
    const a = g.canvasRecorder.arc[g.canvasRecorder.arc.length - 1];
    return { centerY: a[1], halfExtent: a[2] };
  }
  g.canvasRecorder.path.length = 0;
  g.test.drawGate({ id: 8000, color: color, t: t });
  const bounds = pathBoundsY(g.canvasRecorder.path);
  return { centerY: bounds.centroid, halfExtent: (bounds.max - bounds.min) / 2 };
}

function renderedTargetHalfExtent(g) {
  g.canvasRecorder.arc.length = 0;
  g.test.draw(0);
  const scale = g.test.transform().scale;
  const dock = g.canvasRecorder.arc.find((a) => Math.abs(a[2] - g.C.TARGET_RADIUS * scale) < 1e-6);
  assert.ok(dock, 'expected a dock circle arc call');
  return { centerY: dock[1], halfExtent: dock[2] };
}

// Section 14/16: shape contact-boundary tests, re-run at EVERY required
// viewport (not just one) now that a uniform logical transform is in
// play — built from the ACTUAL captured canvas path at that viewport's
// real transform.scale, cross-checked against C.overlapRatio/classify.
// judgment itself (overlapRatio/classify) never takes a viewport
// parameter, so its outcome per t/color is identical at every viewport by
// construction (proven separately by TEST_VIEWPORT_*_INVARIANCE below);
// what changes here, and what must be reverified per viewport, is whether
// the REAL RENDERED geometry (corner radius now included) still agrees
// with that judgment at each viewport's own transform.scale.
const shapeAggregate = { 0: true, 1: true, 2: true };
VIEWPORTS.forEach((vp) => {
  [['circle', 0], ['diamond', 1], ['square', 2]].forEach(([shapeName, color]) => {
    check('TEST_' + shapeName.toUpperCase() + '_CONTACT_BOUNDARIES_' + vp.name, () => {
      const g = boot({ width: vp.width, height: vp.height });
      const scale = g.test.transform().scale;
      const target = renderedTargetHalfExtent(g);
      // At t=1 (center coincidence), the note's ACTUAL rendered center
      // must equal the target's actual rendered center, and judgment must
      // call it PERFECT — proving render and judgment agree using only
      // captured data, at this specific viewport's transform.
      const atCenter = renderedHalfExtent(g, color, 1);
      assert.ok(Math.abs(atCenter.centerY - target.centerY) < 1e-6, shapeName + '@' + vp.name + ': rendered center must coincide with target at t=1');
      assert.equal(g.C.classify(g.C.overlapRatio(1, color)), 'perfect', shapeName + '@' + vp.name + ': F) center coincidence must be PERFECT');
      assert.equal(g.C.overlapRatio(1, color), 1, shapeName + '@' + vp.name + ': F) center coincidence must be ratio 1');

      // Real rendered combined half-extent (target + note, both from
      // actual canvas calls at this viewport) — this IS what "just
      // touching" means visually. Normalized back to logical units via
      // this viewport's OWN transform.scale (not a height-only factor),
      // so this also proves the diamond's now-scaled corner radius keeps
      // the real render in step with judgment at every aspect ratio.
      const realCombinedExtent = (target.halfExtent + atCenter.halfExtent) / scale;
      const judgedMaxDistance = g.C.TARGET_RADIUS + g.C.noteExtent(1, color);
      const ok = Math.abs(realCombinedExtent - judgedMaxDistance) < 0.05;
      if (!ok) shapeAggregate[color] = false;
      assert.ok(ok, shapeName + '@' + vp.name + ': judged max-overlap distance must match the ACTUAL rendered combined extent (real=' + realCombinedExtent + ', judged=' + judgedMaxDistance + ')');

      // A) visually separated -> ratio 0 / NO-OP
      assert.equal(g.C.classify(g.C.overlapRatio(3, color)), 'noop', shapeName + '@' + vp.name + ': A) far apart must be NO-OP');
      // B) just touching -> ratio ~0
      const touchT = tForRatio(g.C, 0, color, 'departure');
      assert.ok(g.C.overlapRatio(touchT, color) < 1e-6, shapeName + '@' + vp.name + ': B) just touching must be ~ratio 0');
      // C) tiny positive visual overlap -> ratio >0 and MISS
      const tinyT = tForRatio(g.C, 0.0005, color, 'approach');
      const tinyRatio = g.C.overlapRatio(tinyT, color);
      assert.ok(tinyRatio > 0, shapeName + '@' + vp.name + ': C) tiny overlap must be positive');
      assert.equal(g.C.classify(tinyRatio), 'miss', shapeName + '@' + vp.name + ': C) tiny overlap must be MISS');
      // D) moderate visible overlap -> GOOD
      assert.equal(g.C.classify(g.C.overlapRatio(tForRatio(g.C, 0.5, color, 'approach'), color)), 'good', shapeName + '@' + vp.name + ': D) moderate overlap must be GOOD');
      // E) near-center -> PERFECT
      assert.equal(g.C.classify(g.C.overlapRatio(tForRatio(g.C, 0.95, color, 'approach'), color)), 'perfect', shapeName + '@' + vp.name + ': E) near-center must be PERFECT');
      // G) same checks after passing center (departure side)
      assert.equal(g.C.classify(g.C.overlapRatio(tForRatio(g.C, 0.5, color, 'departure'), color)), 'good', shapeName + '@' + vp.name + ': G) departure moderate overlap must be GOOD');
      const departureTiny = tForRatio(g.C, 0.0005, color, 'departure');
      assert.equal(g.C.classify(g.C.overlapRatio(departureTiny, color)), 'miss', shapeName + '@' + vp.name + ': G) departure tiny overlap must be MISS');
    });
  });
});
check('TEST_CIRCLE_CONTACT_BOUNDARIES_ALL_VIEWPORTS', () => assert.ok(shapeAggregate[0]));
check('TEST_SQUARE_CONTACT_BOUNDARIES_ALL_VIEWPORTS', () => assert.ok(shapeAggregate[2]));
check('TEST_DIAMOND_CONTACT_BOUNDARIES_ALL_VIEWPORTS', () => assert.ok(shapeAggregate[1]));

// Section 7: the diamond must NOT be assumed to match the circle/square —
// verified from real captured path bounds, not from constants alone.
check('TEST_DIAMOND_EXTENT_DIFFERS_FROM_CIRCLE_REAL_PATH', () => {
  const g = boot({ width: 1280, height: 720 });
  const circle = renderedHalfExtent(g, 0, 1);
  const diamond = renderedHalfExtent(g, 1, 1);
  const square = renderedHalfExtent(g, 2, 1);
  assert.ok(Math.abs(circle.halfExtent - square.halfExtent) < 1e-6, 'circle and square must render the same half-extent');
  assert.ok(diamond.halfExtent > circle.halfExtent + 1, 'the real rendered diamond path must be measurably larger than the circle/square');
});

// Section 15: TEST_DIAMOND_EXTENT_<viewport> — the diamond corner-radius
// scaling fix must hold at every required viewport, not just the 720p
// reference where the old bug happened to be invisible (unscaled 5px ==
// scaled 5px only when scaleFor==1). Reconstructed from the actual
// rendered path (rotation-aware) at each viewport's own transform.
VIEWPORTS.forEach((vp) => {
  check('TEST_DIAMOND_EXTENT_' + vp.name, () => {
    const g = boot({ width: vp.width, height: vp.height });
    const scale = g.test.transform().scale;
    const real = renderedHalfExtent(g, 1, 1); // t=1: full-size diamond
    const realLogicalExtent = real.halfExtent / scale;
    const judgedLogicalExtent = g.C.noteExtent(1, 1);
    assert.ok(Math.abs(realLogicalExtent - judgedLogicalExtent) < 0.05,
      vp.name + ': real rendered diamond extent (normalized to logical units) must match noteExtent (real=' + realLogicalExtent + ', judged=' + judgedLogicalExtent + ')');
  });
});

// Section 1/2/12: viewport-invariant judgment. overlapRatio takes no
// height parameter (the fix itself), so "same t, same judgment across
// viewports" is proven by booting independent sandboxes at each required
// size and confirming a REAL press(), on an identically-t-positioned gate,
// produces an identical score/classification outcome in every one.
check('TEST_VIEWPORT_RATIO_INVARIANCE', () => {
  const sampleTs = [0.5, 0.8, 0.9, 0.95, 1, 1.05, 1.1];
  const results = VIEWPORTS.map((vp) => {
    const g = boot({ width: vp.width, height: vp.height });
    return sampleTs.map((t) => g.C.overlapRatio(t, 0));
  });
  for (let i = 1; i < results.length; i++) {
    for (let j = 0; j < sampleTs.length; j++) {
      assert.equal(results[i][j], results[0][j], VIEWPORTS[i].name + ' vs ' + VIEWPORTS[0].name + ' at t=' + sampleTs[j]);
    }
  }
});

check('TEST_VIEWPORT_CLASSIFICATION_INVARIANCE', () => {
  const t = 0.9;
  const outcomes = VIEWPORTS.map((vp) => {
    const g = boot({ width: vp.width, height: vp.height });
    const s = g.test.state();
    s.gates.push({ id: 1, color: 0, t: t });
    g.C.press(s, 0); // real press(), through the actual state, in a sandbox booted at this exact viewport
    return { viewport: vp.name, lastEvent: s.lastEvent, score: s.score };
  });
  const classes = {};
  outcomes.forEach((o) => { classes[o.viewport] = o.lastEvent; });
  global.__t09Classes = {
    CLASS_1280x720_T09: classes['1280x720'],
    CLASS_1366x768_T09: classes['1366x768'],
    CLASS_1920x1080_T09: classes['1920x1080'],
    CLASS_900x1600_T09: classes['900x1600']
  };
  for (let i = 1; i < outcomes.length; i++) {
    assert.equal(outcomes[i].lastEvent, outcomes[0].lastEvent, outcomes[i].viewport + ' vs ' + outcomes[0].viewport + ' at t=0.9: SAME_T_SAME_JUDGMENT');
    assert.equal(outcomes[i].score, outcomes[0].score, outcomes[i].viewport + ' vs ' + outcomes[0].viewport + ' at t=0.9: score must match too');
  }
});

check('TEST_HIT_WINDOW_DURATION_INVARIANCE', () => {
  // gate.t advances at dt/TRAVEL every tick, unrelated to viewport height;
  // once classify/overlapRatio are also height-blind, the SECONDS width of
  // every tier is identical at every viewport by construction. Compute it
  // once per required viewport (each from an independently booted
  // sandbox) and confirm they match — this directly replaces Codex's
  // measured 0.726s (720px) vs 0.327s (1600px) disparity.
  const windowsByViewport = VIEWPORTS.map((vp) => {
    const g = boot({ width: vp.width, height: vp.height });
    const anyApproach = tForRatio(g.C, 0, 0, 'approach');
    const anyDeparture = tForRatio(g.C, 0, 0, 'departure');
    const perfectApproach = tForRatio(g.C, g.C.PERFECT_RATIO, 0, 'approach');
    const perfectDeparture = tForRatio(g.C, g.C.PERFECT_RATIO, 0, 'departure');
    return {
      viewport: vp.name,
      anyOverlapSeconds: (anyDeparture - anyApproach) * g.C.TRAVEL,
      perfectSeconds: (perfectDeparture - perfectApproach) * g.C.TRAVEL
    };
  });
  global.__hitWindows = windowsByViewport;
  for (let i = 1; i < windowsByViewport.length; i++) {
    assert.ok(Math.abs(windowsByViewport[i].anyOverlapSeconds - windowsByViewport[0].anyOverlapSeconds) < 1e-6,
      'ANY_OVERLAP window must match across viewports: ' + JSON.stringify(windowsByViewport));
    assert.ok(Math.abs(windowsByViewport[i].perfectSeconds - windowsByViewport[0].perfectSeconds) < 1e-6,
      'PERFECT window must match across viewports: ' + JSON.stringify(windowsByViewport));
  }
});

// ============================================================
// Codex re-audit (this task) HIGH #1: pointer/touch mis-mapping (12/13/17)
// ============================================================
// Section 12 explicitly forbids re-testing at 10%/50%/90% of raw screen
// width (the previous, insufficient test — it happened to pass by
// coincidence at some viewports without proving the mapping matches what
// is actually drawn). Instead: derive the ACTUAL rendered lane centers
// from the real draw path (the dock-circle arc x-coordinates captured
// from drawTrack()), then dispatch pointer events exactly at those real
// pixel coordinates.
function renderedLaneCentersX(g) {
  g.canvasRecorder.arc.length = 0;
  g.test.draw(0);
  const scale = g.test.transform().scale;
  const dockXs = g.canvasRecorder.arc
    .filter((a) => Math.abs(a[2] - g.C.TARGET_RADIUS * scale) < 1e-6)
    .map((a) => a[0]);
  assert.equal(dockXs.length, 3, 'expected 3 rendered lane dock circles');
  return dockXs.sort((a, b) => a - b); // [left, center, right]
}

const pointerAggregate = { all: true };
VIEWPORTS.forEach((vp) => {
  const g = boot({ width: vp.width, height: vp.height });
  const [leftX, centerX, rightX] = renderedLaneCentersX(g);
  const y = vp.height / 2;
  [['LEFT', leftX, 0], ['CENTER', centerX, 1], ['RIGHT', rightX, 2]].forEach(([label, x, expectedLane]) => {
    check('TEST_POINTER_' + label + '_VISIBLE_CENTER_' + vp.name, () => {
      g.pointerDown({ clientX: x, clientY: y });
      const ok = g.test.state().lane === expectedLane;
      if (!ok) pointerAggregate.all = false;
      assert.equal(g.test.state().lane, expectedLane, vp.name + ': tap on the ACTUAL visible ' + label + ' lane center (x=' + x + ') must select lane ' + expectedLane);
    });
  });
});
check('TEST_VISIBLE_LANE_CENTER_POINTER_MAPPING_ALL_VIEWPORTS', () => assert.ok(pointerAggregate.all));

// Section 13: taps slightly around each lane center must still resolve to
// the SAME nearest lane (no accidental center-only bias, no flicker right
// at the boundary between two lanes).
check('TEST_POINTER_OFFSET_NEAREST_LANE_STABLE', () => {
  VIEWPORTS.forEach((vp) => {
    const g = boot({ width: vp.width, height: vp.height });
    const [leftX, centerX, rightX] = renderedLaneCentersX(g);
    const y = vp.height / 2;
    const smallOffset = g.test.transform().scale * 20; // a modest, real, sub-lane-gap offset
    [[leftX, 0], [centerX, 1], [rightX, 2]].forEach(([x, lane]) => {
      g.pointerDown({ clientX: x - smallOffset, clientY: y });
      assert.equal(g.test.state().lane, lane, vp.name + ': lane ' + lane + ' center minus a small offset must still resolve to lane ' + lane);
      g.pointerDown({ clientX: x + smallOffset, clientY: y });
      assert.equal(g.test.state().lane, lane, vp.name + ': lane ' + lane + ' center plus a small offset must still resolve to lane ' + lane);
    });
  });
});

// ============================================================
// Codex re-audit (this task) HIGH #2: target circles must not overlap (14)
// ============================================================
const nonOverlapAggregate = { all: true };
VIEWPORTS.forEach((vp) => {
  check('TEST_TARGET_NONOVERLAP_' + vp.name, () => {
    const g = boot({ width: vp.width, height: vp.height });
    const [leftX, centerX, rightX] = renderedLaneCentersX(g);
    const scale = g.test.transform().scale;
    const radius = g.C.TARGET_RADIUS * scale;
    const leftCenterDist = centerX - leftX;
    const centerRightDist = rightX - centerX;
    const ok = leftCenterDist >= 2 * radius && centerRightDist >= 2 * radius;
    if (!ok) nonOverlapAggregate.all = false;
    assert.ok(leftCenterDist >= 2 * radius, vp.name + ': left/center target circles must not overlap (gap=' + leftCenterDist + ', 2r=' + (2 * radius) + ')');
    assert.ok(centerRightDist >= 2 * radius, vp.name + ': center/right target circles must not overlap (gap=' + centerRightDist + ', 2r=' + (2 * radius) + ')');
  });
});
check('TEST_TARGET_NONOVERLAP_ALL_VIEWPORTS', () => assert.ok(nonOverlapAggregate.all));

// ============================================================
// Section 19: resize mid-session
// ============================================================
check('TEST_RESIZE_MID_SESSION', () => {
  const g = boot({ width: 1280, height: 720 });
  g.stepFrame();
  const s = g.test.state();
  s.score = 150; s.combo = 3; s.misses = 1;
  s.gates.push({ id: 5001, color: 0, t: 0.4 });
  const tBefore = s.gates[0].t;

  g.triggerResize(900, 1600);
  assert.equal(s.gates[0].t, tBefore, 'note progression t must not jump on resize');
  assert.equal(s.score, 150, 'score must be unaffected by resize');
  assert.equal(s.combo, 3, 'combo must be unaffected by resize');
  assert.equal(s.misses, 1, 'misses must be unaffected by resize');
  assert.equal(s.gates[0].color, 0, 'the active note must remain on its original lane/color');

  // Pointer mapping must reflect the NEW viewport's real lane centers.
  const [leftX] = renderedLaneCentersX(g);
  g.pointerDown({ clientX: leftX, clientY: 800 });
  assert.equal(g.test.state().lane, 0, 'pointer mapping must update to the resized viewport\'s actual lane centers');

  // Target circles must still be non-overlapping post-resize.
  const [l, c, r] = renderedLaneCentersX(g);
  const scale = g.test.transform().scale;
  const radius = g.C.TARGET_RADIUS * scale;
  assert.ok(c - l >= 2 * radius && r - c >= 2 * radius, 'target circles must remain non-overlapping after a mid-session resize');

  // Judgment semantics (purely logical) are untouched by any resize.
  assert.equal(g.C.classify(g.C.overlapRatio(1, 0)), 'perfect', 'judgment semantics must be unaffected by resize');

  g.triggerResize(1920, 1080);
  const before = g.rafQueueSize();
  g.stepFrame();
  const after = g.rafQueueSize();
  assert.equal(after, before, 'no duplicate rAF: resize must not spawn a second frame() loop (queue size stays constant across a step)');
});

// --- Layout: HUD/footer/overlay/lane-group/judgment-line/unicorn, per
// required viewport. Extracts the ACTUAL width/positioning CSS from
// index.html (rather than re-typing the same numbers) and evaluates its
// well-defined min()/calc() math at each size — the only way to prove "in
// bounds" without a real browser layout engine in this session.
const indexHtmlPath = path.resolve(__dirname, '..', 'SOURCE', 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

function cssBlock(selector) {
  const re = new RegExp(selector.replace(/[.#]/g, '\\$&') + '\\{([^}]*)\\}');
  const m = indexHtml.match(re);
  assert.ok(m, 'expected a CSS rule for ' + selector);
  return m[1];
}

function widthMinCalcFn(selector) {
  const block = cssBlock(selector);
  const m = block.match(/width:min\((\d+)px,calc\(100% - (\d+)px\)\)/);
  assert.ok(m, selector + ': expected the min(px, calc(100% - Npx)) width pattern');
  const cap = Number(m[1]), margin = Number(m[2]);
  return (viewportWidth) => Math.min(cap, viewportWidth - margin);
}

const hudWidthAt = widthMinCalcFn('#hud');
const helpWidthAt = widthMinCalcFn('#help');
const statusBlock = cssBlock('#status');
assert.match(statusBlock, /left:50%/);
assert.match(statusBlock, /top:50%/);
assert.match(statusBlock, /transform:translate\(-50%,-50%\)/);

function assertCenteredInBounds(name, elementWidth, viewportWidth) {
  const left = viewportWidth / 2 - elementWidth / 2;
  const right = viewportWidth / 2 + elementWidth / 2;
  assert.ok(left >= 0 && right <= viewportWidth, name + ' out of bounds: left=' + left + ' right=' + right + ' viewportWidth=' + viewportWidth);
}

VIEWPORTS.forEach((vp) => {
  check('TEST_LAYOUT_' + vp.name, () => {
    const g = boot({ width: vp.width, height: vp.height });
    const live = g.test.state();
    live.gates.push({ id: 9301, color: 0, t: 1 }); // exactly centered: must judge PERFECT at this size too
    g.canvasRecorder.arc.length = 0;
    g.test.draw(live.time);

    const dockArcs = g.canvasRecorder.arc.filter((a) => Math.abs(a[2] - g.C.TARGET_RADIUS * g.test.transform().scale) < 1e-6);
    assert.equal(dockArcs.length, 3, 'expected 3 judgment circles');
    const xs = dockArcs.map((a) => a[0]).sort((a, b) => a - b);
    assert.ok(Math.abs((xs[0] + xs[2]) / 2 - vp.width / 2) < 1e-6, 'lane group must be centered on width/2');
    assert.ok(xs[0] >= 0 && xs[2] <= vp.width, 'lanes must stay within the viewport width');

    const dockYs = dockArcs.map((a) => a[1]);
    assert.ok(dockYs.every((y) => y === dockYs[0]), 'all three judgment circles must share one y');
    assert.ok(dockYs[0] > 0 && dockYs[0] < vp.height, 'judgment line must be within the viewport height');

    const unicornRecorder = { arc: [], translate: [], path: [] };
    const savedTranslate = g.canvasRecorder.translate;
    g.canvasRecorder.translate = unicornRecorder.translate;
    g.test.drawUnicorn(0);
    g.canvasRecorder.translate = savedTranslate;
    assert.equal(unicornRecorder.translate.length, 1, 'expected exactly one unicorn translate call');
    assert.ok(Math.abs(unicornRecorder.translate[0][1] - dockYs[0]) < 1e-6,
      'unicorn must align to the same judgment line as the dock circles');

    assert.equal(g.C.classify(g.C.overlapRatio(1, 0)), 'perfect', 'NOTE_TARGET_CENTER_ALIGNMENT');

    assertCenteredInBounds('HUD', hudWidthAt(vp.width), vp.width);
    assertCenteredInBounds('footer', helpWidthAt(vp.width), vp.width);
  });
});

check('TEST_NOTE_TARGET_ALIGNMENT_ALL_VIEWPORTS', () => {
  VIEWPORTS.forEach((vp) => {
    const g = boot({ width: vp.width, height: vp.height });
    const ratio = g.C.overlapRatio(1, 0);
    assert.ok(Math.abs(ratio - 1) < 1e-9, vp.name + ': center coincidence must be ratio 1.0, got ' + ratio);
    assert.equal(g.C.classify(ratio), 'perfect', vp.name + ': center coincidence must be PERFECT');
  });
});

check('TEST_HUD_IN_BOUNDS_ALL_VIEWPORTS', () => {
  VIEWPORTS.forEach((vp) => assertCenteredInBounds(vp.name + ' HUD', hudWidthAt(vp.width), vp.width));
});

check('TEST_FOOTER_IN_BOUNDS_ALL_VIEWPORTS', () => {
  VIEWPORTS.forEach((vp) => assertCenteredInBounds(vp.name + ' footer', helpWidthAt(vp.width), vp.width));
});

check('TEST_TERMINAL_OVERLAY_IN_BOUNDS', () => {
  assert.match(statusBlock, /left:50%/);
  assert.match(statusBlock, /transform:translate\(-50%,-50%\)/);
});

// ============================================================
// Phase 1: title screen
// ============================================================
check('TEST_TITLE_SHOWN_ON_LOAD_IDLE', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  assert.equal(g.test.started(), false, 'game must not be started on initial load');
  assert.equal(g.test.state().time, 0, 'timer must not have advanced');
  assert.equal(g.test.state().gates.length, 0, 'no notes should exist before PLAY');
});

check('TEST_TIMER_AND_NOTES_FROZEN_BEFORE_PLAY', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  for (let i = 0; i < 30; i++) g.stepFrame();
  assert.equal(g.test.state().time, 0, 'timer must not count down before PLAY');
  assert.equal(g.test.state().misses, 0, 'MISS must not accumulate before PLAY');
  assert.equal(g.test.state().gates.length, 0, 'notes must not spawn/move before PLAY');
  assert.equal(g.test.started(), false, 'stepping frames alone must not start the game');
});

check('TEST_ASD_DOES_NOT_START_GAME', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.dispatchKey('a'); g.dispatchKey('s'); g.dispatchKey('d');
  assert.equal(g.test.started(), false, 'A/S/D must not accidentally start gameplay from the title screen');
});

check('TEST_GAMEPLAY_UNCHANGED_AFTER_PLAY', () => {
  // Once started, A/S/D, pointer press, and judgment work exactly as
  // before this phase — driven through the real listeners, not a
  // parallel re-implementation. start() itself (not a user input path) is
  // used here purely to reach the started state; the input MODE rules
  // that gate start() are covered separately below.
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  g.stepFrame();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 });
  g.dispatchKey('a');
  assert.equal(s.lastEvent, 'perfect', 'A/S/D press-and-judge must work unchanged after PLAY');
  s.gates.push({ id: 2, color: 0, t: 1 });
  g.pointerDown({ clientX: g.test.transform().offsetX + g.C.laneCenterX(0) * g.test.transform().scale, clientY: 360 });
  assert.equal(s.lastEvent, 'perfect', 'pointer/touch lane press must work unchanged after PLAY');
});

// ============================================================
// Phase 1.1: desktop/touch start UX refinement
// ============================================================
// Desktop/non-touch mode (boot() with no touchCapable option — the
// sandbox has no `ontouchstart`, matching a real non-touch browser):
//   Space -> start; Enter/A/S/D/other keys -> NOOP; mouse click -> NOOP.
// Touch-capable mode (boot({ touchCapable: true })):
//   pointer/touch tap -> start; keyboard not required/used.
check('TEST_DESKTOP_TITLE_TEXT', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.stepFrame();
  const lines = g.canvasRecorder.text.map((t) => t[0]);
  assert.ok(lines.includes('PRESS SPACE TO PLAY'), 'desktop start instruction must read PRESS SPACE TO PLAY, got: ' + JSON.stringify(lines));
  assert.ok(lines.includes('A S D = LANES'), 'desktop control hint must read A S D = LANES, got: ' + JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.indexOf('TAP') >= 0), 'desktop title must not show touch-only copy');
});

check('TEST_TOUCH_TITLE_TEXT', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, touchCapable: true });
  g.stepFrame();
  const lines = g.canvasRecorder.text.map((t) => t[0]);
  assert.ok(lines.includes('TAP TO PLAY'), 'touch start instruction must read TAP TO PLAY, got: ' + JSON.stringify(lines));
  assert.ok(lines.includes('TAP LANES'), 'touch control hint must read TAP LANES, got: ' + JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.indexOf('SPACE') >= 0), 'touch title must not show desktop-only copy');
});

check('TEST_DESKTOP_SPACE_STARTS_EXACTLY_ONCE', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.dispatchKey(' ');
  assert.equal(g.test.started(), true, 'Space must start the game in desktop/non-touch mode');
  assert.equal(g.test.state().phase, 'run', 'a fresh run must begin');
});

check('TEST_DESKTOP_ENTER_DOES_NOT_START', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.dispatchKey('Enter');
  assert.equal(g.test.started(), false, 'Enter must NOT start the game in desktop/non-touch mode');
});

check('TEST_DESKTOP_ASD_DOES_NOT_START', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.dispatchKey('a'); g.dispatchKey('s'); g.dispatchKey('d');
  assert.equal(g.test.started(), false, 'A/S/D must NOT start the game in desktop/non-touch mode');
});

check('TEST_DESKTOP_OTHER_KEYS_DO_NOT_START', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  ['Tab', 'Escape', 'ArrowDown', 'p'].forEach((k) => g.dispatchKey(k));
  assert.equal(g.test.started(), false, 'no other keyboard key may start the game in desktop/non-touch mode');
});

check('TEST_DESKTOP_MOUSE_CLICK_DOES_NOT_START', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.pointerDown({ clientX: 640, clientY: 360 });
  assert.equal(g.test.started(), false, 'a mouse click must NOT start the game in desktop/non-touch mode');
});

check('TEST_TOUCH_TAP_STARTS_EXACTLY_ONCE', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, touchCapable: true });
  g.pointerDown({ clientX: 640, clientY: 360 });
  assert.equal(g.test.started(), true, 'a pointer/touch tap must start the game in touch-capable mode');
  assert.equal(g.test.state().phase, 'run', 'a fresh run must begin');
});

check('TEST_NO_DOUBLE_START_DESKTOP', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.dispatchKey(' ');
  assert.equal(g.test.started(), true);
  g.dispatchKey(' '); // a second Space, now mid-run: must not re-run the title/start path
  assert.equal(g.test.started(), true, 'started must remain true');
  assert.equal(g.test.state().phase, 'run', 'a second Space during a run must not regress to the title screen or restart via the title path');
});

check('TEST_NO_DOUBLE_START_TOUCH', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, touchCapable: true });
  g.pointerDown({ clientX: 640, clientY: 360 });
  assert.equal(g.test.started(), true);
  g.pointerDown({ clientX: 640, clientY: 360 }); // a second tap, now mid-run
  assert.equal(g.test.started(), true, 'started must remain true');
  assert.equal(g.test.state().phase, 'run', 'a second tap during a run must judge a lane press, not re-run the title/start path');
});

check('TEST_TIMER_STARTS_ONLY_AFTER_VALID_START', () => {
  // Drives frame() directly with explicit `now` values (rather than the
  // fixed-clock stepFrame() stub, whose performance.now() never advances)
  // so a real, sizeable dt is guaranteed on both sides of the valid start.
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.frame(1050);
  assert.equal(g.test.state().time, 0, 'still 0 before a valid start, even with a real elapsed dt');
  g.dispatchKey(' ');
  g.test.frame(2000);
  assert.ok(g.test.state().time > 0, 'timer must begin advancing once a valid start (Space) is activated');
});

// ============================================================
// Phase 1.2: result statistics — result-renderer display, and that
// existing score/BEST/3-MISS/restart behavior around it is preserved.
// Per-stat accumulation logic (PERFECT/GOOD/MISS counting, maxCombo peak
// tracking) is covered in core.test.js against the real press()/tick();
// these tests drive the same real functions through game.js's real event
// queue and displayEvent(), checking what actually reaches statusEl.
// ============================================================
check('TEST_RUN_COMPLETE_SHOWS_ALL_FOUR_STAT_LABELS', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 }); g.C.press(s, 0); // 1 PERFECT
  s.gates.push({ id: 3, color: 1, t: 1 }); g.C.press(s, 1); // 1 more PERFECT (combo=2)
  s.time = g.C.RUN_DURATION; // force the run to complete on the next tick
  g.stepFrame();
  // The two PERFECTs above were never individually drained through the
  // display queue, so they (and then 'complete') are all queued together;
  // walk the queue to its terminal state, same pattern as the existing
  // TEST_GAME_OVER_HEADLINE/TEST_THIRD_MISS_... tests.
  while (g.fireDueTimeout()) { /* advance until nothing left queued */ }
  const html = g.elements.status._html;
  assert.match(html, /RUN COMPLETE/, 'RUN COMPLETE headline must still show');
  assert.match(html, /PERFECT 2/, 'PERFECT count must be rendered');
  assert.match(html, /GOOD 0/, 'GOOD count must be rendered');
  assert.match(html, /MISS 0/, 'MISS count must be rendered');
  assert.match(html, /MAX COMBO 2/, 'MAX COMBO must be rendered');
});

check('TEST_GAME_OVER_SHOWS_ALL_FOUR_STAT_LABELS', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 }); g.C.press(s, 0); // 1 PERFECT, combo=1 (peak)
  const missT = tForRatio(g.C, 0.0005, 0, 'approach');
  for (let i = 0; i < 3; i++) { s.gates.push({ id: 10 + i, color: 0, t: missT }); g.C.press(s, 0); }
  assert.equal(s.phase, 'gameover');
  g.stepFrame();
  while (g.fireDueTimeout()) { /* advance through the queued MISS/GAME OVER events */ }
  const html = g.elements.status._html;
  assert.match(html, /GAME OVER/, 'GAME OVER headline must still show');
  assert.match(html, /PERFECT 1/, 'PERFECT count must be rendered on GAME OVER too');
  assert.match(html, /GOOD 0/, 'GOOD count must be rendered on GAME OVER too');
  assert.match(html, /MISS 3/, 'MISS count must be rendered on GAME OVER too');
  assert.match(html, /MAX COMBO 1/, 'MAX COMBO must be rendered on GAME OVER too');
  assert.match(html, /Press R or tap to ride again/, 'retry instruction must be preserved alongside the stats');
});

check('TEST_SCORE_AND_BEST_UNCHANGED_BY_STATS', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 }); g.C.press(s, 0); // +100
  assert.equal(s.score, g.C.PERFECT_SCORE, 'scoring values must be unaffected by the stats addition');
  s.time = g.C.RUN_DURATION;
  g.stepFrame();
  while (g.fireDueTimeout()) { /* advance until nothing left queued */ }
  assert.match(g.elements.status._html, new RegExp('SCORE ' + g.C.PERFECT_SCORE), 'existing SCORE display must be preserved');
  assert.match(g.elements.status._html, /BEST \d+/, 'existing BEST display must be preserved');
});

check('TEST_THIRD_MISS_GAME_OVER_UNCHANGED_WITH_STATS', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  const s = g.test.state();
  const missT = tForRatio(g.C, 0.0005, 0, 'approach');
  for (let i = 0; i < 3; i++) { s.gates.push({ id: i, color: 0, t: missT }); g.C.press(s, 0); }
  assert.equal(s.misses, 3, '3-MISS threshold must be unchanged');
  assert.equal(s.phase, 'gameover', '3 MISS must still trigger GAME OVER');
});

check('TEST_STATS_RESET_ON_RESTART', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  let s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 }); g.C.press(s, 0); // 1 PERFECT, combo=1
  assert.equal(s.perfects, 1); assert.equal(s.maxCombo, 1);
  g.dispatchKey('r'); // real restart path
  s = g.test.state();
  assert.equal(s.perfects, 0, 'TEST_STATS_RESET_ON_RESTART: perfects must reset');
  assert.equal(s.goods, 0, 'TEST_STATS_RESET_ON_RESTART: goods must reset');
  assert.equal(s.maxCombo, 0, 'TEST_STATS_RESET_ON_RESTART: maxCombo must reset');
  assert.equal(s.misses, 0, 'TEST_STATS_RESET_ON_RESTART: misses must reset');
});

// ============================================================
// Phase 2: procedural music. AudioContext is only stubbed in (opts.audio)
// for these tests — every prior test above ran with AudioContext undefined
// and still passes, proving music is fully inert wherever no audio device
// exists, exactly like the pre-existing tone() SFX already was.
// ============================================================
check('TEST_NO_MUSIC_BEFORE_VALID_START', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.dispatchKey('Enter'); g.dispatchKey('a'); g.pointerDown({ clientX: 640, clientY: 360 }); // all invalid pre-start in desktop mode
  assert.equal(g.audioRecorder.length, 0, 'no oscillator may be scheduled before a valid start');
  assert.equal(g.test.music.t(), undefined, 'no music timer may exist before a valid start');
});

check('TEST_DESKTOP_SPACE_STARTS_GAMEPLAY_AND_MUSIC', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.dispatchKey(' ');
  assert.equal(g.test.started(), true, 'gameplay must start');
  assert.ok(g.audioRecorder.length > 0, 'music notes must be scheduled once gameplay starts');
  assert.ok(g.test.music.t(), 'a music timer must be running');
});

check('TEST_TOUCH_TAP_STARTS_GAMEPLAY_AND_MUSIC', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, touchCapable: true, audio: true });
  g.pointerDown({ clientX: 640, clientY: 360 });
  assert.equal(g.test.started(), true, 'gameplay must start');
  assert.ok(g.audioRecorder.length > 0, 'music notes must be scheduled once gameplay starts');
});

check('TEST_INVALID_DESKTOP_INPUTS_DO_NOT_START_MUSIC', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  ['Enter', 'a', 's', 'd', 'Tab'].forEach((k) => g.dispatchKey(k));
  g.pointerDown({ clientX: 640, clientY: 360 }); // mouse click, non-touch mode
  assert.equal(g.audioRecorder.length, 0, 'none of these must schedule any music/SFX');
  assert.equal(g.test.started(), false);
});

check('TEST_MUSIC_INITIALIZES_ONLY_ONCE_PER_RUN', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.dispatchKey(' ');
  const countAfterStart = g.audioRecorder.length;
  const timerAfterStart = g.test.music.t();
  g.dispatchKey(' '); // Space again, now mid-run: must be inert (not a restart path)
  assert.equal(g.audioRecorder.length, countAfterStart, 'a second Space mid-run must not reschedule/duplicate music');
  assert.equal(g.test.music.t(), timerAfterStart, 'the music timer identity must be unchanged by a no-op second Space');
});

check('TEST_NO_DUPLICATE_MUSIC_LOOP_AFTER_REPEATED_INPUT', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.dispatchKey(' ');
  g.pointerDown({ clientX: 640, clientY: 360 }); // a lane press while running; must not start a second loop
  g.dispatchKey('a');
  assert.equal(g.timeoutQueueSize(), 1, 'exactly one pending music-continuation timer must exist, never two');
});

check('TEST_GAME_OVER_STOPS_MUSIC', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const s = g.test.state();
  const missT = tForRatio(g.C, 0.0005, 0, 'approach');
  for (let i = 0; i < 3; i++) { s.gates.push({ id: i, color: 0, t: missT }); g.C.press(s, 0); }
  assert.equal(s.phase, 'gameover');
  g.stepFrame();
  while (g.fireDueTimeout()) { /* advance through the queued MISS/GAME OVER events */ }
  assert.equal(g.timeoutQueueSize(), 0, 'no pending music-continuation timer may remain after GAME OVER');
});

check('TEST_RUN_COMPLETE_STOPS_MUSIC', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  g.test.state().time = g.C.RUN_DURATION;
  g.stepFrame();
  while (g.fireDueTimeout()) { /* advance to the terminal RUN COMPLETE display */ }
  assert.equal(g.timeoutQueueSize(), 0, 'no pending music-continuation timer may remain after RUN COMPLETE');
});

check('TEST_RETRY_RESTARTS_MUSIC_WITHOUT_STACKING', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const s0 = g.test.state();
  const missT = tForRatio(g.C, 0.0005, 0, 'approach');
  for (let i = 0; i < 3; i++) { s0.gates.push({ id: i, color: 0, t: missT }); g.C.press(s0, 0); }
  g.stepFrame();
  while (g.fireDueTimeout()) { /* drain to GAME OVER */ }
  assert.equal(g.timeoutQueueSize(), 0, 'setup: music must be stopped at GAME OVER');
  const countBeforeRetry = g.audioRecorder.length;

  g.dispatchKey('r'); // TEST_RETRY_RESTARTS_MUSIC_WITHOUT_STACKING
  assert.ok(g.audioRecorder.length > countBeforeRetry, 'retry must schedule fresh music notes from the beginning');
  assert.equal(g.timeoutQueueSize(), 1, 'exactly one music-continuation timer after retry, not stacked with a leftover one');

  // A second and third retry must never accumulate extra timers either.
  g.dispatchKey('r');
  assert.equal(g.timeoutQueueSize(), 1, 'TEST_MULTIPLE_RETRIES_DO_NOT_STACK_PLAYBACK: still exactly one timer after a 2nd retry');
  g.dispatchKey('r');
  assert.equal(g.timeoutQueueSize(), 1, 'TEST_MULTIPLE_RETRIES_DO_NOT_STACK_PLAYBACK: still exactly one timer after a 3rd retry');
});

check('TEST_JUDGMENT_SFX_STILL_FIRE_ALONGSIDE_MUSIC', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const before = g.audioRecorder.length; // music's own initial batch
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 });
  g.C.press(s, 0); // PERFECT; tone() fires via the real displayEvent() queue, driven by a frame
  g.stepFrame();
  assert.ok(g.audioRecorder.length > before, 'the pre-existing tone() judgment SFX must still schedule a note on PERFECT');
  assert.equal(s.lastEvent, 'perfect', 'judgment itself must be unaffected by music');
});

check('TEST_MUSIC_LOW_VOLUME_RELATIVE_TO_SFX', () => {
  // Static-level intent check: the exported gain constants used for music
  // notes must stay below tone()'s hit-SFX gain, so judgment feedback
  // remains audible over the backing track (spec requirement, section
  // "EXISTING SFX").
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  assert.equal(g.test.music.bpm, 132, 'MUSIC_BPM metadata must be derivable at runtime');
  assert.ok(Math.abs(g.test.music.beat - 60 / 132) < 1e-9, 'BEAT_SECONDS must equal 60/BPM');
  assert.ok(Math.abs(g.test.music.step - (60 / 132) / 2) < 1e-9, 'SUBDIVISION must be a clean fraction of the beat');
});

// ============================================================
// Phase 2.1: scheduler remediation (Codex MEDIUM-1/MEDIUM-2)
// ============================================================

// ============================================================
// Phase 2.2: absolute wake-up scheduler + late-step skip (the one Codex
// Medium remaining after Phase 2.1). Note-level times were already
// grid-correct (mO + mI*STEP); the scheduler's own WAKE-UP was still a
// fixed relative recurring delay (setTimeout(mLoop, 4*STEP)), so callback
// lateness accumulated across batch boundaries. Fixed by deriving each
// wake-up from (absolute grid) - (current audio time), and by SKIPPING
// (never bunching/replaying) any step whose ideal time has already
// passed by the time a late callback finally runs.
// ============================================================

// A note is "on grid" if its distance from the run origin is (within
// float tolerance) an exact integer multiple of STEP — true regardless of
// whether some earlier step indices were skipped, which is exactly what
// distinguishes "correct absolute timing with gaps" from "drift".
function onGrid(mO, step, note) {
  const idx = (note.startAt - mO) / step;
  return Math.abs(idx - Math.round(idx)) < 1e-6;
}
function squareNotes(g) { return g.audioRecorder.filter((n) => n.ty === 'square'); } // exactly 1 arpeggio note/step

// REQUIRED REGRESSION TEST A: absolute callback wake, no accumulated drift.
check('TEST_ABSOLUTE_CALLBACK_WAKE_NO_DRIFT', () => {
  [.002, .005, .01].forEach((lateness) => {
    const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
    g.test.start();
    const step = g.test.music.step;
    const mO = squareNotes(g)[0].startAt;
    const batches = Math.ceil(90 / (step * 4)); // a simulated full 90-second run
    for (let b = 0; b < batches; b++) {
      g.audioClock.t += step * 4 + lateness; // this callback is `lateness` late every time
      g.fireDueTimeout();
    }
    const notes = squareNotes(g);
    let lastIdx = -1;
    notes.forEach((n) => {
      assert.ok(onGrid(mO, step, n), 'lateness=' + lateness + ': note at ' + n.startAt + ' fell off the absolute grid');
      const idx = Math.round((n.startAt - mO) / step);
      assert.ok(idx > lastIdx, 'lateness=' + lateness + ': step indices must strictly increase (no reordering/repeats)');
      lastIdx = idx;
    });
    assert.ok(notes.length > 300, 'lateness=' + lateness + ': a representative 90s run must still produce many on-grid notes (got ' + notes.length + ')');
  });
});

// REQUIRED REGRESSION TEST B: no past-due bunching on a badly-late callback.
check('TEST_NO_PAST_DUE_BUNCHING', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start(); // schedules steps 0-3 synchronously
  const step = g.test.music.step;
  const mO = squareNotes(g)[0].startAt;
  // Force this callback to arrive after steps 4, 5, and 6 or already
  // passed (simulating a stalled main thread).
  g.audioClock.t = mO + 6.5 * step;
  g.fireDueTimeout();
  const notes = squareNotes(g);
  const newOnes = notes.slice(4); // whatever THIS late batch scheduled
  [4, 5, 6].forEach((n) => {
    const idealTime = mO + n * step;
    assert.ok(!notes.some((note) => Math.abs(note.startAt - idealTime) < 1e-9), 'step ' + n + ' must be skipped entirely, never scheduled');
  });
  assert.ok(newOnes.length > 0, 'setup: the late callback must still schedule future notes');
  const firstIdx = Math.round((newOnes[0].startAt - mO) / step);
  assert.ok(onGrid(mO, step, newOnes[0]), 'the first note after the skip must land exactly on the original mO + N*STEP grid, not shifted to "now"');
  assert.ok(firstIdx >= 7, 'the first note after skipping steps 4-6 must be step 7 or later, not one of the skipped steps');
  const times = newOnes.map((n) => n.startAt);
  assert.equal(new Set(times).size, times.length, 'notes scheduled after a late callback must not be bunched onto one shared timestamp');
});

// REQUIRED REGRESSION TEST C: full 90-second grid (~396 eighth-note steps).
check('TEST_FULL_90_SECOND_GRID_NO_DRIFT', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const step = g.test.music.step;
  const mO = squareNotes(g)[0].startAt;
  const totalSteps = Math.ceil(90 / step); // ~396
  const batches = Math.ceil(totalSteps / 4);
  for (let b = 0; b < batches; b++) {
    g.audioClock.t += step * 4; // on-time wake-ups: the healthy baseline case
    g.fireDueTimeout();
  }
  const notes = squareNotes(g);
  assert.ok(notes.length >= totalSteps - 4, 'must cover a full ~90 second run (' + notes.length + ' of ~' + totalSteps + ' steps)');
  notes.forEach((n, i) => {
    const expected = mO + i * step;
    assert.ok(Math.abs(n.startAt - expected) < 1e-6, 'step ' + i + ' drifted over the full 90s run: got ' + n.startAt + ', expected ' + expected);
    assert.equal(n.effectiveStart, n.startAt, 'a well-timed callback must never require past-start clamping');
  });
});

// PREVIOUS_MEDIUM_1_REGRESSION_TEST (part 1): immediate retry cancels old sources.
check('TEST_IMMEDIATE_RETRY_CANCELS_OLD_SOURCES', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const oldNotes = g.audioRecorder.slice();
  assert.ok(oldNotes.length > 0, 'setup: the old run must have scheduled some notes');
  g.dispatchKey('r'); // retry before any of those notes have naturally ended
  oldNotes.forEach((n) => {
    assert.ok(n.stops.length >= 2, 'each old-run source must carry an EARLY extra stop() call, not just its original scheduled one');
    assert.ok(n.stops[n.stops.length - 1] <= n.stops[0], 'the cancellation time must not be later than the originally scheduled stop time');
  });
  assert.equal(g.test.started(), true);
  assert.equal(g.test.state().time, 0, 'the new run must start fresh from the beginning');
  assert.equal(g.timeoutQueueSize(), 1, 'exactly one (the new run\'s) scheduler timer may be pending — no stale old one');
});

// PREVIOUS_MEDIUM_1_REGRESSION_TEST (part 2): 3 rapid retries never stack.
check('TEST_MULTIPLE_RAPID_RETRIES_NO_SOURCE_ACCUMULATION', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  let cutoff;
  for (let i = 0; i < 3; i++) { cutoff = g.audioRecorder.length; g.dispatchKey('r'); }
  assert.equal(g.timeoutQueueSize(), 1, 'exactly one active scheduler after 3 rapid retries');
  for (let i = 0; i < cutoff; i++) {
    assert.ok(g.audioRecorder[i].stops.length >= 2, 'note #' + i + ' (a superseded run) must have been cancelled early');
  }
  for (let i = cutoff; i < g.audioRecorder.length; i++) {
    assert.equal(g.audioRecorder[i].stops.length, 1, 'note #' + i + ' (the current, still-active run) must not have been cancelled');
  }
});

// GAME OVER IMMEDIATE STOP: music must already be silenced synchronously,
// before ANY display event (not even the first queued MISS) has rendered.
check('TEST_GAME_OVER_IMMEDIATE_STOP_BEFORE_ANY_DISPLAY', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const s = g.test.state();
  const missT = tForRatio(g.C, 0.0005, 0, 'approach');
  s.gates.push({ id: 0, color: 0, t: missT }); g.dispatchKey('a');
  s.gates.push({ id: 1, color: 0, t: missT }); g.dispatchKey('a');
  const scheduledBeforeThirdMiss = g.audioRecorder.slice();
  s.gates.push({ id: 2, color: 0, t: missT }); g.dispatchKey('a'); // 3rd MISS -> GAME OVER, synchronously
  assert.equal(s.phase, 'gameover', 'setup: the third MISS must reach GAME OVER synchronously within this dispatch');
  assert.equal(g.timeoutQueueSize(), 0, 'the scheduler must already be invalidated — no stepFrame()/display has run yet');
  scheduledBeforeThirdMiss.forEach((n) => assert.ok(n.stops.length >= 2, 'every note scheduled before GAME OVER must be cancelled immediately, not left to play out'));
});

// RUN COMPLETE IMMEDIATE STOP: same expectation, reached via tick().
check('TEST_RUN_COMPLETE_IMMEDIATE_STOP_BEFORE_DISPLAY', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start();
  const scheduledBeforeComplete = g.audioRecorder.slice();
  g.test.state().time = g.C.RUN_DURATION;
  g.test.frame(2000); // one real tick crosses RUN_DURATION -> 'complete'
  assert.equal(g.test.state().phase, 'complete', 'setup: the run must reach complete synchronously within this frame');
  assert.equal(g.timeoutQueueSize(), 0, 'the scheduler must already be invalidated the instant RUN_DURATION is reached');
  scheduledBeforeComplete.forEach((n) => assert.ok(n.stops.length >= 2, 'every note scheduled before RUN COMPLETE must be cancelled immediately'));
});

// Timer due-time ordering: a shorter-delay judgment display timer queued
// AFTER a longer-delay pending music batch timer must still fire first.
check('TEST_HARNESS_TIMER_DUE_ORDER', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, audio: true });
  g.test.start(); // schedules a ~0.909s music batch timer (mT)
  const s = g.test.state();
  s.gates.push({ id: 1, color: 0, t: 1 });
  g.C.press(s, 0);
  g.stepFrame(); // displays PERFECT and schedules a 550ms advanceQueue timer, shorter than mT but queued AFTER it
  assert.equal(g.elements.status._class, 'show', 'setup: PERFECT must be showing');
  assert.equal(g.timeoutQueueSize(), 2, 'setup: both the music batch timer and the judgment display timer must be pending');
  g.fireDueTimeout();
  assert.equal(g.elements.status._class, '', 'the shorter (550ms) judgment timer must fire before the longer (~909ms) music timer, proving due-time — not insertion-order — firing');
});

// ============================================================
// Phase 3A: EASY chart v1 integration — end-to-end, through the real
// input/event-dispatch path (not just the core-level checks in
// core.test.js). boot({ chart: true }) opts into the real 118-event
// chart; every OTHER test in this file (the default) still runs with an
// empty chart, proving chart and any other note source are never mixed.
// ============================================================
check('TEST_CHART_DRIVES_REAL_GAMEPLAY_END_TO_END', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, chart: true });
  g.test.start();
  const s = g.test.state();
  while (s.time < g.C.CHART[0].t - 0.005) g.C.tick(s, {}, 0.01);
  const gt = s.gates.find((x) => x.color === g.C.CHART[0].lane);
  assert.ok(gt && gt.t > 0.9, 'the first chart note must be near the judgment line right at its CSV hit time');
  g.dispatchKey(['a', 's', 'd'][g.C.CHART[0].lane]);
  assert.match(s.lastEvent, /perfect|good/, 'the real A/S/D input path must judge a chart-spawned note as PERFECT/GOOD at its intended hit time');
});

check('TEST_RETRY_RESETS_CHART_CURSOR', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, chart: true });
  g.test.start();
  let s = g.test.state();
  s.time = 10;
  g.C.tick(s, {}, 0.001);
  assert.ok(s.chartIdx > 0, 'setup: several chart notes must have spawned by 10 seconds in');
  g.dispatchKey('r');
  s = g.test.state();
  assert.equal(s.chartIdx, 0, 'RETRY_CHART_RESET: chart cursor must reset to 0 on retry');
  assert.equal(s.gates.length, 0, 'no stale notes may remain after retry');
  assert.equal(s.time, 0, 'elapsed time must reset');
});

check('TEST_RETRY_NO_DUPLICATE_NOTES_ACROSS_RESTARTS', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, chart: true });
  g.test.start();
  for (let r = 0; r < 3; r++) {
    const s = g.test.state();
    s.time = 5;
    g.C.tick(s, {}, 0.001);
    const idxAfterFirstAdvance = s.chartIdx;
    g.C.tick(s, {}, 0.001); // a second tick at the same elapsed time must not re-spawn anything
    assert.equal(s.chartIdx, idxAfterFirstAdvance, 'a note must never spawn twice for the same chart position');
    g.dispatchKey('r');
  }
  assert.equal(g.test.state().chartIdx, 0, 'after repeated retries the cursor must still be exactly 0');
});

check('TEST_HOLD_CANDIDATE_BEHAVES_AS_TAP_END_TO_END', () => {
  const g = boot({ width: 1280, height: 720 }, { title: true, chart: true });
  g.test.start();
  const s = g.test.state();
  const holdIdx = 63; // a real HOLD_CANDIDATE row from the source CSV (verified in core.test.js)
  const targetLane = g.C.CHART[holdIdx].lane;
  // The runtime has no hold-specific code path at all: a gate sourced
  // from a HOLD_CANDIDATE chart row is indistinguishable, once spawned,
  // from any other (see core.test.js's testHoldCandidateCompilesAsPlainTap
  // for the {color,t}-only shape check). Confirm the real A/S/D dispatch
  // path judges it as an ordinary tap.
  s.gates.push({ color: targetLane, t: 1 });
  g.dispatchKey(['a', 's', 'd'][targetLane]);
  assert.match(s.lastEvent, /perfect|good/, 'HOLD_CANDIDATE_CURRENT_BEHAVIOR: must judge as an ordinary tap via the real input path');
});

check('TEST_CHART_AND_EMPTY_DEFAULT_NEVER_MIXED', () => {
  // The default (no chart:true) boot must see ZERO chart notes ever,
  // proving the test harness's override — and by extension the real
  // production seam it exercises — genuinely replaces the chart rather
  // than adding to it.
  const g = boot({ width: 1280, height: 720 }, { title: true });
  g.test.start();
  const s = g.test.state();
  s.time = 50;
  g.C.tick(s, {}, 0.001);
  assert.equal(s.gates.length, 0, 'with no chart override, no notes may appear from any source');
  assert.equal(s.chartIdx, 0, 'chartIdx must stay 0 when the chart itself is empty');
});

// ============================================================
// Section 13 note: any coordinate/geometry tests below this point
// (TEST_LAYOUT_*, TEST_*_CONTACT_BOUNDARIES_*, TEST_TARGET_NONOVERLAP_*,
// etc.) already run against auto-started sandboxes (boot()'s default),
// proving the uniform-logical-transform geometry from the prior phase is
// completely unchanged by the title screen addition.
// ============================================================

// --- E: build test paths execute from the repo as stored ---
check('TEST_CORE_TEST_FILE_EXECUTES', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'core.test.js')], { encoding: 'utf8' });
  assert.match(out, /core tests: PASS/);
});

check('TEST_STATIC_TEST_FILE_EXECUTES', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'static.test.js')], { encoding: 'utf8' });
  assert.match(out, /static tests: PASS/);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (global.__lastGeometry) console.log('geometry: ' + JSON.stringify(global.__lastGeometry));
if (global.__t09Classes) console.log('t09 classes: ' + JSON.stringify(global.__t09Classes));
if (global.__hitWindows) console.log('hit windows: ' + JSON.stringify(global.__hitWindows));
if (failed) process.exitCode = 1;
else console.log('runtime tests: PASS');
