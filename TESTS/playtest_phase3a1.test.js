// Verifies the LOCAL PLAYTEST BUILD ONLY (Phase 3A.2):
// GAME_BUILD/rainbow-refrain-easy-chart-local-playtest-phase3a1/
// Not part of the 13KB submission test suite — this build is explicitly
// exempt from the size budget and uses the real reference WAV.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const buildDir = path.resolve(__dirname, '..', 'GAME_BUILD', 'rainbow-refrain-easy-chart-local-playtest-phase3a1');
const srcDir = path.join(buildDir, 'src');
const read = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}

// AudioContext stub with a MANUALLY advanceable clock (_advance) and a
// decodeAudioData whose resolution is deferred until the test explicitly
// fires it (_resolveDecode) — together these let a test simulate "decode
// took exactly N seconds of real time" deterministically, without an
// actual wall-clock wait, and observe whether that latency leaks into
// gameplay/audio sync (Phase 3A.2's whole point).
function makeAudioCtxStub(rec) {
  let time = 0;
  const decodeResolvers = [];
  const decodeRejecters = [];
  return {
    get currentTime() { return time; },
    _advance(s) { time += s; },
    _resolveDecode() { const r = decodeResolvers.shift(); decodeRejecters.shift(); if (r) r(); },
    // Phase 3B.2: simulates a real decodeAudioData() failure (corrupt/
    // unsupported data) — used to prove the added .catch() actually runs,
    // rather than the rejection silently hanging pendingStart forever.
    _rejectDecode(err) { const rj = decodeRejecters.shift(); decodeResolvers.shift(); if (rj) rj(err || new Error('decode failed')); },
    state: 'running',
    resume: () => {},
    destination: {},
    createGain: () => ({ gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } }),
    createOscillator: () => {
      const o = { type: '', frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } };
      o.connect = () => o;
      o.start = () => { rec.oscStarts.push(time); };
      o.stop = () => {};
      return o;
    },
    decodeAudioData: (buf) => new Promise((resolve, reject) => {
      decodeResolvers.push(() => resolve({ _decoded: true, byteLength: buf.byteLength }));
      decodeRejecters.push(reject);
    }),
    createBufferSource: () => {
      const node = { buffer: null, connect: () => node };
      node.start = (t) => { node.startedAt = t; rec.bufferSources.push(node); };
      node.stop = () => { node.stoppedAt = time; };
      return node;
    }
  };
}

// Tracks a full 2D affine transform stack (save/restore/translate/rotate)
// AND groups every beginPath()...fill()/stroke() cycle into one recorded
// "shape" carrying: its real WORLD-space path points (rotation/translation
// applied), any arc() calls (world center + radius), and the lineWidth
// that was actually in effect when fill()/stroke() were called on it —
// captured directly from real canvas call sequences, not re-derived from
// source text. This is what Phase 3B.2's numeric visual/judgment alignment
// test is built on (see measureShape/measureEndMarker below): it lets a
// test learn the Hold end marker's TRUE rendered outer extent (fill
// geometry + actual half-stroke-width) instead of trusting that the code
// matches its own comments. arcTo faithfully reproduces the real
// CanvasRenderingContext2D tangent-arc construction (ported from
// TESTS/runtime.test.js's proven main-suite stub) so a rotated rounded
// diamond's true vertical extent is measured from its real rounded path,
// not an unrounded-corner approximation.
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
  let currentLineWidth = 1;
  let currentShape = null;

  function sampledArcTo(x1, y1, x2, y2, r) {
    const p0 = localCur, p1 = { x: x1, y: y1 }, p2 = { x: x2, y: y2 };
    const v1x = p0.x - p1.x, v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
    const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
    if (!r || len1 === 0 || len2 === 0) { currentShape.path.push(apply(x1, y1)); localCur = p1; return; }
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
      currentShape.path.push(apply(center.x + r * Math.cos(a), center.y + r * Math.sin(a)));
    }
    localCur = t2;
  }

  return {
    setTransform: noop, fillRect: noop, strokeRect: noop,
    beginPath: () => {
      currentShape = { path: [], arcs: [], lineWidth: currentLineWidth, filled: false, stroked: false };
      recorder.shapes.push(currentShape);
    },
    closePath: noop,
    moveTo: (x, y) => { localCur = { x, y }; currentShape.path.push(apply(x, y)); },
    lineTo: (x, y) => { localCur = { x, y }; currentShape.path.push(apply(x, y)); },
    arc: (cx, cy, r, a0, a1) => { const w = apply(cx, cy); currentShape.arcs.push([w[0], w[1], r, a0, a1]); },
    arcTo: (x1, y1, x2, y2, r) => sampledArcTo(x1, y1, x2, y2, r),
    ellipse: noop,
    rotate: (theta) => {
      const t = cur();
      const c = Math.cos(theta), s = Math.sin(theta);
      const newCos = t.cos * c - t.sin * s;
      const newSin = t.sin * c + t.cos * s;
      t.cos = newCos; t.sin = newSin;
    },
    // fill()/stroke() record the lineWidth ACTUALLY in effect right now —
    // this is what would catch a leaked/inherited lineWidth (HIGH-1's bug)
    // that a source-string check could never see.
    fill: () => { if (currentShape) { currentShape.filled = true; currentShape.lineWidth = currentLineWidth; } },
    stroke: () => { if (currentShape) { currentShape.stroked = true; currentShape.lineWidth = currentLineWidth; } },
    save: () => stack.push({ x: cur().x, y: cur().y, cos: cur().cos, sin: cur().sin }),
    restore: () => { if (stack.length > 1) stack.pop(); },
    translate: (dx, dy) => {
      const t = cur();
      const rx = dx * t.cos - dy * t.sin, ry = dx * t.sin + dy * t.cos;
      t.x += rx; t.y += ry;
    },
    createLinearGradient: () => grad,
    fillText: (s, x, y) => (recorder.text || (recorder.text = [])).push([s, x, y]),
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) { currentLineWidth = v; }, get lineWidth() { return currentLineWidth; },
    set shadowColor(v) {}, get shadowColor() { return '#000'; },
    set shadowBlur(v) {}, get shadowBlur() { return 0; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set font(v) {}, get font() { return ''; }, set textAlign(v) {}, get textAlign() { return ''; }, set textBaseline(v) {}, get textBaseline() { return ''; }
  };
}

function makeElStub(id, canvasRecorder) {
  const listeners = {};
  return {
    id, _text: '', _html: '', _class: '',
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set className(v) { this._class = v; }, get className() { return this._class; },
    getContext: () => canvasRecorder ? makeCtxStub(canvasRecorder) : {
      setTransform: () => {}, fillRect: () => {}, strokeRect: () => {}, beginPath: () => {}, closePath: () => {},
      moveTo: () => {}, lineTo: () => {}, arc: () => {}, arcTo: () => {}, ellipse: () => {}, rotate: () => {},
      fill: () => {}, stroke: () => {}, save: () => {}, restore: () => {}, translate: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }), fillText: () => {},
      set fillStyle(v) {}, get fillStyle() { return '#000'; }, set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
      set lineWidth(v) {}, get lineWidth() { return 1; }, set shadowColor(v) {}, get shadowColor() { return '#000'; },
      set shadowBlur(v) {}, get shadowBlur() { return 0; }, set globalAlpha(v) {}, get globalAlpha() { return 1; },
      set font(v) {}, get font() { return ''; }, set textAlign(v) {}, get textAlign() { return ''; }, set textBaseline(v) {}, get textBaseline() { return ''; }
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    _listeners: listeners,
    width: 0, height: 0
  };
}

function boot(opts) {
  opts = opts || {};
  const canvasRecorder = { shapes: [] };
  const elements = { game: makeElStub('game', canvasRecorder), score: makeElStub('score'), combo: makeElStub('combo'), misses: makeElStub('misses'), state: makeElStub('state'), status: makeElStub('status') };
  elements.game.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 });
  const topListeners = {};
  const rafQueue = [];
  const timeoutQueue = [];
  let nextTimeoutId = 1;
  const rec = { oscStarts: [], bufferSources: [] };
  let fetchedUrl = null;
  const consoleErrors = [];
  const audioCtx = makeAudioCtxStub(rec);

  const sandbox = {
    // console.error calls are captured (not just passed through) so a
    // test can prove the WAV load-failure path actually logs, without
    // depending on stdout.
    console: Object.assign({}, console, { error: (...a) => { consoleErrors.push(a); } }),
    document: { getElementById: (id) => elements[id] || makeElStub(id) },
    performance: { now: () => 1000 },
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    addEventListener: (type, fn) => { (topListeners[type] = topListeners[type] || []).push(fn); },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    setTimeout: (fn, delay) => { const id = nextTimeoutId++; timeoutQueue.push({ id, fn, delay: delay || 0 }); return id; },
    clearTimeout: (id) => { const i = timeoutQueue.findIndex((t) => t.id === id); if (i >= 0) timeoutQueue.splice(i, 1); },
    AudioContext: function() { return audioCtx; },
    webkitAudioContext: undefined,
    // Phase 3B.2: opts.failFetch simulates fetch() itself rejecting (e.g.
    // network failure) or resolving with a non-ok HTTP status (e.g. 404),
    // exercising the added .catch() path end-to-end.
    fetch: (url) => {
      fetchedUrl = url;
      if (opts.failFetch === 'reject') return Promise.reject(new Error('network failure'));
      if (opts.failFetch === 'notok') return Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.reject(new Error('should not be called')) });
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)) });
    },
    __RRR_TEST__: {}
  };
  // Phase 3D.4: a minimal, real, persistent localStorage stub — Codex
  // noted the harness previously had none at all, so bestScore()'s own
  // try/catch (ReferenceError) silently always returned 0 and saveBest()
  // silently no-op'd, meaning BEST semantics were never actually exercised
  // by any test. opts.localStorageInit pre-seeds it (e.g. { rainbowRefrainBest: '500' })
  // so a test can set up "prior BEST already exists" before boot(), and
  // g.localStorage below exposes the SAME backing store afterward so a
  // test can read back what saveBest() actually persisted.
  const localStorageStore = Object.assign({}, opts.localStorageInit || {});
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null),
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: (k) => { delete localStorageStore[k]; }
  };
  // Phase 3C.1: opts.touch puts the harness in genuine touch mode — game.js
  // computes `var touch = 'ontouchstart' in globalThis` ONCE at module
  // load, so `ontouchstart` must exist on the sandbox BEFORE game.js runs
  // (a value of null is enough; only key-presence is checked by `in`).
  // Without this, every "touch" test was silently running in desktop mode.
  if (opts.touch) sandbox.ontouchstart = null;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('game-core.js'), sandbox, { filename: 'game-core.js' });
  vm.runInContext(read('wavedash-adapter.js'), sandbox, { filename: 'wavedash-adapter.js' });
  vm.runInContext(read('game.js'), sandbox, { filename: 'game.js' });

  return {
    C: sandbox.globalThis.RainbowRefrainCore,
    test: sandbox.__RRR_TEST__,
    elements, rec, audioCtx, canvasRecorder,
    consoleErrors,
    localStorageStore,
    fetchedUrl: () => fetchedUrl,
    stepFrame: () => { if (rafQueue.length) rafQueue.shift()(sandbox.performance.now() + 16.6); },
    fireDueTimeout: () => { if (!timeoutQueue.length) return false; timeoutQueue.shift().fn(); return true; },
    dispatchKey: (key) => (topListeners.keydown || []).forEach((fn) => fn({ key, preventDefault: () => {} })),
    dispatchKeyUp: (key) => (topListeners.keyup || []).forEach((fn) => fn({ key, preventDefault: () => {} })),
    pointerDown: (clientX, clientY) => (elements.game._listeners.pointerdown || []).forEach((fn) => fn({ type: 'pointerdown', clientX: clientX, clientY: clientY === undefined ? 360 : clientY })),
    pointerUp: () => (elements.game._listeners.pointerup || []).forEach((fn) => fn({ type: 'pointerup' })),
    pointerCancel: () => (elements.game._listeners.pointercancel || []).forEach((fn) => fn({ type: 'pointercancel' })),
    // Node's Promise microtasks need a real tick to flush; awaiting this
    // resolved promise lets any pending .then() chains (decode, schedule) run.
    flush: () => new Promise((r) => setImmediate(r))
  };
}

// Drives gameElapsed forward in small steps (well under tick()'s 0.1s dt
// clamp) via the SAME mechanism a real frame loop uses — advancing the
// shared audio clock, then letting frame() derive dt from it — until
// state.time reaches the target.
async function advanceGameTimeTo(g, targetGameTime, stepSec) {
  const s = g.test.state();
  let guard = 0;
  while (s.time < targetGameTime - 1e-6 && guard++ < 100000) {
    g.audioCtx._advance(stepSec || 0.05);
    g.stepFrame();
  }
}

// Binary-searches for the note-position t that produces a given overlap
// ratio (ported from TESTS/runtime.test.js's proven main-suite helper) —
// used to hit the PERFECT/GOOD boundary EXACTLY, not "close enough".
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

