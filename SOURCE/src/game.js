(function() {
  'use strict';
  var C = globalThis.RainbowRefrainCore;
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d', { alpha: false });
  var scoreEl = document.getElementById('score');
  var comboEl = document.getElementById('combo');
  var missesEl = document.getElementById('misses');
  var stateEl = document.getElementById('state');
  var statusEl = document.getElementById('status');
  var state;
  var width = 1;
  var height = 1;
  var dpr = 1;
  // Single source of truth for logical->real projection, recomputed
  // alongside width/height in resize(). Every piece of gameplay geometry —
  // lane spacing, target radius, note size, diamond corner radius, track
  // span, unicorn anchor — is expressed in LOGICAL units in game-core.js
  // and projected through this ONE transform, so none of them can drift
  // out of proportion with each other on any aspect ratio (the previous
  // bug: lane spacing was capped in raw real pixels by width while target
  // radius scaled with height, so a tall/narrow viewport let adjacent
  // judgment circles overlap). Pointer/touch mapping projects the other
  // direction through the SAME transform (see laneFromPointer), so a tap
  // on a visible lane always resolves to that lane regardless of aspect
  // ratio or letterbox margins.
  var transform = { scale: 1, offsetX: 0, offsetY: 0 };
  var last = performance.now();
  var audio;
  var flash = 0;
  var seed = 20260823;
  var statusTimer;
  // Judgment events are queued, not just watched as a single "last" value:
  // a MISS immediately followed by GAME OVER (the third miss) are two
  // distinct events that must each get their own visible turn, in order.
  var pending = [];
  var busy = false;
  var started = false; // title screen until PLAY; frame() gates ticking on this
  var touch = 'ontouchstart' in globalThis; // picks the title's start-input mode

  var BEST_KEY = 'rainbowRefrainBest';
  function bestScore() {
    try { return +localStorage.getItem(BEST_KEY) || 0; } catch (e) { return 0; }
  }
  function saveBest(score) {
    try { if (score > bestScore()) localStorage.setItem(BEST_KEY, score); } catch (e) {}
  }

  globalThis.RainbowRefrainWavedash.init();

  function resize() {
    dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    width = Math.max(1, innerWidth);
    height = Math.max(1, innerHeight);
    transform = C.computeTransform(width, height);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function reset() {
    state = C.makeState(seed);
    flash = 0;
    pending.length = 0;
    busy = false;
    clearTimeout(statusTimer);
    statusEl.className = '';
    statusEl.textContent = '';
    syncHud();
    mStop();
    if (started && audio) { mO = audio.currentTime + .05; mI = 0; mLoop(); }
  }

  function start() {
    started = true;
    ensureAudio();
    reset();
  }

  function drawTitle() {
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#fff';
    ctx.font = '800 ' + (width * .08) + 'px system-ui,sans-serif';
    ctx.fillText('RAINBOW REFRAIN', width / 2, height * .3);
    ctx.fillStyle = '#ffd447';
    ctx.font = '700 ' + (width * .04) + 'px system-ui,sans-serif';
    ctx.fillText(touch ? 'TAP TO PLAY' : 'PRESS SPACE TO PLAY', width / 2, height * .44);
    ctx.fillStyle = '#dce8ff';
    ctx.font = '600 14px system-ui,sans-serif';
    ctx.fillText(touch ? 'TAP LANES' : 'A S D = LANES', width / 2, height * .5);
    ctx.shadowBlur = 0;
  }

  function ensureAudio() {
    if (!audio) {
      var AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC) audio = new AC();
    }
    if (audio && audio.state === 'suspended') audio.resume();
  }

  // Procedural music; step time = mO + mI*STEP (fixed origin, no drift).
  var BPM = 132, BEAT = 60 / BPM, STEP = BEAT / 2;
  var SCALE = [0, 3, 5, 7, 10, 12];
  var PATTERN = [0, 2, 4, 2, 5, 4, 2, 0];
  var mT, mI, mO, mA = [];

  function mn(f, t0, d, ty, v) {
    var o = audio.createOscillator(), g = audio.createGain();
    o.type = ty;
    o.frequency.setValueAtTime(f, t0);
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + d);
    o.connect(g).connect(audio.destination);
    o.start(t0);
    o.stop(t0 + d);
    mA.push(o);
  }

  function mLoop() {
    while (mO + mI * STEP < audio.currentTime) mI++; // late callback: skip past steps, keep grid phase
    for (var i = 0; i < 4; i++) {
      var s = mI % 8, t0 = mO + mI * STEP;
      if (s % 2 === 0) mn(110, t0, STEP * .9, 'triangle', .05);
      mn(220 * Math.pow(2, SCALE[PATTERN[s]] / 12), t0, STEP * .7, 'square', .03);
      mI++;
    }
    mT = setTimeout(mLoop, (mO + mI * STEP - audio.currentTime - .05) * 1000);
  }

  // Cancels the timer and every scheduled source, so retry can't overlap.
  function mStop() {
    clearTimeout(mT);
    mA.forEach(o => { try { o.stop() } catch (e) {} });
    mA = [];
  }
  function mChk() { if (state.phase !== 'run') mStop(); } // stop the instant state goes terminal

  function tone(kind, color) {
    ensureAudio();
    if (!audio) return;
    var now = audio.currentTime;
    var osc = audio.createOscillator();
    var gain = audio.createGain();
    var tones = [330, 440, 550];
    var isHit = kind === 'perfect' || kind === 'good';
    var freq = isHit ? tones[color % 3] + (state.combo % 4) * 22 : kind === 'miss' ? 110 : 72;
    osc.type = isHit ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freq, now);
    if (kind === 'perfect') osc.frequency.exponentialRampToValueAtTime(freq * 1.45, now + .09);
    else if (kind === 'good') osc.frequency.exponentialRampToValueAtTime(freq * 1.16, now + .07);
    gain.gain.setValueAtTime(.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === 'perfect' ? .09 : kind === 'good' ? .06 : .07, now + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, now + (kind === 'gameover' ? .24 : .12));
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + (kind === 'gameover' ? .25 : .13));
  }

  function stats() {
    return 'PERFECT ' + state.perfects + ' · GOOD ' + state.goods + '<br>MISS ' + state.misses + ' · MAX COMBO ' + state.maxCombo;
  }

  function displayEvent(name) {
    clearTimeout(statusTimer);
    if (name === 'perfect') {
      flash = 1;
      tone('perfect', state.lane);
      statusEl.innerHTML = '<b>PERFECT</b>' + state.combo;
      statusEl.className = 'show';
      busy = true;
      statusTimer = setTimeout(advanceQueue, 550);
    } else if (name === 'good') {
      flash = .55;
      tone('good', state.lane);
      statusEl.innerHTML = '<b>GOOD</b>' + state.combo;
      statusEl.className = 'show';
      busy = true;
      statusTimer = setTimeout(advanceQueue, 550);
    } else if (name === 'miss') {
      flash = -.7;
      tone('miss');
      statusEl.innerHTML = '<b>MISS</b>' + (C.MISS_LIMIT - state.misses) + ' left';
      statusEl.className = 'show';
      busy = true;
      statusTimer = setTimeout(advanceQueue, 550);
    } else if (name === 'gameover') {
      flash = -.9;
      tone('gameover');
      statusEl.innerHTML = '<b>GAME OVER</b><small>' + stats() + '<br>Press R or tap to ride again</small>';
      statusEl.className = 'show';
      busy = false; // terminal: stays visible until restart, nothing left to queue
    } else if (name === 'complete') {
      var best = Math.max(state.score, bestScore());
      saveBest(state.score);
      flash = 0;
      statusEl.innerHTML = '<b>RUN COMPLETE</b><small>SCORE ' + state.score + ' · BEST ' + best + '<br>' + stats() + '<br>R to retry</small>';
      statusEl.className = 'show';
      busy = false;
    }
  }

  // Fires when a timed status (PERFECT/GOOD/MISS) finishes its natural
  // on-screen duration: shows the next queued judgment immediately if one
  // is waiting (this is how MISS #3 and GAME OVER both get their own turn
  // instead of GAME OVER silently overwriting MISS), otherwise just clears.
  function advanceQueue() {
    busy = false;
    if (pending.length) showNext();
    else statusEl.className = '';
  }

  function showNext() {
    var ev = pending.shift();
    busy = true;
    displayEvent(ev.name);
  }

  function handleEvent() {
    while (state.events.length) pending.push(state.events.shift());
    if (!busy && pending.length) showNext();
  }

  function syncHud() {
    scoreEl.textContent = state.score;
    comboEl.textContent = state.combo;
    missesEl.textContent = state.misses + ' / ' + C.MISS_LIMIT;
    stateEl.textContent = state.phase === 'run' ? 'RUN' : state.phase === 'complete' ? 'DONE' : 'OVER';
  }

  function roundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground(t) {
    var hue = (t * 11) % 360;
    var g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, 'hsl(' + hue + ',72%,16%)');
    g.addColorStop(.5, 'hsl(' + ((hue + 55) % 360) + ',70%,10%)');
    g.addColorStop(1, 'hsl(' + ((hue + 145) % 360) + ',75%,8%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = .18;
    for (var i = 0; i < 7; i++) {
      ctx.strokeStyle = C.COLORS[i % 3];
      ctx.lineWidth = 18 + i * 2;
      ctx.beginPath();
      ctx.arc(width * (.12 + i * .15), height * .72, height * (.3 + i * .018), Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  var LANE_KEYS = ['A', 'S', 'D'];

  function drawTrack() {
    var top = C.toScreenY(C.LOGICAL_HEIGHT * C.TRACK_TOP, transform);
    var bottom = C.toScreenY(C.LOGICAL_HEIGHT * C.TRACK_BOTTOM, transform);
    ctx.textAlign = 'center';
    ctx.font = '700 13px system-ui,sans-serif';
    for (var i = 0; i < 3; i++) {
      var x = C.toScreenX(C.laneCenterX(i), transform);
      ctx.strokeStyle = C.COLORS[i] + '77';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillStyle = C.COLORS[i] + '1c';
      ctx.beginPath();
      ctx.arc(x, bottom, C.TARGET_RADIUS * transform.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.COLORS[i];
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4;
      ctx.fillText(LANE_KEYS[i], x, top - 8);
      ctx.shadowBlur = 0;
    }
  }

  function drawGate(gate) {
    // Position reads the SAME logical function overlapRatio() judges
    // against (C.noteCenterYLogical), projected through the shared
    // transform — rendering and judgment can no longer independently
    // drift, because there is only one copy, owned by game-core.js.
    // Position tracks gate.t directly, unclamped, so the note keeps moving
    // through and past the judgment line at constant speed instead of
    // freezing there. `size` is the BASE size (before any per-shape
    // correction) scaled by the SAME uniform transform.scale as the
    // target radius and lane spacing — the same base size
    // C.noteExtent(t, color) derives the diamond's true (larger) judgment
    // extent from, without changing what any shape actually looks like.
    // `corner` scales the diamond/square corner radius by that same
    // factor too: it previously stayed a raw, unscaled 5px regardless of
    // viewport, so the rendered diamond only matched its judged extent at
    // the one reference height where the (then-height-only) scale was 1.
    var y = C.toScreenY(C.noteCenterYLogical(gate.t), transform);
    var x = C.toScreenX(C.laneCenterX(gate.color), transform);
    var size = C.noteBaseSize(gate.t) * transform.scale;
    var corner = C.SHAPE_CORNER_RADIUS * transform.scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = C.COLORS[gate.color];
    ctx.shadowBlur = 18;
    ctx.fillStyle = C.COLORS[gate.color];
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    if (gate.color === 0) {
      ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (gate.color === 1) {
      ctx.rotate(Math.PI / 4); roundedRect(-size * C.DIAMOND_SCALE, -size * C.DIAMOND_SCALE, size * C.DIAMOND_SCALE * 2, size * C.DIAMOND_SCALE * 2, corner); ctx.fill(); ctx.stroke();
    } else {
      roundedRect(-size, -size, size * 2, size * 2, corner); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawUnicorn(t) {
    var x = C.toScreenX(C.laneCenterX(state.lane), transform);
    // Base position matches C.TRACK_BOTTOM exactly: the unicorn is the
    // player's natural visual reference for "the target," and it used to
    // sit ~1% of screen height above the actual judgment center — close
    // enough to look right but not close enough for a precise center-hit
    // check. The small wobble is cosmetic and doesn't affect judgment; it
    // scales with transform.scale like everything else so it stays
    // proportionate to the rest of the (now uniformly-scaled) geometry.
    var y = C.toScreenY(C.LOGICAL_HEIGHT * C.TRACK_BOTTOM, transform) + Math.sin(t * 9) * 3 * transform.scale;
    var s = 42 * transform.scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#161b3f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, s * .9, s * .55, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.arc(s * .7, -s * .28, s * .38, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.COLORS[(state.combo + 1) % 3];
    ctx.beginPath();
    ctx.moveTo(s * .84, -s * .52); ctx.lineTo(s * 1.35, -s * .68); ctx.lineTo(s * 1.02, -s * .25); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = C.COLORS[(state.combo + 2) % 3];
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(-s * .7, -s * .2, s * .55, Math.PI * .7, Math.PI * 1.8); ctx.stroke();
    ctx.restore();
  }

  function draw(t) {
    drawBackground(t);
    drawTrack();
    for (var i = 0; i < state.gates.length; i++) drawGate(state.gates[i]);
    drawUnicorn(t);
    if (flash) {
      ctx.fillStyle = flash > 0 ? '#ffffff22' : '#16203d55';
      ctx.fillRect(0, 0, width, height);
      flash *= .9;
      if (Math.abs(flash) < .02) flash = 0;
    }
  }

  // Codex re-audit: this previously split the FULL raw canvas width into
  // three equal thirds, but the rendered lane group only ever occupies a
  // narrow, centered band (LANE_GAP either side of center) — at every
  // required viewport, all three visible lane centers fell inside the
  // single middle third, so any tap anywhere resolved to lane 1. Fixed by
  // going through the SAME transform rendering uses: project the tap into
  // logical space, then take the nearest logical lane center — the
  // authoritative shared geometry in game-core.js, not a duplicated
  // formula here.
  function laneFromPointer(e) {
    var r = canvas.getBoundingClientRect();
    var logicalX = C.toLogicalX(e.clientX - r.left, transform);
    return C.laneFromLogicalX(logicalX);
  }

  function act(e) {
    ensureAudio();
    if (!started) { if (touch) start(); return; }
    if (state.phase !== 'run') { reset(); return; }
    if (e.type === 'pointerdown') C.press(state, laneFromPointer(e));
    mChk();
  }

  addEventListener('resize', resize);
  addEventListener('keydown', function(e) {
    if (!started) {
      if (!touch && e.key === ' ') { e.preventDefault(); start(); }
      return;
    }
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); reset(); return; }
    if (state.phase !== 'run') return;
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); C.press(state, 0); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); C.press(state, 1); }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); C.press(state, 2); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); C.move(state, -1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); C.move(state, 1); }
    mChk();
    ensureAudio();
  });
  canvas.addEventListener('pointerdown', act);

  function frame(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (started) {
      C.tick(state, {}, dt);
      mChk();
      handleEvent();
      syncHud();
      draw(state.time);
    } else {
      drawBackground(now / 1000);
      drawUnicorn(now / 1000);
      drawTitle();
    }
    requestAnimationFrame(frame);
  }

  resize();
  reset();
  requestAnimationFrame(frame);

  // Test-only seam: no-op in a normal page load, since nothing pre-declares
  // globalThis.__RRR_TEST__. Lets a harness inspect/drive the SAME live
  // state and the SAME draw() used every real frame, instead of a test
  // re-implementing rendering/reset logic in parallel.
  if (globalThis.__RRR_TEST__) {
    globalThis.__RRR_TEST__.state = function() { return state; };
    globalThis.__RRR_TEST__.draw = draw;
    globalThis.__RRR_TEST__.drawGate = drawGate;
    globalThis.__RRR_TEST__.drawUnicorn = drawUnicorn;
    globalThis.__RRR_TEST__.frame = frame;
    globalThis.__RRR_TEST__.reset = reset;
    globalThis.__RRR_TEST__.transform = function() { return transform; };
    globalThis.__RRR_TEST__.laneFromPointer = laneFromPointer;
    globalThis.__RRR_TEST__.start = start;
    globalThis.__RRR_TEST__.started = function() { return started; };
    globalThis.__RRR_TEST__.music = { bpm: BPM, beat: BEAT, step: STEP, t: () => mT };
  }
})();