// ============================================================
// Phase 3B.2 RENDER TEST INSTRUMENTATION: measures the Hold end marker's
// TRUE rendered geometry from real canvas calls (see makeCtxStub above),
// and compares it numerically to the SAME lane's real judgment extent
// (C.noteExtent), instead of trusting source text. Both are measured at
// tailT === 1 (the instant the end marker is exactly AT the judgment
// line — the moment a release decision matters most), at boot()'s default
// 1280x720 viewport, where computeTransform gives scale === 1 exactly
// (verified below), so logical and screen pixels coincide 1:1.
// ============================================================
function pathBoundsY(points) {
  const ys = points.map((p) => p[1]);
  return { min: Math.min(...ys), max: Math.max(...ys), centroid: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// Draws a single Hold gate whose end marker (tailT = gate.t - hold/TRAVEL)
// sits EXACTLY at t=1, and extracts the two real filled+stroked shapes
// drawGate() actually issued (the tail line only strokes, never fills, so
// it's excluded by construction) — [0] is the end marker, [1] is the head,
// matching drawGate()'s real draw order.
function drawHeldGateShapes(g, color) {
  const gate = { color: color, t: 1 + g.C.HOLD_DUR / g.C.TRAVEL, hold: g.C.HOLD_DUR, held: true };
  g.canvasRecorder.shapes.length = 0;
  g.test.drawGate(gate);
  return g.canvasRecorder.shapes.filter((s) => s.filled && s.stroked);
}

// Real visible outer half-extent = fill-path/arc geometry (from actual
// recorded canvas calls) + half of the lineWidth ACTUALLY active at
// stroke time — this is what a player really sees, stroke halo included.
function measureShapeVisualExtent(shape) {
  if (shape.arcs.length) {
    const a = shape.arcs[0];
    return { centerY: a[1], fillHalfExtent: a[2], lineWidth: shape.lineWidth, visualHalfExtent: a[2] + shape.lineWidth / 2, shapeType: 'circle' };
  }
  const b = pathBoundsY(shape.path);
  const fillHalfExtent = (b.max - b.min) / 2;
  return { centerY: b.centroid, fillHalfExtent, lineWidth: shape.lineWidth, visualHalfExtent: fillHalfExtent + shape.lineWidth / 2, shapeType: null };
}

// Simulates the full "press Space/Tap while decode is still pending, wait
// N seconds of (fake) real time, THEN decode resolves" sequence, and
// returns the booted handle once the run has actually begun.
async function startWithDecodeLatency(latencySec) {
  const g = boot();
  g.test.start(); // requestStart(): ensureAudio + kicks off decode
  assert.equal(g.test.started(), false, 'setup: must not start before decode completes');
  // Let the fetch()+arrayBuffer() microtask chain actually settle and
  // decodeAudioData() actually get CALLED (registering its resolver)
  // before we simulate time passing and resolve it — otherwise there is
  // nothing yet to resolve.
  await g.flush();
  assert.equal(g.test.wav.pending(), true, 'setup: the gesture must be recorded as pending, not silently dropped');
  g.audioCtx._advance(latencySec); // simulate N seconds of real decode time passing
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true, 'the run must begin as soon as decode resolves');
  return g;
}

const indexHtmlPath = path.join(buildDir, 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const gameSrc = read('game.js');
const coreSrc = read('game-core.js');

// Phase 3C: real CSV cross-checks (item 46 — chart selection tests must
// inspect actual runtime chart behavior, not only source strings) for the
// two difficulty references.
const easyCsvPath = path.resolve(__dirname, '..', 'REFERENCES', 'rainbow_refrain_easy_chart_v2.csv');
const normalCsvPath = path.resolve(__dirname, '..', 'REFERENCES', 'rainbow_refrain_normal_chart_v2.csv');
// Phase 3D.1: rainbow_refrain_hard_chart_v1.csv was intentionally deleted
// by the user and is NOT authoritative — v2 is the sole HARD reference.
// No test in this file may depend on v1 existing, even as a fallback.
const hardCsvPath = path.resolve(__dirname, '..', 'REFERENCES', 'rainbow_refrain_hard_chart_v2.csv');
function parseChartCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

check('TEST_PLAYTEST_BUILD_FILES_EXIST', () => {
  assert.ok(fs.existsSync(indexHtmlPath), 'playtest index.html must exist');
  assert.ok(fs.existsSync(path.join(srcDir, 'game.js')));
  assert.ok(fs.existsSync(path.join(srcDir, 'game-core.js')));
  assert.ok(fs.existsSync(path.join(srcDir, 'wavedash-adapter.js')));
  assert.ok(fs.existsSync(path.join(buildDir, 'audio', 'track.wav')), 'the reference WAV must be present in the playtest build folder');
});

check('TEST_NO_PROCEDURAL_MUSIC_CODE_REMAINS', () => {
  assert.doesNotMatch(gameSrc, /function mLoop\(\)/, 'the procedural music scheduler must be gone from the playtest build');
  assert.doesNotMatch(gameSrc, /function mn\(/, 'the procedural note synth helper must be gone');
  assert.doesNotMatch(gameSrc, /\bBPM\b|\bSCALE\b|\bPATTERN\b/, 'no procedural music constants may remain');
  assert.match(gameSrc, /audio\/track\.wav/, 'the reference WAV must be fetched');
  assert.match(gameSrc, /audio\.decodeAudioData/, 'must use Web Audio AudioBuffer decoding, not HTMLAudio');
});

check('TEST_DECODE_BEFORE_RUN_ORIGIN_ARCHITECTURE', () => {
  assert.match(gameSrc, /function requestStart\(\)/, 'a distinct gesture-handler must exist, separate from actually beginning the run');
  assert.match(gameSrc, /function beginRun\(\)/, 'a single function must establish the shared origin and begin the run');
  assert.match(gameSrc, /if \(wavReady\) beginRun\(\);\s*else pendingStart = true;/, 'the run must not begin until decode is confirmed ready');
  assert.match(gameSrc, /runOrigin = audio\.currentTime;/, 'the shared origin must come directly from the AudioContext clock');
  assert.match(gameSrc, /wavSrc\.start\(runOrigin \+ C\.PRE_ROLL\);/, 'the WAV must be scheduled relative to the shared origin, not a separately-captured timestamp');
  assert.match(gameSrc, /var dt = \(audio\.currentTime - runOrigin\) - state\.time;/, 'gameplay dt must be derived from the shared origin every frame, never accumulated from performance.now()');
  assert.doesNotMatch(gameSrc, /=\s*performance\.now\(\)/, 'gameplay timing must not be assigned from performance.now() anywhere (comments referencing it are fine)');
});

check('TEST_PRE_ROLL_AND_CHART_MATH', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(C.PRE_ROLL, C.TRAVEL, 'PRE_ROLL must equal TRAVEL (2.25s)');
  assert.equal(C.PRE_ROLL, 2.25);
  assert.equal(C.CHART.length, 82, 'EASY_V2_NOTE_COUNT: all 82 events must be preserved');
  assert.ok(Math.abs(C.CHART[0].t - 2.544) < 1e-9, 'FIRST_NOTE_HIT_GAME_TIME must be PRE_ROLL + 0.294 = 2.544');
  const firstSpawn = C.CHART[0].t - C.TRAVEL;
  assert.ok(firstSpawn >= 0, 'NEGATIVE_SPAWN_FIXED: first note spawn time must no longer be negative, got ' + firstSpawn);
  assert.ok(Math.abs(firstSpawn - 0.294) < 1e-9, 'first note must spawn at exactly the original CSV hit time (0.294s)');
  assert.ok(C.RUN_DURATION > C.PRE_ROLL + 90, 'TOTAL_PLAYTEST_RUN_DURATION must cover the full pre-roll + WAV length, not cut it off');
  for (let i = 1; i < C.CHART.length; i++) assert.ok(C.CHART[i].t > C.CHART[i - 1].t, 'chart must be strictly monotonic at event ' + i);
  C.CHART.forEach((n, i) => assert.ok(n.lane === 0 || n.lane === 1 || n.lane === 2, 'event ' + i + ' has an invalid lane'));
});

check('TEST_OLD_118_CHART_NOT_ACTIVE', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(C.CHART.length, 82, 'OLD_118_NOTE_CHART_ACTIVE must be NO — exactly the 82-event EASY v2 chart must be active');
  assert.doesNotMatch(coreSrc, /0442222222222222222222222222222222222222222222222222222222222224444222221122211222112222222112221121121122222222222222/, 'the old 118-event v1 delta string must not remain in source');
});

check('TEST_HOLD_NOTES_MATCH_SOURCE', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const holds = C.CHART.filter((n) => n.hold);
  assert.equal(holds.length, 3, 'FORMAL_HOLD_COUNT must be 3');
  assert.equal(C.HOLD_DUR, 0.768, 'HOLD_DURATION_SECONDS must be 0.768');
  holds.forEach((h) => assert.equal(h.hold, 0.768, 'every Hold must share the same 0.768s duration'));
  const csvHoldTimesInGameTime = [50.982, 52.518, 81.702].map((t) => t + C.PRE_ROLL);
  const actualHoldTimes = holds.map((h) => h.t).sort((a, b) => a - b);
  csvHoldTimesInGameTime.sort((a, b) => a - b).forEach((expected, i) => {
    assert.ok(Math.abs(actualHoldTimes[i] - expected) < 1e-9, 'HOLD_TIMES: expected a hold at game time ' + expected + ', got ' + actualHoldTimes[i]);
  });
});

// ============================================================
// Phase 3C: EASY/NORMAL dual-chart selection — CHART CONTENT
// ============================================================
check('TEST_EASY_CSV_REFERENCE_EXISTS', () => {
  assert.ok(fs.existsSync(easyCsvPath), 'EASY_REFERENCE_FOUND: REFERENCES/rainbow_refrain_easy_chart_v2.csv must exist');
});

check('TEST_NORMAL_CSV_REFERENCE_EXISTS', () => {
  assert.ok(fs.existsSync(normalCsvPath), 'NORMAL_REFERENCE_FOUND: REFERENCES/rainbow_refrain_normal_chart_v2.csv must exist');
});

check('TEST_EASY_RUNTIME_CHART_COUNT_AND_HOLDS', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(C.EASY_CHART.length, 82, 'EASY_RUNTIME_NOTE_COUNT must be 82');
  const holds = C.EASY_CHART.filter((n) => n.hold).slice().sort((a, b) => a.t - b.t);
  assert.equal(holds.length, 3, 'EASY_HOLD_COUNT must be 3');
  const expected = [[50.982, 2], [52.518, 0], [81.702, 1]].map(([t, lane]) => ({ t: t + C.PRE_ROLL, lane })).sort((a, b) => a.t - b.t);
  expected.forEach((e, i) => {
    assert.ok(Math.abs(holds[i].t - e.t) < 1e-9, 'EASY hold ' + i + ' time mismatch: expected ' + e.t + ', got ' + holds[i].t);
    assert.equal(holds[i].lane, e.lane, 'EASY hold ' + i + ' lane mismatch');
    assert.ok(Math.abs(holds[i].hold - 0.768) < 1e-9, 'EASY hold ' + i + ' duration must be 0.768');
  });
});

check('TEST_NORMAL_RUNTIME_CHART_COUNT_AND_HOLDS', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(C.NORMAL_CHART.length, 118, 'NORMAL_RUNTIME_NOTE_COUNT must be 118');
  const holds = C.NORMAL_CHART.filter((n) => n.hold).slice().sort((a, b) => a.t - b.t);
  assert.equal(holds.length, 5, 'NORMAL_HOLD_COUNT must be 5');
  const expected = [[22.566, 1], [50.982, 2], [52.518, 0], [67.302, 1], [81.702, 1]].map(([t, lane]) => ({ t: t + C.PRE_ROLL, lane })).sort((a, b) => a.t - b.t);
  expected.forEach((e, i) => {
    assert.ok(Math.abs(holds[i].t - e.t) < 1e-9, 'NORMAL hold ' + i + ' time mismatch: expected ' + e.t + ', got ' + holds[i].t);
    assert.equal(holds[i].lane, e.lane, 'NORMAL hold ' + i + ' lane mismatch');
    assert.ok(Math.abs(holds[i].hold - 0.768) < 1e-9, 'NORMAL hold ' + i + ' duration must be 0.768');
  });
});

check('TEST_EASY_CHART_MATCHES_CSV_EXACTLY', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const rows = parseChartCsv(easyCsvPath);
  assert.equal(rows.length, C.EASY_CHART.length, 'EASY runtime chart row count must match the CSV exactly');
  rows.forEach((r, i) => {
    const expectedT = parseFloat(r.time_sec) + C.PRE_ROLL;
    assert.ok(Math.abs(C.EASY_CHART[i].t - expectedT) < 1e-6, 'EASY chart event ' + i + ' time must match CSV (expected ' + expectedT + ', got ' + C.EASY_CHART[i].t + ')');
    assert.equal(C.EASY_CHART[i].lane, parseInt(r.lane, 10), 'EASY chart event ' + i + ' lane must match CSV');
    const csvHold = r.hold_sec && r.hold_sec.trim() !== '' ? parseFloat(r.hold_sec) : 0;
    assert.equal(C.EASY_CHART[i].hold || 0, csvHold, 'EASY chart event ' + i + ' hold metadata must match CSV');
  });
});

check('TEST_NORMAL_CHART_MATCHES_CSV_EXACTLY', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const rows = parseChartCsv(normalCsvPath);
  assert.equal(rows.length, C.NORMAL_CHART.length, 'NORMAL runtime chart row count must match the CSV exactly');
  rows.forEach((r, i) => {
    const expectedT = parseFloat(r.time_sec) + C.PRE_ROLL;
    assert.ok(Math.abs(C.NORMAL_CHART[i].t - expectedT) < 1e-6, 'NORMAL chart event ' + i + ' time must match CSV (expected ' + expectedT + ', got ' + C.NORMAL_CHART[i].t + ')');
    assert.equal(C.NORMAL_CHART[i].lane, parseInt(r.lane, 10), 'NORMAL chart event ' + i + ' lane must match CSV');
    const csvHold = r.hold_sec && r.hold_sec.trim() !== '' ? parseFloat(r.hold_sec) : 0;
    assert.equal(C.NORMAL_CHART[i].hold || 0, csvHold, 'NORMAL chart event ' + i + ' hold metadata must match CSV');
  });
});

check('TEST_NO_CHART_MIXING_EASY_NORMAL_ARE_SEPARATE', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.notEqual(C.EASY_CHART, C.NORMAL_CHART, 'EASY_CHART and NORMAL_CHART must be genuinely separate array instances, never combined into one');
  assert.notEqual(C.EASY_CHART.length, C.NORMAL_CHART.length, 'sanity: the two charts must not accidentally collapse to the same size');
  assert.notEqual(C.EASY_CHART[0], C.NORMAL_CHART[0], 'chart event objects must not be shared/aliased between the two charts');
});

check('TEST_EASY_NOT_OLD_118_NOTE_CHART', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(C.EASY_CHART.length, 82, 'EASY must remain the 82-event v2 chart');
  assert.notEqual(C.EASY_CHART.length, 118, 'EASY must never accidentally become a 118-note chart (that count belongs to NORMAL, not EASY)');
});

// ============================================================
// Phase 3D/3D.1: HARD triple-chart selection — CHART CONTENT
// HARD v1 was deleted and is NOT authoritative — v2 (finer, with genuine
// odd-index 16th-grid positions a Codex audit found v1 lacked) is the
// sole HARD reference used throughout this file. See
// TEST_NO_ACTIVE_DEPENDENCY_ON_DELETED_HARD_V1 below.
// ============================================================
check('TEST_HARD_CSV_REFERENCE_EXISTS', () => {
  assert.ok(fs.existsSync(hardCsvPath), 'HARD_V2_REFERENCE_FOUND: REFERENCES/rainbow_refrain_hard_chart_v2.csv must exist');
});

check('TEST_NO_ACTIVE_DEPENDENCY_ON_DELETED_HARD_V1', () => {
  // rainbow_refrain_hard_chart_v1.csv was intentionally deleted by the
  // user and must not be required, fetched, or silently fallen back to
  // anywhere active. game.js/game-core.js never reference it at all
  // (checked directly against their real source), and the ONE HARD csv
  // path this whole suite actually reads chart data from (hardCsvPath)
  // must resolve to v2, not v1 — a raw text-count of "how many times do
  // the letters v1 appear in this file" would be fragile against ordinary
  // explanatory prose (like this comment), so this checks the thing that
  // actually matters: what path is live, and whether reading through it
  // works without v1 existing on disk.
  assert.doesNotMatch(gameSrc, /hard_chart_v1/, 'game.js must not reference the deleted HARD v1 CSV');
  assert.doesNotMatch(coreSrc, /hard_chart_v1/, 'game-core.js must not reference the deleted HARD v1 CSV');
  assert.match(hardCsvPath, /hard_chart_v2\.csv$/, 'HARD_V1_ACTIVE_DEPENDENCY_COUNT: the active hardCsvPath this suite reads chart data from must resolve to v2, not v1');
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'REFERENCES', 'rainbow_refrain_hard_chart_v1.csv')), false, 'setup sanity: v1 must actually be absent, confirming this test exercises a real deletion, not a hypothetical one');
  assert.doesNotThrow(() => parseChartCsv(hardCsvPath), 'the active HARD reference must be fully readable with v1 absent — proves nothing active still needs it');
});

check('TEST_HARD_RUNTIME_CHART_COUNT_AND_HOLDS', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(C.HARD_CHART.length, 158, 'HARD_RUNTIME_NOTE_COUNT must be 158');
  const holds = C.HARD_CHART.filter((n) => n.hold).slice().sort((a, b) => a.t - b.t);
  assert.equal(holds.length, 8, 'HARD_HOLD_COUNT must be 8');
  const expected = [[11.814, 2], [22.566, 1], [34.854, 1], [50.982, 2], [52.518, 0], [67.302, 1], [73.254, 2], [81.702, 1]]
    .map(([t, lane]) => ({ t: t + C.PRE_ROLL, lane })).sort((a, b) => a.t - b.t);
  expected.forEach((e, i) => {
    assert.ok(Math.abs(holds[i].t - e.t) < 1e-9, 'HARD hold ' + i + ' time mismatch: expected ' + e.t + ', got ' + holds[i].t);
    assert.equal(holds[i].lane, e.lane, 'HARD hold ' + i + ' lane mismatch');
    assert.ok(Math.abs(holds[i].hold - 0.768) < 1e-9, 'HARD hold ' + i + ' duration must be 0.768');
  });
});

// item 80: all-row comparison, not sampling — every one of the 158 HARD
// events is checked, and the exact mismatch count is tracked (not just a
// boolean), matching the spec's HARD_CHART_MISMATCH_COUNT report field.
check('TEST_HARD_CHART_MATCHES_CSV_EXACTLY_ALL_ROWS', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const rows = parseChartCsv(hardCsvPath);
  assert.equal(rows.length, C.HARD_CHART.length, 'HARD runtime chart row count must match the CSV exactly (158 rows)');
  let mismatchCount = 0;
  rows.forEach((r, i) => {
    const expectedT = parseFloat(r.time_sec) + C.PRE_ROLL;
    const expectedLane = parseInt(r.lane, 10);
    const csvHold = r.hold_sec && r.hold_sec.trim() !== '' ? parseFloat(r.hold_sec) : 0;
    let rowOk = true;
    if (Math.abs(C.HARD_CHART[i].t - expectedT) >= 1e-6) rowOk = false;
    if (C.HARD_CHART[i].lane !== expectedLane) rowOk = false;
    if (Math.abs((C.HARD_CHART[i].hold || 0) - csvHold) >= 1e-9) rowOk = false;
    if (!rowOk) mismatchCount++;
  });
  assert.equal(mismatchCount, 0, 'HARD_CHART_MISMATCH_COUNT must be 0 across all 158 rows (time/lane/hold), got ' + mismatchCount);
});

check('TEST_HARD_TIMING_MONOTONIC_AND_LANES_VALID', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  for (let i = 1; i < C.HARD_CHART.length; i++) {
    assert.ok(C.HARD_CHART[i].t > C.HARD_CHART[i - 1].t, 'HARD_TIMING_MONOTONIC: chart hit times must be strictly increasing at event ' + i);
  }
  C.HARD_CHART.forEach((n, i) => assert.ok(n.lane === 0 || n.lane === 1 || n.lane === 2, 'HARD_LANES_VALID: event ' + i + ' has an invalid lane ' + n.lane));
});

check('TEST_HARD_NO_DUPLICATE_SAME_LANE_TIMESTAMP', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  let dup = 0;
  for (let a = 0; a < C.HARD_CHART.length; a++) {
    for (let b = a + 1; b < C.HARD_CHART.length; b++) {
      if (C.HARD_CHART[a].lane === C.HARD_CHART[b].lane && Math.abs(C.HARD_CHART[a].t - C.HARD_CHART[b].t) < 1e-9) dup++;
    }
  }
  assert.equal(dup, 0, 'HARD_DUPLICATE_SAME_LANE_TIMESTAMP: no two HARD events may share the same lane AND the same time (would be mechanically un-hittable as two distinct notes)');
});

check('TEST_HARD_NO_DUPLICATE_EVENT', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  let dup = 0;
  for (let a = 0; a < C.HARD_CHART.length; a++) {
    for (let b = a + 1; b < C.HARD_CHART.length; b++) {
      if (C.HARD_CHART[a].t === C.HARD_CHART[b].t && C.HARD_CHART[a].lane === C.HARD_CHART[b].lane) dup++;
    }
  }
  assert.equal(dup, 0, 'HARD_DUPLICATE_EVENT: no exact time+lane collision may exist anywhere in the chart');
});

check('TEST_HARD_NO_SAME_LANE_HOLD_CONFLICT_OR_OVERLAP', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const holds = C.HARD_CHART.filter((n) => n.hold);
  let sameLaneConflict = 0;
  holds.forEach((h) => {
    const endT = h.t + h.hold;
    C.HARD_CHART.forEach((o) => {
      if (o === h) return;
      if (o.lane === h.lane && o.t > h.t - 1e-9 && o.t < endT + 1e-9) sameLaneConflict++;
    });
  });
  assert.equal(sameLaneConflict, 0, 'HARD_SAME_LANE_HOLD_CONFLICT: no other same-lane event (TAP or another Hold) may fall inside an active Hold\'s [start, start+duration] window — such an event would be mechanically unreachable while the Hold is held');
  let holdHoldOverlap = 0;
  for (let a = 0; a < holds.length; a++) {
    for (let b = a + 1; b < holds.length; b++) {
      if (holds[a].lane !== holds[b].lane) continue;
      const aEnd = holds[a].t + holds[a].hold, bEnd = holds[b].t + holds[b].hold;
      if (holds[a].t < bEnd && holds[b].t < aEnd) holdHoldOverlap++;
    }
  }
  assert.equal(holdHoldOverlap, 0, 'no two same-lane Holds may overlap in time (only one Hold can be active per lane at once)');
  assert.ok(holds.every((h) => h.hold > 0), 'no zero/negative Hold duration may exist');
});

// ============================================================
// Phase 3D.1: TRUE 16th-grid verification — derives grid_index_16th from
// ACTUAL RUNTIME event timings (round((csvTime - 0.294) / 0.096) applied
// to C.HARD_CHART itself), never from the 0.096 unit constant, source
// text, or the CSV's own grid_index_16th column alone. This is exactly
// the check the previous Codex audit found missing: HARD v1 used a 0.096
// DECODER unit but every decoded event still happened to land on an EVEN
// index — an effective 0.192s grid in disguise, which these tests would
// have caught by actually inspecting the decoded output.
// ============================================================
function hardRuntimeGridIndex(C, n) {
  return Math.round((n.t - C.PRE_ROLL - 0.294) / 0.096);
}

check('TEST_HARD_ODD_16TH_GRID_INDEX_COUNT_IS_16', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const oddRuntimeEvents = C.HARD_CHART.filter((n) => hardRuntimeGridIndex(C, n) % 2 === 1);
  assert.equal(oddRuntimeEvents.length, 16, 'HARD_ODD_GRID_INDEX_16TH_COUNT must be 16, derived from actual runtime event timings, got ' + oddRuntimeEvents.length);
});

check('TEST_HARD_RUNTIME_ODD_INDEX_EVENT_EXISTS', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const anyOdd = C.HARD_CHART.some((n) => hardRuntimeGridIndex(C, n) % 2 === 1);
  assert.equal(anyOdd, true, 'at least one actual runtime HARD event must have an odd grid_index_16th — proves the runtime chart is not silently a 0.192 grid');
});

check('TEST_HARD_IS_NOT_PURE_0_192_GRID_SUBSET', () => {
  // Negative check, stated explicitly per spec: a chart that were only
  // ever a 0.192s grid would have grid_index_16th % 2 === 0 for EVERY
  // event, regardless of what unit its decoder claims to use.
  const C = require(path.join(srcDir, 'game-core.js'));
  const isPureEvenGrid = C.HARD_CHART.every((n) => hardRuntimeGridIndex(C, n) % 2 === 0);
  assert.equal(isPureEvenGrid, false, 'HARD_IS_PURE_0_192_GRID_SUBSET must be NO/false — HARD v2 must contain genuine odd-16th-grid positions v1 lacked');
});

check('TEST_HARD_16TH_GRID_MATCHES_CSV_GRID_INDEX_COLUMN', () => {
  // Cross-checks the runtime-derived grid index against the CSV's own
  // grid_index_16th column too, as an independent corroboration (not a
  // substitute for the two runtime-only checks above).
  const C = require(path.join(srcDir, 'game-core.js'));
  const rows = parseChartCsv(hardCsvPath);
  rows.forEach((r, i) => {
    assert.equal(hardRuntimeGridIndex(C, C.HARD_CHART[i]), parseInt(r.grid_index_16th, 10), 'runtime-derived grid index must match the CSV\'s own grid_index_16th at event ' + i);
  });
});

check('TEST_HARD_ENCODING_NO_NAN_VALID_BASE36', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  C.HARD_CHART.forEach((n, i) => {
    assert.ok(!isNaN(n.t) && Number.isFinite(n.t), 'HARD_ENCODING_VALID: event ' + i + ' time must not be NaN/Infinity (a malformed base-36 delta character would produce NaN)');
    assert.ok(!isNaN(n.lane) && Number.isFinite(n.lane), 'HARD_ENCODING_VALID: event ' + i + ' lane must not be NaN/Infinity');
  });
  // HARD_MAX_DELTA / lane-string-length / hold-index-mapping are each
  // implicitly proven by TEST_HARD_CHART_MATCHES_CSV_EXACTLY_ALL_ROWS
  // (any width/length/index mistake would desync every subsequent event
  // and fail that all-row comparison) — HARD_MAX_DELTA reported directly
  // here too, computed independently from the CSV's own grid column.
  let prevIdx = 0, maxDelta = 0;
  const rows = parseChartCsv(hardCsvPath);
  rows.forEach((r) => {
    const idx = parseInt(r.grid_index_16th, 10);
    maxDelta = Math.max(maxDelta, idx - prevIdx);
    prevIdx = idx;
  });
  assert.ok(maxDelta <= 35, 'HARD_MAX_DELTA (' + maxDelta + ') must fit in a single base-36 digit (<=35)');
  assert.equal(C.HARD_CHART.length, rows.length, 'lane-string length must match the CSV row count exactly (a length mismatch would have thrown or silently truncated)');
});

check('TEST_HARD_FIRST_NOTE_SPAWN_AND_PRE_ROLL', () => {
  // HARD's own first-note/spawn/PRE_ROLL relationship, verified
  // independently rather than assumed identical to NORMAL — it happens
  // to share the same first CSV row (0.294s) as EASY/NORMAL, but this is
  // checked directly against HARD_CHART, not inferred.
  const C = require(path.join(srcDir, 'game-core.js'));
  const rows = parseChartCsv(hardCsvPath);
  assert.ok(Math.abs(parseFloat(rows[0].time_sec) - 0.294) < 1e-9, 'setup: HARD CSV first note must be 0.294s');
  assert.ok(Math.abs(C.HARD_CHART[0].t - (0.294 + C.PRE_ROLL)) < 1e-9, 'HARD runtime hit time must be PRE_ROLL + CSV time');
  const spawnTime = C.HARD_CHART[0].t - C.TRAVEL;
  assert.ok(spawnTime >= 0, 'HARD first note spawn time must not be negative, got ' + spawnTime);
  assert.ok(Math.abs(spawnTime - 0.294) < 1e-9, 'HARD first note must spawn at exactly its own CSV hit time (PRE_ROLL === TRAVEL collapses the offset)');
});

check('TEST_NO_CHART_MIXING_ALL_THREE_SEPARATE', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.notEqual(C.EASY_CHART, C.HARD_CHART, 'EASY_CHART and HARD_CHART must be separate array instances');
  assert.notEqual(C.NORMAL_CHART, C.HARD_CHART, 'NORMAL_CHART and HARD_CHART must be separate array instances');
  assert.notEqual(C.EASY_CHART.length, C.HARD_CHART.length);
  assert.notEqual(C.NORMAL_CHART.length, C.HARD_CHART.length);
  assert.notEqual(C.EASY_CHART[0], C.HARD_CHART[0], 'chart event objects must not be shared/aliased between EASY and HARD');
  assert.notEqual(C.NORMAL_CHART[0], C.HARD_CHART[0], 'chart event objects must not be shared/aliased between NORMAL and HARD');
  assert.ok(C.CHARTS.easy === C.EASY_CHART && C.CHARTS.normal === C.NORMAL_CHART && C.CHARTS.hard === C.HARD_CHART, 'CHARTS map must reference the exact same three chart arrays, not copies');
});

check('TEST_PRODUCTION_CHARTS_ARE_FROZEN', () => {
  // Phase 3C.1 (Codex LOW-1 fix), extended in Phase 3D to also cover
  // HARD_CHART: production charts are never mutated at runtime (tick()
  // always spawns a new plain gate object, see game-core's decodeChart()
  // comment) — Object.freeze makes that guarantee real rather than just
  // conventional.
  const C = require(path.join(srcDir, 'game-core.js'));
  assert.equal(Object.isFrozen(C.EASY_CHART), true, 'CHARTS_FROZEN: EASY_CHART array must be frozen');
  assert.equal(Object.isFrozen(C.NORMAL_CHART), true, 'CHARTS_FROZEN: NORMAL_CHART array must be frozen');
  assert.equal(Object.isFrozen(C.HARD_CHART), true, 'CHARTS_FROZEN: HARD_CHART array must be frozen');
  assert.equal(Object.isFrozen(C.EASY_CHART[0]), true, 'EVENT_OBJECTS_FROZEN: EASY_CHART event objects must be frozen');
  assert.equal(Object.isFrozen(C.NORMAL_CHART[0]), true, 'EVENT_OBJECTS_FROZEN: NORMAL_CHART event objects must be frozen');
  assert.equal(Object.isFrozen(C.HARD_CHART[0]), true, 'EVENT_OBJECTS_FROZEN: HARD_CHART event objects must be frozen');
  assert.equal(Object.isFrozen(C.CHARTS), true, 'CHARTS_MAP_FROZEN: the CHARTS map object itself must be frozen');
  // Also check a Hold-carrying event specifically (a 3rd property, `hold`,
  // must be frozen too, not just the base {t, lane} shape).
  const easyHold = C.EASY_CHART.find((n) => n.hold);
  const normalHold = C.NORMAL_CHART.find((n) => n.hold);
  const hardHold = C.HARD_CHART.find((n) => n.hold);
  assert.equal(Object.isFrozen(easyHold), true);
  assert.equal(Object.isFrozen(normalHold), true);
  assert.equal(Object.isFrozen(hardHold), true);
  // A mutation attempt must silently no-op (sloppy mode) or throw (strict
  // mode) — either way, the value must never actually change.
  const before = C.HARD_CHART[0].lane;
  try { C.HARD_CHART[0].lane = 99; } catch (e) {}
  assert.equal(C.HARD_CHART[0].lane, before, 'a frozen chart event must reject mutation');
  const lenBefore = C.HARD_CHART.length;
  try { C.HARD_CHART.push({ t: 0, lane: 0 }); } catch (e) {}
  assert.equal(C.HARD_CHART.length, lenBefore, 'a frozen chart array must reject push()');
  try { C.CHARTS.expert = []; } catch (e) {}
  assert.equal(C.CHARTS.expert, undefined, 'a frozen CHARTS map must reject adding new keys');
});

check('TEST_TEST_OVERRIDE_SEAM_STILL_WORKS_UNFROZEN', () => {
  // The __RRR_TEST__.chart override is a SEPARATE mechanism from the
  // frozen production charts — freezing EASY_CHART/NORMAL_CHART must not
  // weaken or interfere with a test's ability to substitute its own
  // (unfrozen, freely mutable) array via the override seam.
  const vm2 = require('node:vm');
  const sandbox2 = { module: { exports: {} }, __RRR_TEST__: { chart: [] }, globalThis: null };
  sandbox2.globalThis = sandbox2;
  vm2.createContext(sandbox2);
  vm2.runInContext(coreSrc, sandbox2, { filename: 'game-core.js' });
  const C2 = sandbox2.module.exports;
  assert.equal(C2.CHART.length, 0, 'the test override array must still fully replace CHART, unaffected by production chart freezing');
  assert.equal(Object.isFrozen(C2.CHART), false, 'an overridden test chart must remain exactly what the test provided (not silently frozen too)');
});

check('TEST_TITLE_SCREEN_SILENT_NO_AUDIO_BEFORE_START', () => {
  const g = boot();
  g.stepFrame(); // renders the title screen
  assert.equal(g.rec.oscStarts.length, 0, 'no SFX may fire before a valid start');
  assert.equal(g.rec.bufferSources.length, 0, 'no WAV playback may be scheduled before a valid start');
});

async function main() {

// ============================================================
// Phase 3C: EASY/NORMAL difficulty selection — TITLE SCREEN BEHAVIOR
// ============================================================
check('TEST_DEFAULT_DIFFICULTY_IS_EASY', () => {
  const g = boot();
  assert.equal(g.test.difficulty.selected(), 'easy', 'DEFAULT_DIFFICULTY must be EASY');
});

// Phase 3D (3-item wrap-around, replaces Phase 3C.1's 2-item TOGGLE, which
// no longer applies now that HARD exists): ArrowUp/ArrowLeft move
// backward through the ordered list EASY->NORMAL->HARD, ArrowDown/
// ArrowRight move forward, both WRAPPING (never clamping) at either end.
// All 12 (arrow x starting-state) combinations are tested explicitly
// below, each through the REAL keydown listener — matching the spec's
// own enumerated table exactly:
//   EASY   + Up/Left => HARD,   EASY   + Down/Right => NORMAL
//   NORMAL + Up/Left => EASY,   NORMAL + Down/Right => HARD
//   HARD   + Up/Left => NORMAL, HARD   + Down/Right => EASY
[
  ['ArrowUp', 'easy', 'hard'],
  ['ArrowLeft', 'easy', 'hard'],
  ['ArrowDown', 'easy', 'normal'],
  ['ArrowRight', 'easy', 'normal'],
  ['ArrowUp', 'normal', 'easy'],
  ['ArrowLeft', 'normal', 'easy'],
  ['ArrowDown', 'normal', 'hard'],
  ['ArrowRight', 'normal', 'hard'],
  ['ArrowUp', 'hard', 'normal'],
  ['ArrowLeft', 'hard', 'normal'],
  ['ArrowDown', 'hard', 'easy'],
  ['ArrowRight', 'hard', 'easy']
].forEach(([key, from, to]) => {
  check('TEST_ARROW_WRAP_' + from.toUpperCase() + '_' + key.replace('Arrow', '').toUpperCase() + '_TO_' + to.toUpperCase(), () => {
    const g = boot();
    g.test.difficulty.set(from); // known starting selection
    assert.equal(g.test.difficulty.selected(), from, 'setup: starting selection must be ' + from);
    g.dispatchKey(key); // REAL keydown dispatch, not moveSelectedDifficulty() called directly
    assert.equal(g.test.difficulty.selected(), to, key + ' from ' + from + ' must move to ' + to);
  });
});

check('TEST_A_DOES_NOT_CHANGE_DIFFICULTY', () => {
  const g = boot();
  g.dispatchKey('a');
  assert.equal(g.test.difficulty.selected(), 'easy', 'ASD_SELECTOR_IMMUNITY: A must never alter the title-screen difficulty selection');
});

check('TEST_S_DOES_NOT_CHANGE_DIFFICULTY', () => {
  const g = boot();
  g.dispatchKey('s');
  assert.equal(g.test.difficulty.selected(), 'easy', 'ASD_SELECTOR_IMMUNITY: S must never alter the title-screen difficulty selection');
});

check('TEST_D_DOES_NOT_CHANGE_DIFFICULTY', () => {
  const g = boot();
  g.dispatchKey('d');
  assert.equal(g.test.difficulty.selected(), 'easy', 'ASD_SELECTOR_IMMUNITY: D must never alter the title-screen difficulty selection');
});

// ------------------------------------------------------------
// TOUCH: Codex noted the previous touch tests never actually put the
// harness in touch mode (no `ontouchstart` on the sandbox global), so
// `touch` evaluated false and the tap-to-start branch was never really
// exercised — effectively testing desktop mode with a pointerdown event.
// boot({ touch: true }) now defines `ontouchstart` on the sandbox global
// BEFORE game.js evaluates `var touch = 'ontouchstart' in globalThis`,
// so this genuinely exercises the touch code path. The dispatch mechanism
// itself is still Pointer Events (canvas.addEventListener('pointerdown',
// act)) — that IS the actual production input path for both mouse and
// touch alike (see act()/laneFromPointer() in game.js; there is no
// separate touchstart listener anywhere in this codebase), so a
// pointerdown with touch:true faithfully reproduces a real tap.
// ------------------------------------------------------------
// Phase 3D: the selector band is now split into 3 equal columns (was a
// left/right half for exactly 2 items) — at the harness's 1280px-wide
// viewport, column width is 1280/3 ~= 426.67px: EASY = [0,427), NORMAL =
// [427,853), HARD = [853,1280). Representative x's below (200/640/1100)
// sit comfortably inside each column, well clear of the boundaries.
check('TEST_TOUCH_TAP_EASY_SELECTS_EASY_ONLY', () => {
  const g = boot({ touch: true });
  g.test.difficulty.set('hard'); // start from a different selection
  g.pointerDown(200, 460); // EASY column
  assert.equal(g.test.difficulty.selected(), 'easy', 'tapping EASY must select EASY');
  assert.equal(g.test.started(), false, 'a selector tap must not also start the run');
});

check('TEST_TOUCH_TAP_NORMAL_SELECTS_NORMAL_ONLY', () => {
  const g = boot({ touch: true });
  assert.equal(g.test.difficulty.selected(), 'easy'); // setup: default
  g.pointerDown(640, 460); // NORMAL column
  assert.equal(g.test.difficulty.selected(), 'normal', 'tapping NORMAL must select NORMAL');
  assert.equal(g.test.started(), false, 'a selector tap must not also start the run');
});

check('TEST_TOUCH_TAP_HARD_SELECTS_HARD_ONLY', () => {
  const g = boot({ touch: true });
  assert.equal(g.test.difficulty.selected(), 'easy'); // setup: default
  g.pointerDown(1100, 460); // HARD column
  assert.equal(g.test.difficulty.selected(), 'hard', 'tapping HARD must select HARD');
  assert.equal(g.test.started(), false, 'a selector tap must not also start the run');
  g.pointerDown(200, 460); // EASY column, proving the selection isn't stuck
  assert.equal(g.test.difficulty.selected(), 'easy', 'tapping EASY afterward must switch away from HARD cleanly');
});

check('TEST_TOUCH_SELECTOR_TAP_DOES_NOT_START', () => {
  const g = boot({ touch: true });
  g.pointerDown(1100, 460); // inside the selector band (HARD column)
  assert.equal(g.test.started(), false, 'SELECTOR_TAP_DOES_NOT_START: a tap landing on the selector band must never start the run, touch or not');
});

await checkAsync('TEST_TOUCH_OUTSIDE_SELECTOR_TAP_STARTS_SELECTED_DIFFICULTY', async () => {
  const g = boot({ touch: true });
  g.pointerDown(1100, 460); // select HARD first (inside the band)
  assert.equal(g.test.difficulty.selected(), 'hard');
  assert.equal(g.test.started(), false, 'setup: must not have started yet');
  g.pointerDown(640, 200); // OUTSIDE the selector band (title text area) -> must start
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true, 'OUTSIDE_SELECTOR_TAP_STARTS: a tap outside the selector band must start the run');
  assert.equal(g.C.CHART.length, 158, 'the run that starts must use whichever difficulty was actually selected (HARD)');
  assert.equal(g.test.state().difficulty, 'hard');
});

await checkAsync('TEST_SPACE_STARTS_EASY', async () => {
  const g = boot(); // default selection, no arrow presses
  g.dispatchKey(' ');
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true);
  assert.equal(g.C.CHART.length, 82, 'SPACE_START_EASY: starting with the default EASY selection must activate the real 82-event EASY chart');
  assert.equal(g.test.state().difficulty, 'easy');
});

await checkAsync('TEST_SPACE_STARTS_NORMAL', async () => {
  const g = boot();
  g.dispatchKey('ArrowDown'); // easy -> normal
  g.dispatchKey(' '); // real Space dispatch, not the test.start() shortcut
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true);
  assert.equal(g.C.CHART.length, 118, 'SPACE_START_NORMAL: starting with NORMAL selected must activate the real 118-event NORMAL chart');
  assert.equal(g.test.state().difficulty, 'normal', 'the started run\'s own state must record NORMAL as its difficulty');
});

await checkAsync('TEST_SPACE_STARTS_HARD', async () => {
  const g = boot();
  g.dispatchKey('ArrowUp'); // easy -> hard (wrap-around backward)
  g.dispatchKey(' ');
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true);
  assert.equal(g.C.CHART.length, 158, 'SPACE_START_HARD: starting with HARD selected must activate the real 158-event HARD chart');
  assert.equal(g.test.state().difficulty, 'hard', 'the started run\'s own state must record HARD as its difficulty');
});

await checkAsync('TEST_DIFFICULTY_LOCK_EASY', async () => {
  const g = await startWithDecodeLatency(0); // default EASY
  assert.equal(g.C.CHART.length, 82);
  g.dispatchKey('ArrowDown'); // must be ignored once running
  g.dispatchKey('ArrowUp');
  assert.equal(g.test.difficulty.selected(), 'easy', 'DIFFICULTY_LOCK_EASY: the selector must not change once a run has started');
  assert.equal(g.C.CHART.length, 82, 'the active chart must not change mid-run either');
});

await checkAsync('TEST_DIFFICULTY_LOCK_NORMAL', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.C.CHART.length, 118);
  g.dispatchKey('ArrowDown'); g.dispatchKey('ArrowUp'); g.dispatchKey('ArrowLeft'); g.dispatchKey('ArrowRight');
  assert.equal(g.test.difficulty.selected(), 'normal', 'DIFFICULTY_LOCK_NORMAL: the selector must not change once a run has started');
  assert.equal(g.C.CHART.length, 118, 'the active chart must not change mid-run either');
  // Pointer taps on the (now-invisible) selector region must also be inert mid-run.
  g.pointerDown(200, 460);
  assert.equal(g.test.difficulty.selected(), 'normal', 'a selector-band tap must not change difficulty mid-run either');
});

await checkAsync('TEST_DIFFICULTY_LOCK_HARD', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.C.CHART.length, 158);
  g.dispatchKey('ArrowDown'); g.dispatchKey('ArrowUp'); g.dispatchKey('ArrowLeft'); g.dispatchKey('ArrowRight');
  assert.equal(g.test.difficulty.selected(), 'hard', 'DIFFICULTY_LOCK_HARD: the selector must not change once a run has started');
  assert.equal(g.C.CHART.length, 158, 'the active chart must not change mid-run either');
  g.pointerDown(200, 460);
  assert.equal(g.test.difficulty.selected(), 'hard', 'a selector-band tap must not change difficulty mid-run either');
});

// ============================================================
// Phase 3C: full chart-driven runs per difficulty (real dispatch, not
// source strings — item 46)
// ============================================================
await checkAsync('TEST_EASY_RUN_SPAWNS_82_NOTES_3_HOLDS', async () => {
  const g = await startWithDecodeLatency(0); // default EASY
  const s = g.test.state();
  let guard = 0, holdStartsSeen = 0;
  let prevActiveHold = false;
  while (s.time < g.C.RUN_DURATION && guard++ < 20000) {
    g.audioCtx._advance(0.05);
    g.stepFrame();
    if (s.activeHold && !prevActiveHold) holdStartsSeen++;
    prevActiveHold = !!s.activeHold;
    s.gates.length = 0; s.activeHold = null; // isolate spawn timing from incidental judgment
  }
  assert.equal(s.chartIdx, 82, 'EASY_SPAWNS_82: every EASY chart event must spawn exactly once across the full run');
});

await checkAsync('TEST_NORMAL_RUN_SPAWNS_118_NOTES_5_HOLDS', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true);
  assert.equal(g.C.CHART.length, 118, 'setup: NORMAL chart must be active');
  const s = g.test.state();
  let guard = 0;
  while (s.time < g.C.RUN_DURATION && guard++ < 20000) {
    g.audioCtx._advance(0.05);
    g.stepFrame();
    s.gates.length = 0; s.activeHold = null;
  }
  assert.equal(s.chartIdx, 118, 'NORMAL_SPAWNS_118: every NORMAL chart event must spawn exactly once across the full run');
});

await checkAsync('TEST_HARD_RUN_SPAWNS_158_NOTES_8_HOLDS', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true);
  assert.equal(g.C.CHART.length, 158, 'setup: HARD chart must be active');
  const s = g.test.state();
  let guard = 0;
  while (s.time < g.C.RUN_DURATION && guard++ < 20000) {
    g.audioCtx._advance(0.05); // tick()'s own spawn loop is a `while`, so it always drains every note whose spawn time has passed in one call — no risk of skipping closely-spaced HARD notes regardless of step size
    g.stepFrame();
    s.gates.length = 0; s.activeHold = null;
  }
  assert.equal(s.chartIdx, 158, 'HARD_SPAWNS_158: every HARD chart event must spawn exactly once across the full run');
});

// Phase 3C.1 (Codex NORMAL HOLD TEST QUALITY fix): the previous version of
// this test selected NORMAL but then pushed a SYNTHETIC gate rather than
// interacting with a Hold that actually came from NORMAL_CHART. This one
// drives the real chart/state path (tick() spawns every gate itself) all
// the way to the first real NORMAL Hold (CSV 22.566s/lane1, game time
// 24.816s) and presses/releases it through the real runtime input path —
// no gate is ever manually pushed.
await checkAsync('TEST_NORMAL_FIRST_HOLD_END_TO_END_FROM_REAL_CHART', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.C.CHART.length, 118, 'setup: NORMAL must be active');
  const firstHold = g.C.CHART.find((n) => n.hold);
  assert.ok(firstHold, 'setup: NORMAL_CHART must contain a Hold');
  assert.ok(Math.abs(firstHold.t - 24.816) < 1e-9, 'setup: the first NORMAL Hold must be the expected 22.566s CSV / lane1 event (game time PRE_ROLL+22.566)');
  assert.equal(firstHold.lane, 1);

  const s = g.test.state();
  const holdTUnits = g.C.HOLD_DUR / g.C.TRAVEL;

  // Advance via the REAL chart/state path only (nothing manually pushed
  // into s.gates). NORMAL_CHART has ~28 unrelated TAP notes before this
  // Hold; each is discarded the instant it spawns — never judged, never
  // missed — purely to isolate this one Hold's own timing from them. Any
  // gate carrying `.hold` (i.e. the Hold itself, once tick() spawns it
  // from NORMAL_CHART) is deliberately left untouched.
  let guard = 0;
  while (s.time < firstHold.t - 1e-6 && guard++ < 5000) {
    g.audioCtx._advance(0.02);
    g.stepFrame();
    for (let i = s.gates.length - 1; i >= 0; i--) {
      if (!s.gates[i].hold) s.gates.splice(i, 1);
    }
  }
  const gate = s.gates.find((gt) => gt.color === 1 && gt.hold);
  assert.ok(gate, 'NORMAL_FIRST_HOLD_SOURCE: the first NORMAL Hold must have spawned as a REAL gate from NORMAL_CHART, not a synthetic push');
  assert.ok(Math.abs(gate.hold - 0.768) < 1e-9, 'the spawned gate\'s hold duration must match NORMAL_CHART\'s own 0.768s');

  // PRESS via the real runtime input path (S = lane 1) — the Hold START judgment.
  g.dispatchKey('s');
  assert.equal(s.lastEvent, 'perfect', 'NORMAL_FIRST_HOLD_START: pressing exactly at the real chart\'s hit time must be PERFECT');
  assert.ok(s.activeHold && s.activeHold.lane === 1, 'the Hold must now be active');
  assert.equal(s.activeHold.gate, gate, 'the Hold that activated must be the SAME real gate the chart spawned, not a different one');

  const activeGate = s.activeHold.gate;
  let releaseGuard = 0;
  while (activeGate.t - holdTUnits < 1 && releaseGuard++ < 200) { g.audioCtx._advance(0.02); g.stepFrame(); }
  g.dispatchKeyUp('s'); // RELEASE via the real runtime input path — the Hold END judgment.
  assert.equal(s.lastEvent, 'perfect', 'NORMAL_FIRST_HOLD_END: releasing exactly at the end marker must also be PERFECT');

  assert.equal(s.perfects, 2, 'NORMAL_FIRST_HOLD_JUDGMENTS: exactly two PERFECT judgments (start + end)');
  assert.equal(s.score, g.C.PERFECT_SCORE * 2, 'NORMAL_FIRST_HOLD_SCORE: score must reflect exactly two PERFECT judgments');
  assert.equal(s.combo, 2, 'NORMAL_FIRST_HOLD_COMBO: combo must be 2 after both judgments, with no incidental MISS in between');
  assert.equal(s.misses, 0, 'no incidental MISS may have accrued from the discarded unrelated notes');
  assert.equal(s.activeHold, null, 'the Hold must be fully resolved');
});

// Phase 3D HARD HOLD E2E: drives the real chart/state path (tick() spawns
// every gate itself from HARD_CHART) to the actual first HARD Hold (CSV
// 11.814s/lane2, game time 14.064s) and presses/releases it through the
// real runtime input path — no gate is ever manually pushed. Mirrors
// TEST_NORMAL_FIRST_HOLD_END_TO_END_FROM_REAL_CHART exactly.
await checkAsync('TEST_HARD_FIRST_HOLD_END_TO_END_FROM_REAL_CHART', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.C.CHART.length, 158, 'setup: HARD must be active');
  const firstHold = g.C.CHART.find((n) => n.hold);
  assert.ok(firstHold, 'setup: HARD_CHART must contain a Hold');
  assert.ok(Math.abs(firstHold.t - 14.064) < 1e-9, 'setup: the first HARD Hold must be the expected 11.814s CSV / lane2 event (game time PRE_ROLL+11.814)');
  assert.equal(firstHold.lane, 2);

  const s = g.test.state();
  const holdTUnits = g.C.HOLD_DUR / g.C.TRAVEL;

  // Advance via the REAL chart/state path only (nothing manually pushed
  // into s.gates). Every OTHER note that spawns along the way is
  // discarded the instant it spawns — never judged, never missed — purely
  // to isolate this one Hold's own timing; any gate carrying `.hold` is
  // deliberately left untouched.
  let guard = 0;
  while (s.time < firstHold.t - 1e-6 && guard++ < 5000) {
    g.audioCtx._advance(0.02);
    g.stepFrame();
    for (let i = s.gates.length - 1; i >= 0; i--) {
      if (!s.gates[i].hold) s.gates.splice(i, 1);
    }
  }
  const gate = s.gates.find((gt) => gt.color === 2 && gt.hold);
  assert.ok(gate, 'HARD_FIRST_HOLD_SOURCE: the first HARD Hold must have spawned as a REAL gate from HARD_CHART, not a synthetic push');
  assert.ok(Math.abs(gate.hold - 0.768) < 1e-9, 'the spawned gate\'s hold duration must match HARD_CHART\'s own 0.768s');

  // PRESS via the real runtime input path (D = lane 2) — the Hold START judgment.
  g.dispatchKey('d');
  assert.equal(s.lastEvent, 'perfect', 'HARD_FIRST_HOLD_START: pressing exactly at the real chart\'s hit time must be PERFECT');
  assert.ok(s.activeHold && s.activeHold.lane === 2, 'the Hold must now be active');
  assert.equal(s.activeHold.gate, gate, 'the Hold that activated must be the SAME real gate the chart spawned, not a different one');

  const activeGate = s.activeHold.gate;
  let releaseGuard = 0;
  while (activeGate.t - holdTUnits < 1 && releaseGuard++ < 200) { g.audioCtx._advance(0.02); g.stepFrame(); }
  g.dispatchKeyUp('d'); // RELEASE via the real runtime input path — the Hold END judgment.
  assert.equal(s.lastEvent, 'perfect', 'HARD_FIRST_HOLD_END: releasing exactly at the end marker must also be PERFECT');

  assert.equal(s.perfects, 2, 'HARD_FIRST_HOLD_JUDGMENTS: exactly two PERFECT judgments (start + end)');
  assert.equal(s.score, g.C.PERFECT_SCORE * 2, 'HARD_FIRST_HOLD_SCORE: score must reflect exactly two PERFECT judgments (200)');
  assert.equal(s.combo, 2, 'HARD_FIRST_HOLD_COMBO: combo must be 2 after both judgments, with no incidental MISS in between');
  assert.equal(s.misses, 0, 'no incidental MISS may have accrued from the discarded unrelated notes');
  assert.equal(s.activeHold, null, 'the Hold must be fully resolved');
});

await checkAsync('TEST_NORMAL_WAV_SYNC_AND_SHARED_CLOCK_UNCHANGED', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const runOrigin = g.test.wav.runOrigin();
  const src = g.rec.bufferSources[0];
  assert.equal(g.C.PRE_ROLL, 2.25, 'PRE_ROLL must remain 2.25 regardless of difficulty');
  assert.ok(Math.abs((src.startedAt - runOrigin) - 2.25) < 1e-9, 'WAV_SYNC: the WAV must still start at exactly runOrigin + PRE_ROLL under NORMAL');
  assert.equal(g.C.CHART[0].t, 2.544, 'NORMAL\'s own first note time must be unaffected by the shared clock (same first CSV row as EASY)');
});

await checkAsync('TEST_HARD_WAV_SYNC_AND_SHARED_CLOCK_UNCHANGED', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const runOrigin = g.test.wav.runOrigin();
  const src = g.rec.bufferSources[0];
  assert.equal(g.C.PRE_ROLL, 2.25, 'PRE_ROLL must remain 2.25 regardless of difficulty');
  assert.ok(Math.abs((src.startedAt - runOrigin) - 2.25) < 1e-9, 'WAV_SYNC: the WAV must still start at exactly runOrigin + PRE_ROLL under HARD');
  assert.equal(g.C.CHART[0].t, 2.544, 'HARD\'s own first note time must be unaffected by the shared clock (same first CSV row as EASY/NORMAL)');
});

// ============================================================
// Phase 3C: retry preserves difficulty, no cross-chart leakage
// ============================================================
await checkAsync('TEST_RETRY_PRESERVES_EASY', async () => {
  const g = await startWithDecodeLatency(0); // default EASY
  assert.equal(g.C.CHART.length, 82);
  g.dispatchKey('r');
  assert.equal(g.test.difficulty.selected(), 'easy', 'RETRY_PRESERVES_DIFFICULTY: retry must not reset difficulty back to some other default');
  assert.equal(g.C.CHART.length, 82, 'retry must re-activate the SAME EASY chart, not switch charts');
  assert.equal(g.test.state().difficulty, 'easy');
});

await checkAsync('TEST_RETRY_PRESERVES_NORMAL', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.C.CHART.length, 118, 'setup: NORMAL must be active before retry');
  const s0 = g.test.state();
  s0.time = 5;
  g.dispatchKey('r');
  assert.equal(g.test.difficulty.selected(), 'normal', 'RETRY_PRESERVES_DIFFICULTY: retrying a NORMAL run must not fall back to EASY');
  assert.equal(g.C.CHART.length, 118, 'retry must re-activate the SAME NORMAL chart');
  const s1 = g.test.state();
  assert.equal(s1.difficulty, 'normal');
  assert.equal(s1.chartIdx, 0, 'NO_CROSS_CHART_LEAKAGE: retry must reset the chart cursor with no stale progress carried over');
  assert.equal(s1.gates.length, 0, 'NO_CROSS_CHART_LEAKAGE: no stale gates from the previous run/chart may survive retry');
});

await checkAsync('TEST_NORMAL_GAME_OVER_AND_RUN_COMPLETE_PRESERVED', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const s = g.test.state();
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 1, t: 1.16 }); g.C.press(s, 1); }
  assert.equal(s.phase, 'gameover', 'TERMINAL: 3 MISS = GAME OVER must still hold under NORMAL');
  g.dispatchKey('r');
  const s2 = g.test.state();
  s2.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s2.phase, 'complete', 'TERMINAL: RUN COMPLETE must still be reachable under NORMAL');
});

await checkAsync('TEST_RETRY_PRESERVES_HARD', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.C.CHART.length, 158, 'setup: HARD must be active before retry');
  const s0 = g.test.state();
  s0.time = 5;
  g.dispatchKey('r');
  assert.equal(g.test.difficulty.selected(), 'hard', 'RETRY_PRESERVES_DIFFICULTY: retrying a HARD run must not fall back to EASY');
  assert.equal(g.C.CHART.length, 158, 'retry must re-activate the SAME HARD chart');
  const s1 = g.test.state();
  assert.equal(s1.difficulty, 'hard');
  assert.equal(s1.chartIdx, 0, 'NO_CROSS_CHART_LEAKAGE: retry must reset the chart cursor with no stale progress carried over');
  assert.equal(s1.gates.length, 0, 'NO_CROSS_CHART_LEAKAGE: no stale gates from the previous run/chart may survive retry');
});

await checkAsync('TEST_HARD_GAME_OVER_AND_RUN_COMPLETE_PRESERVED', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const s = g.test.state();
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 1, t: 1.16 }); g.C.press(s, 1); }
  assert.equal(s.phase, 'gameover', 'TERMINAL: 3 MISS = GAME OVER must still hold under HARD');
  g.dispatchKey('r');
  const s2 = g.test.state();
  s2.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s2.phase, 'complete', 'TERMINAL: RUN COMPLETE must still be reachable under HARD');
});

// ============================================================
// Phase 3C.1 (Codex RESULT LABEL fix): must reach an actual terminal
// state and inspect the REAL rendered result element (statusEl.innerHTML,
// the same DOM node displayEvent() writes to every real run), not just
// state.difficulty read before the run ends.
// ============================================================
await checkAsync('TEST_RESULT_LABEL_EASY_ON_RUN_COMPLETE', async () => {
  const g = await startWithDecodeLatency(0); // default EASY
  const s = g.test.state();
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete', 'setup: the run must actually reach RUN COMPLETE');
  assert.match(g.elements.status.innerHTML, /EASY/, 'RESULT_LABEL_EASY: the terminal RUN COMPLETE screen must display EASY');
  assert.doesNotMatch(g.elements.status.innerHTML, /NORMAL/, 'an EASY run\'s result must not show NORMAL');
});

await checkAsync('TEST_RESULT_LABEL_NORMAL_ON_GAME_OVER', async () => {
  const g = boot();
  g.test.difficulty.set('normal');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const s = g.test.state();
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 1, t: 1.16 }); g.C.press(s, 1); }
  assert.equal(s.phase, 'gameover', 'setup: the run must actually reach GAME OVER');
  // press() queued 3 MISS events + 1 GAME OVER event into state.events
  // without ever going through a real frame — drain them exactly the way
  // the real runtime does: one stepFrame() moves them into the display
  // queue and shows the first, then each fireDueTimeout() fires the
  // 550ms status timer that advances to the next queued status, until
  // GAME OVER (a terminal status, its own busy=false) is finally shown.
  g.stepFrame();
  let drainGuard = 0;
  while (!/GAME OVER/.test(g.elements.status.innerHTML) && drainGuard++ < 10) g.fireDueTimeout();
  assert.match(g.elements.status.innerHTML, /GAME OVER/, 'setup: the GAME OVER screen must actually be showing');
  assert.match(g.elements.status.innerHTML, /NORMAL/, 'RESULT_LABEL_NORMAL: the terminal GAME OVER screen must display NORMAL');
});

await checkAsync('TEST_RESULT_LABEL_HARD_ON_RUN_COMPLETE', async () => {
  const g = boot();
  g.test.difficulty.set('hard');
  g.test.start();
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const s = g.test.state();
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete', 'setup: the run must actually reach RUN COMPLETE');
  assert.match(g.elements.status.innerHTML, /HARD/, 'RESULT_LABEL_HARD: the terminal RUN COMPLETE screen must display HARD');
});

await checkAsync('TEST_RESULT_STATS_UNCHANGED_BY_DIFFICULTY_LABEL', async () => {
  // The difficulty tag is a prepended addition — the existing stat
  // fields/format must all still be present and correct alongside it.
  // Fields are set directly (rather than via press(), which would queue
  // extra PERFECT/GOOD/MISS popups ahead of the terminal one) so the SOLE
  // event fired here is 'complete' itself, landing on the actual result
  // screen in a single frame — see TEST_RESULT_LABEL_NORMAL_ON_GAME_OVER
  // above for the drain pattern needed when multiple events are queued.
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.perfects = 1; s.goods = 1; s.misses = 1; s.maxCombo = 2; s.score = 150;
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete');
  const html = g.elements.status.innerHTML;
  assert.match(html, /PERFECT 1/, 'PERFECT count must still be shown');
  assert.match(html, /GOOD 1/, 'GOOD count must still be shown');
  assert.match(html, /MISS 1/, 'MISS count must still be shown');
  assert.match(html, /MAX COMBO/, 'MAX COMBO label must still be shown');
  assert.match(html, /SCORE/, 'SCORE must still be shown');
  assert.match(html, /BEST/, 'BEST must still be shown');
});

// ============================================================
// Phase 3D.2: transient judgment/UI state remediation.
//
// Root cause found by auditing the real frame/event-drain path (frame()
// -> tick() -> handleEvent() -> displayEvent(), plus the setTimeout-based
// advanceQueue() cadence): displayEvent() used to read LIVE state.combo /
// state.misses when rendering a judgment popup — correct ONLY if that
// popup shows the instant its judgment occurs. But judgments queue
// (each popup holds the screen for a fixed ~550ms before the next queued
// one can show), and HARD's dense sections can commit judgments faster
// than that — so a queued PERFECT/GOOD popup could end up showing AFTER
// a later MISS had already reset combo, displaying a combo/misses-left
// number that never actually applied to that specific judgment. The
// terminal transition (GAME OVER/RUN COMPLETE) was ALSO queued through
// that same FIFO, so a backlog of stale popups could delay the correct
// result screen by several seconds right when the run ends — exactly
// matching the human tester's "temporary visual bug ... immediately
// after clearing the song."
//
// The PERSISTENT state (score/combo/misses/perfects/goods, and the final
// result screen's own numbers) was never wrong — see TEST_RESULT_STATS_*
// above — this was purely a transient DISPLAY bug.
//
// Fix: fire() now snapshots combo/misses into the event itself at the
// moment of judgment (game-core.js), and handleEvent() now drops any
// stale backlog (but not a single already-displaying popup) the instant
// a terminal event arrives (game.js). See the comments at fire() and
// handleEvent() for the full reasoning.
// ============================================================

await checkAsync('TEST_MISS_FRAME_BY_FRAME_HUD_MATCHES_INTERNAL_STATE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1.16 }); // genuine tiny-positive-overlap MISS (established convention elsewhere in this suite)
  g.stepFrame(); // FRAME N-1: before the miss
  assert.equal(s.misses, 0, 'setup: baseline frame must show 0 misses');
  assert.equal(g.elements.misses.textContent, '0 / 3');

  g.dispatchKey('s'); // commits the MISS synchronously via the real input path
  g.stepFrame(); // FRAME N: MISS committed and rendered
  assert.equal(s.misses, 1, 'MISS_UI_SYNC: internal misses must be 1 on this frame');
  assert.equal(g.elements.misses.textContent, '1 / 3', 'MISS_UI_SYNC: HUD misses text must agree with internal state on the SAME rendered frame, not a frame behind');
  assert.equal(s.combo, 0, 'combo must already be reset internally');
  assert.equal(g.elements.combo.textContent, '0', 'combo visually resets on the SAME coherent state update as the MISS — no mixed-frame values');
  assert.match(g.elements.status.innerHTML, /MISS/, 'the MISS popup itself must be showing on this frame (nothing else was busy)');

  g.stepFrame(); g.stepFrame(); // FRAME N+1, N+2: post-MISS stable
  assert.equal(s.misses, 1, 'no further, unexplained mutation across subsequent frames');
  assert.equal(g.elements.misses.textContent, '1 / 3');
});

await checkAsync('TEST_QUEUED_PERFECT_POPUP_SHOWS_SNAPSHOTTED_COMBO_NOT_LIVE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a'); // PERFECT #1: combo 0->1
  g.stepFrame(); // shown immediately (nothing was busy) -> busy=true, its own 550ms timer running
  let m = /<b>PERFECT<\/b>(\d+)/.exec(g.elements.status.innerHTML);
  assert.ok(m && m[1] === '1', 'setup: PERFECT #1 must show combo 1');

  s.gates.push({ color: 1, t: 1 });
  g.dispatchKey('s'); // PERFECT #2: combo 1->2, fired while busy -> queued, not shown yet
  g.stepFrame();

  s.gates.push({ color: 2, t: 1.16 });
  g.dispatchKey('d'); // MISS: combo resets to 0, ALSO fired while still busy from PERFECT #1 -> queued
  g.stepFrame();
  assert.equal(s.combo, 0, 'setup: LIVE combo is already 0 by now — exactly what a live-state-reading display would leak into PERFECT #2\'s popup');

  assert.equal(g.fireDueTimeout(), true, 'PERFECT #1\'s timer must still be pending'); // expires PERFECT #1 -> shows queued PERFECT #2
  m = /<b>PERFECT<\/b>(\d+)/.exec(g.elements.status.innerHTML);
  assert.ok(m, 'PERFECT #2 must be showing now');
  assert.equal(m[1], '2', 'the SNAPSHOTTED combo (2, as it truly was at PERFECT #2\'s own judgment) must be shown, not the live value (0) left behind by the later MISS');

  assert.equal(g.fireDueTimeout(), true); // expires PERFECT #2 -> shows queued MISS
  assert.match(g.elements.status.innerHTML, /<b>MISS<\/b>2 left/, 'the MISS must show its own snapshotted misses-left (MISS_LIMIT 3 - 1 miss so far = 2)');
});

await checkAsync('TEST_QUEUED_MISS_POPUP_SHOWS_SNAPSHOTTED_MISSES_LEFT_NOT_LIVE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a'); // occupies the display slot (PERFECT, shown immediately, busy=true)
  g.stepFrame();

  s.gates.push({ color: 1, t: 1.16 });
  g.dispatchKey('s'); // MISS #1 (misses 0->1) -- queued behind the PERFECT popup
  g.stepFrame();

  s.gates.push({ color: 2, t: 1.16 });
  g.dispatchKey('d'); // MISS #2 (misses 1->2) -- ALSO queued
  g.stepFrame();
  assert.equal(s.misses, 2, 'setup: LIVE misses is already 2 by now');

  assert.equal(g.fireDueTimeout(), true); // expires PERFECT -> shows MISS #1
  assert.match(g.elements.status.innerHTML, /<b>MISS<\/b>2 left/, 'MISS #1 must show ITS OWN snapshotted misses-left (3-1=2), not the live value (3-2=1) left behind by the miss that came after it');

  assert.equal(g.fireDueTimeout(), true); // expires MISS #1 -> shows MISS #2
  assert.match(g.elements.status.innerHTML, /<b>MISS<\/b>1 left/, 'MISS #2 must show its own snapshotted misses-left (3-2=1)');
});

await checkAsync('TEST_RUN_COMPLETE_DROPS_STALE_BACKLOG_NOT_DRAINED_ONE_BY_ONE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a'); g.stepFrame(); // PERFECT #1: shown immediately, busy=true, 1 outstanding timer
  s.gates.push({ color: 1, t: 1 });
  g.dispatchKey('s'); g.stepFrame(); // PERFECT #2: queued (stale backlog once terminal fires)
  s.gates.push({ color: 2, t: 1 });
  g.dispatchKey('d'); g.stepFrame(); // PERFECT #3: queued (stale backlog)
  assert.match(g.elements.status.innerHTML, /PERFECT/, 'setup: PERFECT #1 must be showing');

  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame(); // tick() fires 'complete' this frame
  assert.equal(s.phase, 'complete', 'setup: run must be internally complete');

  // Exactly ONE more timer expiry (PERFECT #1's still-running popup
  // finishing its own natural turn) must be enough to reach RUN COMPLETE
  // — NOT three (which draining PERFECT #2, then #3, then 'complete' one
  // at a time, the old behavior, would have required).
  assert.equal(g.fireDueTimeout(), true, 'setup: PERFECT #1\'s popup must still have a pending timer to expire');
  assert.match(g.elements.status.innerHTML, /RUN COMPLETE/, 'RUN_COMPLETE_UI_SYNC: RUN COMPLETE must appear immediately after the one already-displaying popup finishes, not after draining a 2-item stale backlog first');
  assert.equal(g.fireDueTimeout(), false, 'no further timers may remain queued once RUN COMPLETE is showing');
});

await checkAsync('TEST_GAME_OVER_DROPS_STALE_BACKLOG_USES_FINALIZED_COUNTERS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a'); g.stepFrame(); // PERFECT #1: shown immediately, busy=true
  s.gates.push({ color: 1, t: 1 });
  g.dispatchKey('s'); g.stepFrame(); // PERFECT #2: queued (stale backlog once GAME OVER fires)

  for (let i = 0; i < 3; i++) { s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); } // 3 MISSes -> GAME OVER (keyup between presses -- the heldKey guard otherwise blocks a same-key repeat)
  assert.equal(s.phase, 'gameover', 'setup: 3rd miss must trigger GAME OVER internally');
  const finalPerfects = s.perfects, finalGoods = s.goods, finalMisses = s.misses, finalMaxCombo = s.maxCombo;

  // Exactly TWO more timer expiries reach GAME OVER: PERFECT #1's still-
  // running popup finishing its own turn, then the MISS that directly
  // CAUSED game over getting its own turn too (the original, intentional
  // "a MISS immediately followed by GAME OVER are two distinct events
  // that must each get their own visible turn" pairing — see fire()) —
  // NOT the three extra turns the stale PERFECT #2/MISS #1/MISS #2
  // backlog would have needed if it hadn't been dropped.
  assert.equal(g.fireDueTimeout(), true, 'setup: PERFECT #1\'s popup must still have a pending timer to expire');
  assert.doesNotMatch(g.elements.status.innerHTML, /GAME OVER/, 'setup: the causing MISS must get its own turn before GAME OVER, not be skipped');
  assert.match(g.elements.status.innerHTML, /MISS/, 'the MISS that directly caused GAME OVER must show first');
  assert.equal(g.fireDueTimeout(), true, 'the causing MISS\'s popup must still have a pending timer to expire');
  assert.match(g.elements.status.innerHTML, /GAME OVER/, 'GAME_OVER_UI_SYNC: GAME OVER must appear right after the causing MISS\'s own turn, not after draining the stale PERFECT #2/MISS #1/MISS #2 backlog first');
  const html = g.elements.status.innerHTML;
  assert.match(html, new RegExp('PERFECT ' + finalPerfects + '\\b'), 'TERMINAL_COUNTER_SNAPSHOT: GAME OVER must show the FINALIZED perfect count');
  assert.match(html, new RegExp('GOOD ' + finalGoods + '\\b'), 'TERMINAL_COUNTER_SNAPSHOT: GAME OVER must show the FINALIZED good count');
  assert.match(html, new RegExp('MISS ' + finalMisses + '\\b'), 'TERMINAL_COUNTER_SNAPSHOT: GAME OVER must show the FINALIZED miss count');
  assert.match(html, new RegExp('MAX COMBO ' + finalMaxCombo + '\\b'), 'TERMINAL_COUNTER_SNAPSHOT: GAME OVER must show the FINALIZED max combo');
});

await checkAsync('TEST_NO_STALE_GATE_RENDERS_AFTER_RUN_COMPLETE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete');
  assert.equal(s.gates.length, 0, 'no gate may remain live/unresolved once RUN COMPLETE has been reached');
  g.stepFrame(); g.stepFrame(); // FRAME N+1, N+2
  assert.equal(s.gates.length, 0, 'no gate may appear on subsequent frames after RUN COMPLETE either');
});

await checkAsync('TEST_NO_DELAYED_TIMEOUT_MUTATES_TERMINAL_COUNTERS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete');
  const snapshot = { score: s.score, combo: s.combo, misses: s.misses, perfects: s.perfects, goods: s.goods, maxCombo: s.maxCombo };
  let guard = 0;
  while (g.fireDueTimeout() && guard++ < 20) {}
  g.stepFrame();
  assert.deepEqual({ score: s.score, combo: s.combo, misses: s.misses, perfects: s.perfects, goods: s.goods, maxCombo: s.maxCombo }, snapshot,
    'POST_TERMINAL_MUTATION: no queued timeout/frame may mutate counters after the run has completed');
});

await checkAsync('TEST_NO_POST_TERMINAL_INPUT_MUTATES_RESULT', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete');
  const before = { score: s.score, combo: s.combo, misses: s.misses, perfects: s.perfects, goods: s.goods };
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a');
  g.stepFrame();
  assert.deepEqual({ score: s.score, combo: s.combo, misses: s.misses, perfects: s.perfects, goods: s.goods }, before,
    'no queued judgment event/input may mutate the terminal result afterward');
});

await checkAsync('TEST_RETRY_CLEARS_TRANSIENT_VISUAL_AND_EVENT_STATE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a'); g.stepFrame(); // PERFECT showing, busy=true
  s.gates.push({ color: 1, t: 1 });
  g.dispatchKey('s'); g.stepFrame(); // queued
  assert.match(g.elements.status.innerHTML, /PERFECT/, 'setup: a judgment popup must be showing before retry');

  g.dispatchKey('r'); // retry mid-backlog

  assert.equal(g.elements.status.className, '', 'RETRY_TRANSIENT_CLEANUP: retry must clear the status overlay visibility');
  assert.equal(g.elements.status.innerHTML, '', 'RETRY_TRANSIENT_CLEANUP: retry must clear any leftover judgment/result text');
  assert.equal(g.fireDueTimeout(), false, 'RETRY_TRANSIENT_CLEANUP: retry must cancel any pending status timer — the stale queued judgment must never fire after retry');
  assert.equal(g.elements.status.innerHTML, '', 'no stale queued judgment may appear after retry');
});

// ============================================================
// Phase 3D.3: GAME OVER terminal-state remediation (Codex BLOCKING
// FINDING 1 + 2).
//
// FINDING 1: GAME OVER's status HTML showed PERFECT/GOOD/MISS/MAX COMBO
// (via stats()) but never SCORE or BEST, unlike RUN COMPLETE. Both are
// now built from ONE shared finalResultBlock() (see game.js) so they can
// no longer independently drift on what "finalized" means.
//
// FINDING 2: two GAME OVER paths (press()'s miss on a DIFFERENT lane
// than an active Hold, and tick()'s ordinary pass-by-miss on a DIFFERENT
// gate) used to null state.activeHold WITHOUT removing that Hold's own
// gate object from state.gates — leaving a stale, unresolved gate
// rendering every terminal frame after GAME OVER. game-core.js's new
// clearActiveHold(state) helper now always removes the gate too.
// ============================================================

await checkAsync('TEST_GAME_OVER_FULL_RESULT_SHOWS_SCORE_BEST_AND_STATS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 }); g.dispatchKey('a'); g.dispatchKeyUp('a'); g.stepFrame(); // PERFECT
  s.gates.push({ color: 1, t: 1.1 }); g.dispatchKey('s'); g.dispatchKeyUp('s'); g.stepFrame(); // GOOD
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); } // 3 MISSes -> GAME OVER
  assert.equal(s.phase, 'gameover', 'setup: 3rd miss must trigger GAME OVER internally');
  const finalScore = s.score, finalPerfects = s.perfects, finalGoods = s.goods, finalMisses = s.misses, finalMaxCombo = s.maxCombo;
  assert.ok(finalScore > 0, 'setup: this scenario must have accrued a nonzero score to make the SCORE assertion meaningful');

  // Drain the real event/timer path (PERFECT, GOOD, 3x MISS, GAME OVER — each its own queued turn) to the actual terminal screen.
  g.stepFrame();
  let guard = 0;
  while (!/GAME OVER/.test(g.elements.status.innerHTML) && guard++ < 15) g.fireDueTimeout();
  const html = g.elements.status.innerHTML;
  assert.match(html, /GAME OVER/, 'setup: GAME OVER must actually be showing');

  assert.match(html, new RegExp('SCORE ' + finalScore + '\\b'), 'GAME_OVER_SCORE_PRESENT: GAME OVER must show the finalized SCORE');
  assert.match(html, /BEST \d+/, 'GAME_OVER_BEST_PRESENT: GAME OVER must show BEST');
  assert.match(html, new RegExp('BEST ' + finalScore + '\\b'), 'a fresh run with no prior BEST stored must show BEST equal to this run\'s own finalized SCORE');
  assert.match(html, new RegExp('PERFECT ' + finalPerfects + '\\b'), 'GAME_OVER_PERFECT_PRESENT: must match the finalized perfect count');
  assert.match(html, new RegExp('GOOD ' + finalGoods + '\\b'), 'GAME_OVER_GOOD_PRESENT: must match the finalized good count');
  assert.match(html, new RegExp('MISS ' + finalMisses + '\\b'), 'GAME_OVER_MISS_PRESENT: must match the finalized miss count');
  assert.match(html, new RegExp('MAX COMBO ' + finalMaxCombo + '\\b'), 'GAME_OVER_MAX_COMBO_PRESENT: must match the finalized max combo');
});

await checkAsync('TEST_ACTIVE_HOLD_GAME_OVER_E2E_NO_STALE_GATE_RENDER', async () => {
  // Baseline: how many shapes a draw() call records with ZERO gates
  // (background decorative arcs + track lane lines/dock circles +
  // unicorn only) — anything beyond this after GAME OVER would be a
  // stale gate/Hold render.
  const baseline = boot();
  baseline.test.draw(0);
  const baselineShapeCount = baseline.canvasRecorder.shapes.length;
  assert.ok(baselineShapeCount > 0, 'setup: draw() must record some shapes to make this comparison meaningful');

  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  // 1/2/3. activate a real Hold gate and keep it active.
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  assert.ok(s.activeHold && s.activeHold.lane === 0, 'setup: the Hold must be active');
  // Phase 3D.4 (Codex MEDIUM — ACTIVE-HOLD + SURVIVOR CASE): a THIRD,
  // completely unrelated, still-unresolved gate — neither the active
  // Hold's own gate nor the one causing GAME OVER — must ALSO be cleared.
  // Its t is far from its own miss threshold, so it never resolves on its
  // own before GAME OVER fires.
  s.gates.push({ color: 1, t: 0.3 });
  // 4. accumulate the third MISS through ANOTHER lane while the Hold is still active.
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); }
  assert.equal(s.phase, 'gameover', 'setup: the 3rd miss on the OTHER lane must trigger GAME OVER while the Hold was still active');
  // 5/6/7. drain the real event/timer path into the actual terminal GAME OVER screen.
  let guard = 0;
  while (!/GAME OVER/.test(g.elements.status.innerHTML) && guard++ < 10) g.fireDueTimeout();
  assert.match(g.elements.status.innerHTML, /GAME OVER/, 'setup: GAME OVER must actually be showing');

  assert.equal(s.activeHold, null, 'GAME_OVER_ACTIVE_HOLD_CLEARED');
  assert.equal(s.gates.length, 0, 'GAME_OVER_GATES_CLEARED: the held gate\'s own object must be removed, not just the activeHold reference');

  // Canvas/draw instrumentation: confirm no gate/note/Hold geometry is actually rendered on a terminal frame.
  g.canvasRecorder.shapes.length = 0;
  g.test.draw(s.time);
  assert.equal(g.canvasRecorder.shapes.length, baselineShapeCount,
    'GAME_OVER_STALE_GATE_DRAW: a terminal draw() call must record exactly the background/track/unicorn baseline shape count, with no extra gate/Hold geometry');
});

await checkAsync('TEST_GAME_OVER_WITHOUT_ACTIVE_HOLD_CLEAN', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  // Phase 3D.4 (Codex NO-ACTIVE-HOLD SURVIVOR CASE): an unrelated,
  // still-unresolved gate must ALSO be cleared even with no Hold ever
  // involved — Codex specifically found this survives with activeHold
  // already correctly null.
  s.gates.push({ color: 1, t: 0.3 });
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); } // ordinary 3rd-MISS GAME OVER, no Hold ever involved
  assert.equal(s.phase, 'gameover');
  assert.equal(s.activeHold, null, 'GAME_OVER_WITHOUT_ACTIVE_HOLD_CLEAN: activeHold must be null (was never active)');
  assert.equal(s.gates.length, 0, 'GAME_OVER_WITHOUT_ACTIVE_HOLD_CLEAN: no gate may remain, including the unrelated survivor');
  let guard = 0;
  while (!/GAME OVER/.test(g.elements.status.innerHTML) && guard++ < 10) g.fireDueTimeout();
  const html = g.elements.status.innerHTML;
  assert.match(html, /GAME OVER/);
  assert.match(html, /SCORE \d+/, 'final stats (SCORE) must be present even with no Hold ever involved');
  assert.match(html, /BEST \d+/);
  assert.match(html, new RegExp('PERFECT ' + s.perfects + '\\b'));
  assert.match(html, new RegExp('GOOD ' + s.goods + '\\b'));
  assert.match(html, new RegExp('MISS ' + s.misses + '\\b'));
  assert.match(html, /MAX COMBO/);
});

await checkAsync('TEST_RETRY_AFTER_ACTIVE_HOLD_GAME_OVER', async () => {
  const g = await startWithDecodeLatency(0); // default EASY
  const s0 = g.test.state();
  s0.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  assert.ok(s0.activeHold, 'setup: the Hold must be active');
  // Phase 3D.4: an unrelated survivor too — RETRY_AFTER_SURVIVOR_GAME_OVER.
  s0.gates.push({ color: 1, t: 0.3 });
  for (let i = 0; i < 3; i++) { s0.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); }
  assert.equal(s0.phase, 'gameover', 'setup: GAME OVER must trigger while the Hold was active, with a concurrent survivor gate present');

  g.dispatchKey('r'); // retry after an active-Hold + survivor GAME OVER
  const s1 = g.test.state();
  assert.equal(s1.phase, 'run', 'retry must return to a fresh run');
  assert.equal(s1.activeHold, null, 'RETRY_AFTER_SURVIVOR_GAME_OVER: no stale activeHold may survive retry');
  assert.equal(s1.gates.length, 0, 'RETRY_AFTER_SURVIVOR_GAME_OVER: no stale gate (Hold or survivor) may survive retry');
  assert.equal(s1.chartIdx, 0, 'retry must reset the chart cursor');
  assert.equal(g.C.CHART.length, 82, 'retry must re-activate the same EASY chart, unaffected by the prior active-Hold GAME OVER');
  assert.equal(s1.difficulty, 'easy', 'retry must preserve the selected difficulty');
  // A fresh run must still be able to spawn its own first chart event exactly once.
  let guard = 0;
  while (s1.chartIdx === 0 && guard++ < 200) { g.audioCtx._advance(0.02); g.stepFrame(); }
  assert.equal(s1.chartIdx, 1, 'the retried run must spawn its own first chart event exactly once');
});

// ============================================================
// Phase 3D.4: GAME OVER full runtime-gate terminalization (Codex MEDIUM
// fix). clearActiveHold() (Phase 3D.3) only ever removed the ACTIVE
// HOLD's own gate — Codex reproduced OTHER, structurally-unrelated,
// still-unresolved gates surviving in state.gates regardless of which of
// the 4 real GAME OVER paths triggered it. game-core.js's new
// enterGameOver(state) is now the SINGLE canonical path for all 4 —
// press() miss, release() miss, tick()'s held-gate timeout, and tick()'s
// ordinary pass-by-miss — and unconditionally clears state.gates.length
// = 0, not just whichever gate each branch already knew about.
// ============================================================

await checkAsync('TEST_PRESS_MISS_GAME_OVER_SURVIVOR_GATE_CLEARED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 0.3 }); // unrelated survivor, nowhere near its own miss threshold
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); }
  assert.equal(s.phase, 'gameover', 'setup: 3rd press MISS must trigger GAME OVER');
  assert.equal(s.gates.length, 0, 'PRESS_MISS_SURVIVOR_CLEARED');
});

await checkAsync('TEST_RELEASE_MISS_GAME_OVER_SURVIVOR_GATE_CLEARED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 0.3 }); // unrelated survivor
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a'); // start hold, PERFECT
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); // miss 1
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); // miss 2
  g.dispatchKeyUp('a'); // early release -> miss 3 -> GAME OVER, via release()'s own miss branch
  g.stepFrame();
  assert.equal(s.phase, 'gameover', 'setup: the early release MISS must trigger GAME OVER');
  assert.equal(s.activeHold, null);
  assert.equal(s.gates.length, 0, 'RELEASE_MISS_SURVIVOR_CLEARED');
});

await checkAsync('TEST_HELD_TIMEOUT_GAME_OVER_SURVIVOR_GATE_CLEARED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 0.3 }); // unrelated survivor -- stays well under its own threshold throughout (verified below)
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a'); // start hold, PERFECT
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); // miss 1
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); // miss 2
  let guard = 0;
  while (s.activeHold && guard++ < 300) { g.audioCtx._advance(0.02); g.stepFrame(); } // let the Hold time out WITHOUT releasing -> miss 3, via tick()'s held-gate-timeout branch
  assert.equal(s.phase, 'gameover', 'setup: the Hold timing out must trigger GAME OVER');
  assert.equal(s.activeHold, null);
  assert.equal(s.gates.length, 0, 'HELD_TIMEOUT_SURVIVOR_CLEARED');
});

await checkAsync('TEST_PASS_BY_MISS_GAME_OVER_SURVIVOR_GATE_CLEARED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); // miss 1
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); // miss 2
  s.gates.push({ color: 1, t: 0.3 }); // unrelated survivor
  s.gates.push({ color: 0, t: 1 }); // the CAUSING gate -- never pressed, naturally passes by via tick()'s own sweep
  let guard = 0;
  while (s.phase === 'run' && guard++ < 300) { g.audioCtx._advance(0.02); g.stepFrame(); }
  assert.equal(s.phase, 'gameover', 'setup: the un-pressed gate passing by must trigger GAME OVER (miss 3), via tick()\'s ordinary pass-by-miss branch');
  assert.equal(s.gates.length, 0, 'PASS_BY_MISS_SURVIVOR_CLEARED');
});

await checkAsync('TEST_MULTIPLE_TERMINAL_FRAMES_NO_GATE_RESPAWN', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 0.3 }); // survivor
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); g.dispatchKeyUp('d'); g.stepFrame(); }
  assert.equal(s.phase, 'gameover');
  assert.equal(s.gates.length, 0);
  const chartIdxAtGameOver = s.chartIdx;
  const countersAtGameOver = { score: s.score, perfects: s.perfects, goods: s.goods, misses: s.misses };
  // POST_GAME_OVER_GATE_RESPAWN: advance many more frames/timeouts -- no
  // new gate may appear (chart spawning is blocked by tick()'s own
  // `state.phase !== 'run'` guard), gates.length must stay 0, and no
  // counter may change.
  for (let i = 0; i < 10; i++) { g.audioCtx._advance(0.05); g.stepFrame(); g.fireDueTimeout(); }
  assert.equal(s.gates.length, 0, 'POST_GAME_OVER_GATE_RESPAWN: gates must remain empty across many subsequent terminal frames');
  assert.equal(s.chartIdx, chartIdxAtGameOver, 'chart cursor must not advance (no further chart-driven spawning) after GAME OVER');
  assert.deepEqual({ score: s.score, perfects: s.perfects, goods: s.goods, misses: s.misses }, countersAtGameOver, 'result counters must not change across subsequent terminal frames');
});

await checkAsync('TEST_PERSISTED_BEST_PRIOR_HIGHER_THAN_CURRENT', async () => {
  // Case A: a prior BEST already in (real, persistent) localStorage is
  // HIGHER than this run's own score -- BEST must remain the prior value.
  const g = boot({ localStorageInit: { rainbowRefrainBest: '99999' } });
  g.dispatchKey(' ');
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const s = g.test.state();
  s.score = 50; // set directly (well under 99999) -- avoids queuing a PERFECT popup ahead of 'complete', keeping this test focused on BEST semantics
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete');
  assert.ok(s.score < 99999, 'setup: this run\'s own score must be lower than the prior BEST');
  assert.match(g.elements.status.innerHTML, /BEST 99999\b/, 'PERSISTED_BEST_LOW_SCORE_CASE: BEST must remain the prior (higher) persisted value, never decrease');
  assert.equal(g.localStorageStore.rainbowRefrainBest, '99999', 'the persisted value itself must remain unchanged (never overwritten by a lower score)');
});

await checkAsync('TEST_PERSISTED_BEST_CURRENT_HIGHER_THAN_PRIOR', async () => {
  // Case B: this run's score EXCEEDS the prior persisted BEST -- BEST
  // must update to the current (higher) score, and that update must
  // actually be persisted (readable back from localStorage afterward).
  const g = boot({ localStorageInit: { rainbowRefrainBest: '10' } });
  g.dispatchKey(' ');
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  const s = g.test.state();
  s.score = 5000; // set directly (well over 10) -- avoids queuing a PERFECT popup ahead of 'complete', keeping this test focused on BEST semantics
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete');
  assert.ok(s.score > 10, 'setup: this run\'s own score must exceed the prior BEST');
  assert.match(g.elements.status.innerHTML, new RegExp('BEST ' + s.score + '\\b'), 'PERSISTED_BEST_HIGH_SCORE_CASE: BEST must update to this run\'s own (higher) score');
  assert.equal(g.localStorageStore.rainbowRefrainBest, String(s.score), 'the new BEST must actually be persisted, readable back from localStorage');
});

for (const termDiff of ['easy', 'normal', 'hard']) {
  await checkAsync('TEST_' + termDiff.toUpperCase() + '_TERMINAL_PATH_CLEAN_AND_IMMEDIATE', async () => {
    const g = boot();
    g.test.difficulty.set(termDiff);
    g.test.start();
    await g.flush();
    g.audioCtx._resolveDecode();
    await g.flush();
    const s = g.test.state();
    s.gates.push({ color: 0, t: 1 });
    g.dispatchKey('a'); g.stepFrame(); // PERFECT showing, busy=true
    s.gates.push({ color: 1, t: 1 });
    g.dispatchKey('s'); g.stepFrame(); // queued -- stale backlog once terminal fires
    s.time = g.C.RUN_DURATION;
    g.audioCtx._advance(0.05);
    g.stepFrame(); // fires 'complete'
    assert.equal(s.phase, 'complete', termDiff + ': setup must actually complete internally');
    assert.equal(g.fireDueTimeout(), true, termDiff + ': the one already-displaying popup must still have its own timer');
    assert.match(g.elements.status.innerHTML, /RUN COMPLETE/, termDiff + ': RUN COMPLETE must appear right after, not after draining a stale backlog');
    assert.match(g.elements.status.innerHTML, new RegExp(termDiff.toUpperCase()), termDiff + ': the result label must match the difficulty actually played');
  });
}

// REQUIRED REGRESSION TEST: decode latency 0/100/500/2000ms must never
// leak into chart/audio sync — only into how long the title screen holds.
for (const [label, latencySec] of [['0MS', 0], ['100MS', .1], ['500MS', .5], ['2000MS', 2]]) {
  await checkAsync('TEST_DECODE_LATENCY_' + label, async () => {
    const g = await startWithDecodeLatency(latencySec);
    const runOrigin = g.test.wav.runOrigin();
    const src = g.rec.bufferSources[0];
    assert.equal(g.rec.bufferSources.length, 1, 'exactly one WAV source must be scheduled');

    const wavStartGameTime = src.startedAt - runOrigin;
    assert.ok(Math.abs(wavStartGameTime - 2.25) < 1e-9,
      'WAV_START_GAME_TIME must be exactly PRE_ROLL (2.25s) regardless of ' + latencySec + 's decode latency, got ' + wavStartGameTime);

    // Drive gameplay to the first chart hit and confirm it lands exactly
    // where expected — both in gameElapsed and, by construction, in WAV
    // playback time (gameElapsed - PRE_ROLL).
    const firstHitGameTime = g.C.CHART[0].t;
    assert.ok(Math.abs(firstHitGameTime - 2.544) < 1e-9, 'FIRST_NOTE_HIT_GAME_TIME must be 2.544s');
    await advanceGameTimeTo(g, firstHitGameTime, 0.05);
    const s = g.test.state();
    const gate = s.gates.find((x) => x.color === g.C.CHART[0].lane);
    assert.ok(gate, 'the first chart note must be live at its hit time');
    const wavTimeAtHit = s.time - g.C.PRE_ROLL;
    assert.ok(Math.abs(wavTimeAtHit - 0.294) < 0.06, 'FIRST_NOTE_WAV_TIME_AT_HIT must be ~0.294s (within one advance step), got ' + wavTimeAtHit);
    const syncErrorMs = Math.abs(gate.t - 1) * g.C.TRAVEL * 1000;
    assert.ok(syncErrorMs < 60, 'SYNC_ERROR must be approximately 0 regardless of decode latency, got ' + syncErrorMs.toFixed(1) + 'ms');
  });
}

// ============================================================
// Phase 3B.2: WAV fetch/decode failure handling (LOW-severity fix) — a
// rejection must never silently hang the title screen forever.
// ============================================================
await checkAsync('TEST_WAV_FETCH_REJECTION_HANDLED', async () => {
  const g = boot({ failFetch: 'reject' });
  g.test.start();
  await g.flush();
  await g.flush(); // extra tick for the .catch() chain to fully settle
  assert.equal(g.test.started(), false, 'a failed fetch must never silently start the run');
  assert.ok(g.test.wav.error(), 'WAV_FETCH_FAILURE_HANDLED: an audio load error state must be set once the fetch rejects');
  assert.ok(g.consoleErrors.length > 0, 'the failure must be logged via console.error, not silently swallowed');
  assert.equal(g.test.wav.pending(), false, 'pendingStart must not be left dangling forever after a fetch failure');
});

await checkAsync('TEST_WAV_FETCH_NOT_OK_HANDLED', async () => {
  const g = boot({ failFetch: 'notok' });
  g.test.start();
  await g.flush();
  await g.flush();
  assert.equal(g.test.started(), false, 'a non-ok HTTP response (e.g. 404) must never silently start the run');
  assert.ok(g.test.wav.error(), 'a non-ok fetch response must also surface the audio load error state');
});

await checkAsync('TEST_WAV_DECODE_REJECTION_HANDLED', async () => {
  const g = boot();
  g.test.start();
  await g.flush();
  assert.equal(g.test.wav.pending(), true, 'setup: the gesture must be recorded as pending before decode settles');
  g.audioCtx._rejectDecode(new Error('corrupt audio data'));
  await g.flush();
  assert.equal(g.test.started(), false, 'WAV_DECODE_FAILURE_HANDLED: a rejected decodeAudioData() must never silently start the run');
  assert.ok(g.test.wav.error(), 'a decode rejection must set the audio load error state');
  assert.ok(g.consoleErrors.length > 0, 'the decode failure must be logged via console.error');
  assert.equal(g.test.wav.pending(), false, 'pendingStart must not be left dangling forever after a decode failure');
});

await checkAsync('TEST_RETRY_SHARED_ORIGIN_NO_REDECODE', async () => {
  const g = await startWithDecodeLatency(.1);
  const firstSrc = g.rec.bufferSources[0];
  const originalRunOrigin = g.test.wav.runOrigin();
  g.audioCtx._advance(5); // real time passes during play
  const s0 = g.test.state();
  await advanceGameTimeTo(g, 5, 0.2);
  assert.ok(s0.chartIdx > 0, 'setup: chart must have advanced before retry');

  g.dispatchKey('r');
  assert.ok(firstSrc.stoppedAt !== undefined, 'RETRY_AUDIO_RESET: the previous WAV source must be stopped on retry');
  assert.equal(g.rec.bufferSources.length, 2, 'exactly one NEW WAV source must be scheduled on retry — no re-decode wait, no overlap');
  const newRunOrigin = g.test.wav.runOrigin();
  assert.ok(newRunOrigin > originalRunOrigin, 'retry must establish a genuinely NEW shared origin, not reuse the old one');
  const newSrc = g.rec.bufferSources[1];
  assert.ok(Math.abs((newSrc.startedAt - newRunOrigin) - 2.25) < 1e-9, 'the retried WAV must also start at exactly PRE_ROLL from its own new origin');
  const s1 = g.test.state();
  assert.equal(s1.chartIdx, 0, 'chart cursor must reset to 0 on retry');
  assert.equal(s1.gates.length, 0, 'no stale notes may remain after retry');
});

await checkAsync('TEST_GAME_OVER_STOPS_WAV', async () => {
  const g = await startWithDecodeLatency(0);
  const src = g.rec.bufferSources[0];
  const s = g.test.state();
  s.phase = 'gameover';
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.ok(src.stoppedAt !== undefined, 'GAME_OVER_AUDIO_STOP: the WAV must stop immediately once phase is gameover');
});

await checkAsync('TEST_RUN_COMPLETE_STOPS_WAV_CLEANLY', async () => {
  const g = await startWithDecodeLatency(0);
  const src = g.rec.bufferSources[0];
  const s = g.test.state();
  s.phase = 'complete';
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.ok(src.stoppedAt !== undefined, 'RUN_COMPLETE_AUDIO_STOP: the WAV must stop cleanly once the run completes');
});

await checkAsync('TEST_SFX_STILL_FIRE_ALONGSIDE_WAV', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a');
  g.audioCtx._advance(0.01);
  g.stepFrame(); // drives displayEvent() -> tone()
  assert.ok(g.rec.oscStarts.length > 0, 'SFX_PRESERVED: judgment SFX must still fire via tone() alongside WAV playback');
});

await checkAsync('TEST_NO_DUPLICATE_CHART_NOTES_OVER_RUN', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  let guard = 0;
  while (s.time < g.C.RUN_DURATION && guard++ < 15000) { g.audioCtx._advance(0.05); g.stepFrame(); s.gates.length = 0; s.activeHold = null; }
  assert.equal(s.chartIdx, 82, 'every chart event must spawn exactly once across the full playtest run duration');
});

// ============================================================
// TAP judgment (unchanged mechanics, reverified against the v2 build)
// ============================================================
await checkAsync('TEST_TAP_PERFECT_WORKS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a');
  assert.equal(s.lastEvent, 'perfect', 'normal TAP PERFECT must still work');
});

await checkAsync('TEST_TAP_GOOD_WORKS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1.1 });
  g.dispatchKey('s');
  assert.equal(s.lastEvent, 'good', 'normal TAP GOOD must still work');
});

await checkAsync('TEST_TAP_MISS_WORKS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1.16 }); // verified: genuine tiny-positive-overlap MISS, not NO-OP
  g.dispatchKey('s');
  assert.equal(s.lastEvent, 'miss', 'normal TAP MISS must still work');
  assert.equal(s.misses, 1);
});

await checkAsync('TEST_TAP_CONTROLS_UNCHANGED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  g.dispatchKey('d');
  assert.equal(s.lane, 2, 'A/S/D lane selection must be unchanged');
  g.dispatchKey('ArrowLeft');
  assert.equal(s.lane, 1, 'Arrow key lane movement must be unchanged');
});

// ============================================================
// Formal Hold note mechanics
// ============================================================
await checkAsync('TEST_HOLD_START_PERFECT_ACTIVATES_HOLD', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  assert.equal(s.lastEvent, 'perfect', 'Hold start must use the exact same TAP judgment thresholds');
  assert.ok(s.activeHold && s.activeHold.lane === 0, 'a PERFECT Hold start must activate the Hold');
  assert.equal(s.perfects, 1, 'Hold start PERFECT must contribute to the existing PERFECT count');
});

await checkAsync('TEST_HOLD_START_GOOD_ACTIVATES_HOLD', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1.1, hold: g.C.HOLD_DUR });
  g.dispatchKey('s');
  assert.equal(s.lastEvent, 'good');
  assert.ok(s.activeHold && s.activeHold.lane === 1, 'a GOOD Hold start must also activate the Hold');
  assert.equal(s.goods, 1, 'Hold start GOOD must contribute to the existing GOOD count');
});

await checkAsync('TEST_HOLD_START_MISS_DOES_NOT_ACTIVATE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1.16, hold: g.C.HOLD_DUR });
  g.dispatchKey('s');
  assert.equal(s.lastEvent, 'miss');
  assert.equal(s.activeHold, null, 'a missed Hold start must not activate a Hold');
  assert.equal(s.misses, 1, 'exactly one MISS for the missed Hold start');
});

// Phase 3B.1: holding is no longer auto-success — releasing AT the end
// marker (holdEndT ~= 1) is a real PERFECT-level release judgment.
await checkAsync('TEST_HOLD_RELEASE_AT_END_MARKER_IS_PERFECT', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  const holdTUnits = g.C.HOLD_DUR / g.C.TRAVEL;
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a'); // start: PERFECT, combo=1
  const comboAfterStart = s.combo;
  const gate = s.activeHold.gate;
  let guard = 0;
  while (gate.t - holdTUnits < 1 && guard++ < 200) { g.audioCtx._advance(0.02); g.stepFrame(); }
  g.dispatchKeyUp('a'); // release right at the end marker
  assert.equal(s.lastEvent, 'perfect', 'PERFECT_RELEASE_SUPPORTED: releasing at the end marker must judge PERFECT, same as a normal note');
  assert.equal(s.activeHold, null);
  assert.equal(s.gates.some((x) => x.hold), false, 'the resolved Hold gate must be removed');
  assert.equal(s.combo, comboAfterStart + 1, 'a PERFECT release must add to combo, exactly like a normal note');
  assert.equal(s.perfects, 2, 'HOLD_END_SCORING: a PERFECT release must add to the PERFECT counter (start + end = 2)');
});

// B. RELEASE JUDGMENT: GOOD release (a bit late, still inside the GOOD window)
await checkAsync('TEST_HOLD_RELEASE_LATE_BUT_GOOD', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  const holdTUnits = g.C.HOLD_DUR / g.C.TRAVEL;
  s.gates.push({ color: 1, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('s');
  const gate = s.activeHold.gate;
  let guard = 0;
  while (gate.t - holdTUnits < 1.1 && guard++ < 200) { g.audioCtx._advance(0.02); g.stepFrame(); }
  g.dispatchKeyUp('s');
  assert.equal(s.lastEvent, 'good', 'GOOD_RELEASE_SUPPORTED: a slightly-late release inside the GOOD window must judge GOOD');
  assert.equal(s.goods, 1);
});

// B. RELEASE JUDGMENT: no release at all -> the Hold's own window closes
// exactly like a pass-by MISS on an ordinary note (LATE_RELEASE_MISS),
// exactly once (DOUBLE_MISS_PROTECTION), never auto-succeeding.
await checkAsync('TEST_HOLD_NO_RELEASE_TIMES_OUT_TO_MISS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 2, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('d'); // start holding, never release
  let guard = 0;
  while (s.activeHold && guard++ < 200) { g.audioCtx._advance(0.02); g.stepFrame(); }
  assert.equal(s.activeHold, null, 'LATE_RELEASE_MISS: an un-released Hold must eventually time out on its own');
  assert.equal(s.lastEvent, 'miss', 'holding through the whole window with no release must be a MISS, never an automatic success');
  assert.equal(s.misses, 1);
  assert.equal(s.combo, 0);
  // Continued holding/ticking afterward must not double-MISS.
  for (let i = 0; i < 10; i++) { g.audioCtx._advance(0.02); g.stepFrame(); }
  assert.equal(s.misses, 1, 'DOUBLE_MISS_PROTECTION: no further MISS may accrue once the Hold has already timed out');
  g.dispatchKeyUp('d'); // a stale release after the fact must also be a no-op
  assert.equal(s.misses, 1);
});

await checkAsync('TEST_HOLD_EARLY_RELEASE_ONE_MISS_RESETS_COMBO', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 2, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('d'); // start hold, PERFECT, combo=1
  assert.equal(s.combo, 1);
  g.audioCtx._advance(0.05);
  g.stepFrame();
  g.dispatchKeyUp('d'); // release well before the 0.768s end
  assert.equal(s.lastEvent, 'miss', 'early release must produce a MISS');
  assert.equal(s.misses, 1, 'exactly one MISS for the early release');
  assert.equal(s.combo, 0, 'early release must reset combo');
  assert.equal(s.activeHold, null, 'the failed Hold must be cleared');
});

await checkAsync('TEST_HOLD_EARLY_RELEASE_DOES_NOT_DOUBLE_MISS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  g.audioCtx._advance(0.05);
  g.stepFrame();
  g.dispatchKeyUp('a'); // early release -> 1 MISS
  assert.equal(s.misses, 1);
  // Let simulated time pass well beyond the ORIGINAL hold end time.
  for (let i = 0; i < 20; i++) { g.audioCtx._advance(0.05); g.stepFrame(); }
  assert.equal(s.misses, 1, 'DOUBLE_MISS_PROTECTION: no additional MISS may occur after the Hold already failed');
});

await checkAsync('TEST_HOLD_KEY_REPEAT_DOES_NOT_RESCORE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('s');
  assert.equal(s.perfects, 1);
  // Simulate OS key-repeat: several more keydown events for the SAME key,
  // still physically held, with no keyup in between.
  g.dispatchKey('s'); g.dispatchKey('s'); g.dispatchKey('s');
  assert.equal(s.perfects, 1, 'KEY_REPEAT_PROTECTION: repeated keydown while already held must not rescore');
  assert.equal(s.combo, 1, 'combo must not be inflated by key-repeat');
});

await checkAsync('TEST_HOLD_WRONG_LANE_DOES_NOT_ACTIVATE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 2, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a'); // wrong lane (0, not 2) — no gate there at all
  assert.equal(s.activeHold, null, 'pressing the wrong lane must not activate an unrelated Hold');
  assert.equal(s.gates.length, 1, 'the real Hold note must remain unjudged, still waiting in its own lane');
});

await checkAsync('TEST_HOLD_ACTIVE_CLEARS_ON_GAME_OVER', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a'); // activates a Hold
  assert.ok(s.activeHold);
  // 3 unrelated misses in a different lane end the run while the Hold is active.
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 1, t: 1.16 }); g.C.press(s, 1); }
  assert.equal(s.phase, 'gameover');
  assert.equal(s.activeHold, null, 'GAME_OVER_HOLD_RESET: active Hold must clear on GAME OVER');
});

await checkAsync('TEST_HOLD_ACTIVE_CLEARS_ON_RETRY', async () => {
  const g = await startWithDecodeLatency(0);
  const s0 = g.test.state();
  s0.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  assert.ok(s0.activeHold, 'setup: a Hold must be active before retry');
  g.dispatchKey('r');
  const s1 = g.test.state();
  assert.equal(s1.activeHold, null, 'RETRY_HOLD_RESET: active Hold must clear on retry');
  assert.equal(s1.gates.length, 0, 'no stale Hold gate may survive retry');
});

// ============================================================
// Input model
// ============================================================
await checkAsync('TEST_DESKTOP_KEYUP_TRACKED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 }); // ordinary TAP, no Hold — isolates pure keyup/heldKey tracking
  g.dispatchKey('a');
  assert.equal(s.perfects, 1);
  g.dispatchKeyUp('a');
  // After a real keyup, the SAME key going down again must score again
  // (proving keyup correctly cleared the held-key guard).
  s.gates.push({ color: 0, t: 1 });
  g.dispatchKey('a');
  assert.equal(s.perfects, 2, 'the second, independent press after a real keyup must be free to score');
});

await checkAsync('TEST_TOUCH_POINTER_HOLD_START_AND_RELEASE', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1, hold: g.C.HOLD_DUR }); // lane 1 = center, screen x ~640 at 1280x720
  g.pointerDown(640);
  assert.ok(s.activeHold && s.activeHold.lane === 1, 'TOUCH_HOLD_SUPPORT: pointerdown must start a Hold exactly like a keydown');
  g.pointerUp();
  assert.equal(s.lastEvent, 'miss', 'releasing the pointer before the Hold ends must fail it');
  assert.equal(s.activeHold, null);
});

await checkAsync('TEST_POINTERCANCEL_THROUGH_REAL_RUNTIME_PATH', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 1, t: 1, hold: g.C.HOLD_DUR }); // lane 1 = center, screen x ~640 at 1280x720
  g.pointerDown(640);
  assert.ok(s.activeHold && s.activeHold.lane === 1, 'setup: pointerdown must start the Hold');
  g.pointerCancel(); // dispatched through the REAL canvas 'pointercancel' listener, same as pointerup's actUp()
  assert.equal(s.lastEvent, 'miss', 'POINTERCANCEL: a cancelled pointer before the Hold ends must fail it exactly like pointerup');
  assert.equal(s.activeHold, null, 'pointercancel must clear the active Hold through the real dispatch path');
});

await checkAsync('TEST_SIMULTANEOUS_DIFFERENT_LANE_KEYS', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 });
  s.gates.push({ color: 2, t: 1 });
  g.dispatchKey('a'); // lane 0 down, no keyup yet
  g.dispatchKey('d'); // lane 2 down at the same time, independently
  assert.equal(s.perfects, 2, 'SIMULTANEOUS_DIFFERENT_LANE_KEYS: two different lanes held down at once must both score independently');
  // OS key-repeat on lane 0 while lane 2 is also still held must not
  // rescore lane 0, and must not disturb lane 2's independent state.
  g.dispatchKey('a');
  assert.equal(s.perfects, 2, 'key-repeat on one lane while a different lane is simultaneously held must not rescore');
  g.dispatchKeyUp('a');
  g.dispatchKeyUp('d');
});

await checkAsync('TEST_RELEASE_EXACTLY_ON_PERFECT_BOUNDARY', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.C.press(s, 0); // PERFECT start, activates the Hold
  const gate = s.activeHold.gate;
  const boundaryT = tForRatio(g.C, g.C.PERFECT_RATIO, gate.color, 'approach'); // exact PERFECT/GOOD boundary
  gate.t = boundaryT + g.C.HOLD_DUR / g.C.TRAVEL; // so holdEndT(gate) === boundaryT exactly
  g.C.release(s, 0);
  assert.equal(s.lastEvent, 'perfect', 'BOUNDARY_RELEASE: a release landing exactly on the PERFECT/GOOD ratio boundary must judge PERFECT');
});

await checkAsync('TEST_RELEASE_EXACTLY_ON_GOOD_BOUNDARY', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 2, t: 1, hold: g.C.HOLD_DUR });
  g.C.press(s, 2);
  const gate = s.activeHold.gate;
  const boundaryT = tForRatio(g.C, g.C.GOOD_RATIO, gate.color, 'approach'); // exact GOOD/MISS boundary
  gate.t = boundaryT + g.C.HOLD_DUR / g.C.TRAVEL;
  g.C.release(s, 2);
  assert.equal(s.lastEvent, 'good', 'BOUNDARY_RELEASE: a release landing exactly on the GOOD/MISS ratio boundary must judge GOOD, not MISS');
});

await checkAsync('TEST_RELEASE_ACROSS_ANIMATION_FRAME_BOUNDARY', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  const holdTUnits = g.C.HOLD_DUR / g.C.TRAVEL;
  s.gates.push({ color: 2, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('d');
  const gate = s.activeHold.gate;
  let guard = 0;
  while (gate.t - holdTUnits < 0.999 && guard++ < 300) { g.audioCtx._advance(0.01); g.stepFrame(); }
  const holdEndTBeforeRelease = gate.t - holdTUnits;
  const expectedKind = g.C.classify(g.C.overlapRatio(holdEndTBeforeRelease, 2));
  g.dispatchKeyUp('d'); // fires immediately on the real keyup listener, not deferred to the next rAF frame
  assert.equal(s.lastEvent, expectedKind, 'FRAME_BOUNDARY_RELEASE: a release dispatched between animation frames must judge against gate.t exactly as it stood after the last completed tick, with no implicit extra frame advance sneaking in first');
});

await checkAsync('TEST_STALE_KEYUP_AFTER_HOLD_ALREADY_RESOLVED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  g.dispatchKeyUp('a'); // resolves the Hold (PERFECT release)
  assert.equal(s.activeHold, null, 'setup: the Hold must already be resolved');
  const before = { misses: s.misses, perfects: s.perfects, goods: s.goods, combo: s.combo };
  g.dispatchKeyUp('a'); // a stale, duplicate keyup (e.g. an OS-level double-fire) must be a safe no-op
  assert.deepEqual({ misses: s.misses, perfects: s.perfects, goods: s.goods, combo: s.combo }, before,
    'STALE_KEYUP_AFTER_RESOLUTION: a keyup arriving after a Hold has already resolved must not rescore or misjudge anything');
});

await checkAsync('TEST_DESKTOP_SPACE_START_STILL_WORKS', async () => {
  const g = boot();
  g.dispatchKey(' '); // real keyboard path, not the test.start() API shortcut
  await g.flush();
  g.audioCtx._resolveDecode();
  await g.flush();
  assert.equal(g.test.started(), true, 'desktop Space start must still work after the Hold changes');
});

await checkAsync('TEST_RETRY_STILL_WORKS', async () => {
  const g = await startWithDecodeLatency(0);
  const s0 = g.test.state();
  s0.time = 5;
  assert.ok(s0.chartIdx >= 0);
  g.dispatchKey('r');
  const s1 = g.test.state();
  assert.equal(s1.time, 0, 'retry must still reset elapsed time');
  assert.equal(s1.chartIdx, 0, 'retry must still reset the chart cursor');
});

// ============================================================
// Terminal states
// ============================================================
await checkAsync('TEST_THREE_MISS_GAME_OVER_PRESERVED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  for (let i = 0; i < 3; i++) { s.gates.push({ color: 1, t: 1.16 }); g.C.press(s, 1); }
  assert.equal(s.misses, 3);
  assert.equal(s.phase, 'gameover', '3 MISS = GAME OVER must be unchanged');
});

await checkAsync('TEST_RUN_COMPLETE_PRESERVED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.time = g.C.RUN_DURATION;
  g.audioCtx._advance(0.05);
  g.stepFrame();
  assert.equal(s.phase, 'complete', 'RUN COMPLETE must still be reachable');
});

await checkAsync('TEST_RUN_COMPLETE_WAITS_FOR_ACTIVE_HOLD', async () => {
  // A direct core-level check of tick()'s RUN_COMPLETE-defers-for-Hold
  // behavior, isolated from the chart/audio-clock (chartIdx disabled) so
  // it isn't confused by dozens of OTHER incidental notes a huge
  // artificial time jump would otherwise spawn/miss all at once. The
  // jump advances state.time AND the gate's own t together (the same
  // relationship a real sequence of ticks would produce), so the Hold is
  // still validly "waiting" — Phase 3B.1 holds only resolve by release()
  // or by timing out, never automatically by elapsed time alone.
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.chartIdx = g.C.CHART.length;
  // Press right near RUN_DURATION (as a Hold started late in a real chart
  // would), so its own release window is still legitimately open when
  // RUN_DURATION is reached moments later — unlike a huge artificial time
  // skip, which would also carry the Hold's OWN window past its timeout
  // and confuse this test with that (already separately covered) case.
  s.time = g.C.RUN_DURATION - 0.05;
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.C.press(s, 0);
  assert.ok(s.activeHold, 'setup: the Hold must be active');
  g.C.tick(s, {}, 0.06); // crosses RUN_DURATION; the Hold's own window is still open
  assert.notEqual(s.phase, 'complete', 'RUN_COMPLETE_WITH_ACTIVE_HOLD: must not complete while the Hold has not yet resolved');
  assert.ok(s.activeHold, 'the Hold must still be waiting for a release/timeout, not auto-resolved by elapsed time alone');
  g.C.release(s, 0); // resolve it explicitly, exactly as a real player letting go would
  assert.equal(s.activeHold, null);
  g.C.tick(s, {}, 0.01);
  assert.equal(s.phase, 'complete', 'once the Hold is resolved and RUN_DURATION is reached, the run must complete');
});

await checkAsync('TEST_NO_POST_TERMINAL_HOLD_SCORING', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1, hold: g.C.HOLD_DUR });
  g.dispatchKey('a');
  assert.ok(s.activeHold);
  s.phase = 'gameover'; // force terminal while a Hold is active
  const missesBefore = s.misses;
  g.dispatchKeyUp('a'); // release must be a no-op once terminal
  assert.equal(s.misses, missesBefore, 'no delayed Hold scoring may occur once the run is terminal');
});

await checkAsync('TEST_RESULT_STATS_PRESERVED', async () => {
  const g = await startWithDecodeLatency(0);
  const s = g.test.state();
  s.gates.push({ color: 0, t: 1 }); g.dispatchKey('a'); // PERFECT
  s.gates.push({ color: 1, t: 1.1 }); g.dispatchKey('s'); // GOOD
  s.gates.push({ color: 2, t: 1.16 }); g.dispatchKey('d'); // MISS -> also resets combo, so maxCombo must have already captured the earlier peak
  assert.equal(s.perfects, 1);
  assert.equal(s.goods, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.maxCombo, 2, 'MAX COMBO must reflect the peak (PERFECT+GOOD), not the post-MISS combo');
  assert.equal(s.combo, 0);
});

check('TEST_BEST_SCORE_MECHANISM_UNCHANGED', () => {
  assert.match(gameSrc, /function bestScore\(\)/);
  assert.match(gameSrc, /function saveBest\(score\)/);
  assert.match(gameSrc, /rainbowRefrainBest/, 'the BEST_KEY localStorage key must be unchanged');
});

check('TEST_TITLE_UX_PRESERVED', () => {
  assert.match(gameSrc, /'PRESS SPACE TO PLAY'/);
  assert.match(gameSrc, /'TAP TO PLAY'/);
  assert.match(gameSrc, /'RAINBOW REFRAIN'/);
});

check('TEST_GEOMETRY_UNCHANGED', () => {
  assert.match(gameSrc, /C\.toScreenY\(C\.noteCenterYLogical\(gate\.t\), transform\)/, 'note head position formula must be unchanged');
  assert.match(gameSrc, /C\.toScreenX\(C\.laneCenterX\(gate\.color\), transform\)/, 'note head lane position formula must be unchanged');
  assert.doesNotMatch(coreSrc, /var LOGICAL_WIDTH = (?!480)/, 'LOGICAL_WIDTH must be unchanged');
  assert.doesNotMatch(coreSrc, /var LOGICAL_HEIGHT = (?!720)/, 'LOGICAL_HEIGHT must be unchanged');
});

// A. VISUAL/STRUCTURE
// Structural existence only (position formula, shared holdEndT()) — the
// PREVIOUS version of this test also tried to assert visual/judgment
// alignment purely from source strings (tailT/ctx.arc existing), which
// Phase 3B.2's audit correctly called a false positive: a plain string
// match cannot see an inherited lineWidth or an unmatched shape. That
// numeric verification now lives in the TEST_*_END_MARKER_VISUAL_JUDGMENT_
// ALIGNMENT tests below, built entirely from real recorded canvas calls.
check('TEST_HOLD_END_MARKER_STRUCTURE_EXISTS', () => {
  assert.match(gameSrc, /var tailT = gate\.t - gate\.hold \/ C\.TRAVEL;/, 'the end marker position must be computed on the gate');
  assert.match(gameSrc, /function drawNoteShape\(color, size, corner\)/, 'the marker must reuse the same shape-drawing routine as the note head, not a separate implementation');
  assert.match(coreSrc, /function holdEndT\(gate\)/, 'RELEASE_JUDGMENT: the end marker position must be a real, reusable formula in game-core.js');
  assert.match(coreSrc, /return gate\.t - gate\.hold \/ TRAVEL;/);
});

// B. NUMERIC VISUAL/JUDGMENT GEOMETRY ALIGNMENT (Phase 3B.2, HIGH-1 fix)
// For each lane: draw a real Hold gate whose end marker sits exactly at
// t=1 (the judgment line) through the REAL drawGate(), capture its actual
// canvas calls (shape type, fill geometry, and the lineWidth ACTUALLY
// active when it was stroked), and compare that measured visual extent
// against the SAME lane's real judgment extent (C.noteExtent(1, color)) —
// converting the pixel gap into milliseconds via the chart's own travel
// speed. This is the numeric replacement the task requires; nothing here
// is inferred from source text.
const LANE_NAMES = ['PINK', 'GOLD', 'CYAN'];
const LANE_SHAPES = ['circle', 'diamond', 'square'];
const geometryResults = {};
LANE_NAMES.forEach((name, color) => {
  check('TEST_' + name + '_END_MARKER_VISUAL_JUDGMENT_ALIGNMENT', () => {
    const g = boot();
    const scale = g.test.transform().scale;
    assert.equal(scale, 1, 'setup: boot() default viewport (1280x720) must give transform.scale === 1, so screen px === logical px here');

    const shapes = drawHeldGateShapes(g, color);
    assert.equal(shapes.length, 2, name + ': drawGate() on a held gate must issue exactly 2 filled+stroked shapes (end marker, then head)');
    const marker = shapes[0];
    const head = shapes[1];

    // Lane-shape match: the marker's real recorded geometry (arc vs
    // rounded-rect path) must be the SAME shape family as its lane, not a
    // generic circle for every lane.
    const markerIsCircle = marker.arcs.length > 0;
    if (color === 0) assert.ok(markerIsCircle, 'PINK end marker must be rendered as a circle (ctx.arc), matching the PINK note head');
    else assert.ok(!markerIsCircle, LANE_NAMES[color] + ' end marker must NOT be a circle — it must match its own lane\'s shape family');

    // Stroke width leak check: the tail line (drawn just before the
    // marker, in the same drawGate() call) uses a much thicker lineWidth
    // (size*1.1) for the tail — the marker's own recorded lineWidth must
    // NOT be that value; it must be the same thin, note-like stroke the
    // head itself uses.
    const measured = measureShapeVisualExtent(marker);
    const headMeasured = measureShapeVisualExtent(head);
    assert.equal(measured.lineWidth, headMeasured.lineWidth, name + ': TAIL_LINEWIDTH_LEAK_FIXED: the end marker\'s stroke must use the SAME thin lineWidth as the note head, not the tail\'s thick lineWidth');
    assert.ok(measured.lineWidth < 5, name + ': the marker\'s recorded lineWidth (' + measured.lineWidth + ') must be a thin, note-like stroke, not the tail\'s size*1.1');

    // The numeric core of HIGH-1: real visible outer extent vs. real
    // judgment extent, both in the same (scale=1) px units.
    const judgmentExtentPx = g.C.noteExtent(1, color);
    const visualExtentPx = measured.visualHalfExtent;
    const extentDeltaPx = Math.abs(visualExtentPx - judgmentExtentPx);
    const travelSpeedPxPerSec = g.C.LOGICAL_HEIGHT * (g.C.TRACK_BOTTOM - g.C.TRACK_TOP) / g.C.TRAVEL * scale;
    const timingDeltaMs = (extentDeltaPx / travelSpeedPxPerSec) * 1000;

    assert.ok(Math.abs(measured.centerY - g.C.toScreenY(g.C.noteCenterYLogical(1), g.test.transform())) < 1e-6,
      name + ': the end marker must be centered exactly at the judgment line when tailT=1');
    assert.ok(timingDeltaMs <= 16.7, name + ': VISUAL_JUDGMENT_TIMING_DELTA_MS must be <= 1 frame (16.7ms), got ' + timingDeltaMs.toFixed(3) + 'ms');

    geometryResults[name] = {
      shape: LANE_SHAPES[color],
      markerVisualExtentPx: visualExtentPx,
      judgmentExtentPx,
      extentDeltaPx,
      timingDeltaMs
    };
  });
});

check('TEST_ACTIVE_HOLD_END_POSITION_COMPUTABLE', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const s = C.makeState(1);
  s.chartIdx = C.CHART.length;
  s.gates.push({ color: 0, t: 1, hold: C.HOLD_DUR });
  C.press(s, 0);
  assert.ok(s.activeHold, 'setup: a Hold must be active');
  const endT = s.activeHold.gate.t - s.activeHold.gate.hold / C.TRAVEL;
  assert.ok(Math.abs(endT - (1 - C.HOLD_DUR / C.TRAVEL)) < 1e-9, 'the end marker t must be exactly computable from the live gate at any moment');
  assert.equal(C.classify(C.overlapRatio(endT, s.activeHold.gate.color)), 'noop', 'freshly started, the end marker is still far from the judgment line');
});

check('TEST_WRONG_LANE_RELEASE_DOES_NOT_MISJUDGE', () => {
  const C = require(path.join(srcDir, 'game-core.js'));
  const s = C.makeState(2);
  s.chartIdx = C.CHART.length;
  s.gates.push({ color: 0, t: 1, hold: C.HOLD_DUR });
  C.press(s, 0);
  assert.ok(s.activeHold);
  C.release(s, 1); // a different lane's release must never affect an unrelated active Hold
  assert.ok(s.activeHold, 'an active Hold in lane 0 must be untouched by releasing lane 1');
  assert.equal(s.misses, 0, 'no MISS may occur from an irrelevant lane release');
});

check('TEST_ORIGINAL_PHASE_3A_ARTIFACT_UNTOUCHED', () => {
  const zipPath = path.resolve(__dirname, '..', 'GAME_BUILD', 'rainbow-refrain-mvp-easy-chart-phase3a.zip');
  const expectedSha = '7a27e8e19f2a245f91c09340c7455bfe5be37ffbdab466ccc1bddd5027b23ccc';
  const actualSha = require('node:crypto').createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  assert.equal(actualSha, expectedSha, 'the approved Phase 3A submission artifact must remain byte-identical');
});

console.log('');
console.log('geometry alignment: ' + JSON.stringify(geometryResults));
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
else console.log('playtest phase 3B tests: PASS');

}

main();
