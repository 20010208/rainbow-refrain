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
  // Phase 3C/3D: difficulty is chosen on the title screen (default EASY,
  // per spec) and only ever changed while !started — beginRun() reads it
  // into C.setDifficulty() right before reset(), so it is locked for the
  // whole run and, since this variable itself is untouched by beginRun(),
  // automatically preserved across a retry (no special-casing needed).
  // C.DIFFICULTIES (['easy','normal','hard']) is the single authoritative
  // ordered list — shared with game-core.js's own setDifficulty(), so the
  // selector's order can never drift from what CHARTS actually contains.
  var selectedDifficulty = 'easy';
  function setSelectedDifficulty(name) {
    if (started) return; // DIFFICULTY_LOCKED_DURING_RUN
    selectedDifficulty = C.DIFFICULTIES.indexOf(name) >= 0 ? name : 'easy';
  }
  // Phase 3D (Codex-style redesign for a 3rd item): the old 2-item TOGGLE
  // no longer applies — with 3 items, "move" is real directional
  // wrap-around through the ordered list, never clamping at either end.
  // ArrowUp/ArrowLeft move backward (dir=-1), ArrowDown/ArrowRight move
  // forward (dir=+1); wrapping is plain modulo arithmetic (with a
  // + length before % to keep the result non-negative for dir=-1).
  function moveSelectedDifficulty(dir) {
    if (started) return;
    var n = C.DIFFICULTIES.length;
    var idx = C.DIFFICULTIES.indexOf(selectedDifficulty);
    idx = (idx + (dir < 0 ? -1 : 1) + n) % n;
    selectedDifficulty = C.DIFFICULTIES[idx];
  }
  // Explicit held-key state (Phase 3B Hold notes): a lane's key/pointer is
  // "held" or not, tracked here rather than trusted from event.repeat, so
  // OS key-repeat can never re-trigger C.press() for a lane already down,
  // and a real release always maps back to the SAME lane it started on.
  var heldKey = [false, false, false];
  var heldPointerLane = -1;

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
    // Phase 3D.2: explicitly clears innerHTML too (not just textContent) —
    // real DOM's textContent setter already clears any innerHTML-rendered
    // content as a side effect, but being explicit here means a retry can
    // never leave a stale judgment/result popup showing regardless of
    // that implicit link, and it costs nothing.
    statusEl.textContent = '';
    statusEl.innerHTML = '';
    syncHud();
    mStop();
    // A physically-held key/pointer surviving a retry must not silently
    // block (or misattribute) input in the new run.
    heldKey[0] = heldKey[1] = heldKey[2] = false;
    heldPointerLane = -1;
  }

  // Compact touch hit-regions for the difficulty selector, in the SAME
  // raw canvas-CSS-pixel space drawTitle() already positions its text in
  // (width/height fractions — the title screen has never used the
  // logical gameplay transform, so hit-testing stays in that same simple
  // space rather than introducing a second coordinate system just for
  // this). A tap anywhere in the band selects whichever half it's on;
  // it deliberately does NOT also start the run, so a mis-tap while
  // choosing never accidentally launches the wrong difficulty.
  // Phase 3D: generalized to C.DIFFICULTIES.length equal columns (was a
  // hardcoded left/right half for exactly 2 items) — a tap resolves to
  // whichever column it falls in, in C.DIFFICULTIES' own order, so the
  // selector and its hit-testing can never drift apart regardless of how
  // many difficulties exist.
  var DIFF_BAND_Y0_FRAC = .60, DIFF_BAND_Y1_FRAC = .70;
  function difficultyTapHit(clientLocalX, clientLocalY) {
    if (clientLocalY < height * DIFF_BAND_Y0_FRAC || clientLocalY > height * DIFF_BAND_Y1_FRAC) return null;
    var n = C.DIFFICULTIES.length;
    var idx = Math.floor(clientLocalX / (width / n));
    idx = Math.max(0, Math.min(n - 1, idx));
    return C.DIFFICULTIES[idx];
  }
  var DIFFICULTY_LABELS = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };

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
    // DIFFICULTY selector: compact, selected option visually distinct
    // (bright gold + a leading "> ") from the unselected ones (dim).
    // Columns are generated from C.DIFFICULTIES so a 3rd (or later 4th)
    // entry never needs a separate hand-written branch here.
    ctx.fillStyle = '#7d8bb0';
    ctx.font = '600 12px system-ui,sans-serif';
    ctx.fillText(touch ? 'DIFFICULTY (tap to choose)' : 'DIFFICULTY (↑↓ / ←→)', width / 2, height * .585);
    ctx.font = '800 ' + (width * .026) + 'px system-ui,sans-serif';
    var diffCount = C.DIFFICULTIES.length;
    for (var di = 0; di < diffCount; di++) {
      var diffName = C.DIFFICULTIES[di];
      var diffCx = width * ((di + .5) / diffCount);
      ctx.fillStyle = selectedDifficulty === diffName ? '#ffd447' : '#5b6a8f';
      ctx.fillText((selectedDifficulty === diffName ? '› ' : '') + DIFFICULTY_LABELS[diffName], diffCx, height * .655);
    }
    if (audioLoadError) {
      ctx.fillStyle = '#ff4f6a';
      ctx.font = '700 ' + (width * .032) + 'px system-ui,sans-serif';
      ctx.fillText(audioLoadError, width / 2, height * .74);
      ctx.fillStyle = '#dce8ff';
      ctx.font = '600 13px system-ui,sans-serif';
      ctx.fillText('Could not load/decode audio/track.wav — see console', width / 2, height * .79);
    }
    ctx.shadowBlur = 0;
  }

  function ensureAudio() {
    if (!audio) {
      var AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC) audio = new AC();
    }
    if (audio && audio.state === 'suspended') audio.resume();
  }

  // LOCAL PLAYTEST BUILD ONLY (Phase 3A.2): reference WAV playback and
  // gameplay/chart time now share ONE origin — audio.currentTime at the
  // moment the run actually begins — instead of gameplay starting
  // immediately on the user gesture while the WAV waited on an async
  // decode (Phase 3A.1's bug: decode latency silently became sync error,
  // since gameplay's rAF/performance.now() clock never knew to wait for
  // it). Decoding happens BEFORE the run is allowed to begin: requestStart
  // (the real gesture handler) only calls beginRun() once wavReady is
  // true, holding on the title screen meanwhile — a loading delay BEFORE
  // the run, never a hidden offset after it. Once begun, every frame's dt
  // is DERIVED from audio.currentTime - runOrigin (never accumulated from
  // performance.now()), so gameplay time is always exactly the audio
  // clock, and WAV/chart can only ever agree.
  var wavFetchPromise = fetch('audio/track.wav').then(function(r) {
    if (!r.ok) throw new Error('audio fetch failed: ' + r.status);
    return r.arrayBuffer();
  });
  var wavBuffer, wavReady = false, wavDecodePromise, pendingStart = false, runOrigin = 0, wavSrc;
  // Phase 3B.2: a rejected fetch or decodeAudioData() previously had no
  // .catch() anywhere — pendingStart would stay true forever with nothing
  // ever calling beginRun(), silently hanging the title screen with no
  // feedback. Now any failure sets audioLoadError (drawn on the title
  // screen every frame, so it survives independent of the status queue)
  // and logs to console — the successful path below is unchanged.
  var audioLoadError = null;

  function ensureWavDecoding() {
    if (!wavDecodePromise && audio) {
      wavDecodePromise = wavFetchPromise.then(function(buf) { return audio.decodeAudioData(buf); }).then(function(decoded) {
        wavBuffer = decoded;
        wavReady = true;
        if (pendingStart) beginRun();
      }).catch(function(err) {
        audioLoadError = 'AUDIO LOAD ERROR';
        pendingStart = false;
        console.error('Rainbow Refrain: failed to load/decode track.wav', err);
      });
    }
  }

  // The real Space/Tap gesture handler. If the WAV isn't decoded yet, the
  // run does not begin — gameplay/chart time must not exist before the
  // shared origin does.
  function requestStart() {
    ensureAudio();
    ensureWavDecoding();
    if (wavReady) beginRun();
    else pendingStart = true;
  }

  // Establishes the ONE shared origin for this run (start OR retry) and
  // immediately schedules the WAV from it — decode is already guaranteed
  // done by the time this ever runs, so no promise/await is needed here,
  // and a retry never re-decodes.
  function beginRun() {
    pendingStart = false;
    started = true;
    // Locks in whichever difficulty was selected on the title screen
    // (untouched by this function otherwise, so a retry naturally reuses
    // the SAME selection) — this must happen before reset()/makeState()
    // so the fresh state snapshots the correct difficulty and CHART is
    // already the right one before the first tick() ever runs.
    C.setDifficulty(selectedDifficulty);
    reset();
    runOrigin = audio.currentTime;
    wavSrc = audio.createBufferSource();
    wavSrc.buffer = wavBuffer;
    var g = audio.createGain();
    g.gain.value = .55; // below tone()'s SFX gains (.06-.09) so judgment feedback stays audible
    wavSrc.connect(g).connect(audio.destination);
    wavSrc.start(runOrigin + C.PRE_ROLL);
  }

  function mStop() {
    if (wavSrc) { try { wavSrc.stop(); } catch (e) {} wavSrc = null; }
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
    // Cheap, non-required addition (Phase 3C): tags the result with which
    // difficulty this run actually was, so an EASY/NORMAL playtest result
    // isn't ambiguous — everything else about the result screen is unchanged.
    return state.difficulty.toUpperCase() + '<br>PERFECT ' + state.perfects + ' · GOOD ' + state.goods + '<br>MISS ' + state.misses + ' · MAX COMBO ' + state.maxCombo;
  }

  // Phase 3D.3 (Codex BLOCKING FINDING 1 fix): the ONE trusted finalized-
  // result block, shared by BOTH terminal outcomes. Previously RUN
  // COMPLETE alone computed/showed SCORE and BEST alongside stats() — the
  // GAME OVER branch called stats() only, silently omitting SCORE and
  // BEST from a genuinely finalized run. There is nothing GAME-OVER-
  // specific about SCORE/BEST (state.score is exactly as final at GAME
  // OVER as it is at RUN COMPLETE — press()/release()/tick() never mutate
  // it again once phase leaves 'run'), so both terminal outcomes now
  // build their result text from this single function — the two can no
  // longer independently drift on what "finalized" means.
  function finalResultBlock() {
    var best = Math.max(state.score, bestScore());
    saveBest(state.score);
    return 'SCORE ' + state.score + ' · BEST ' + best + '<br>' + stats();
  }

  // Phase 3D.2 (transient judgment UI fix): takes the whole queued event
  // object, not just its name — ev.combo/ev.misses are the snapshot
  // fire() captured AT THE MOMENT this specific judgment was committed
  // (see game-core.js's fire()), so what's displayed always matches THIS
  // judgment even if it sat queued behind others (HARD's dense sections
  // can commit judgments faster than one every 550ms). Reading live
  // state.combo/state.misses here instead — the previous behavior — could
  // show a combo already reset by a LATER miss, or a misses-left count
  // already advanced past what was true for this judgment.
  function displayEvent(ev) {
    var name = ev.name;
    clearTimeout(statusTimer);
    if (name === 'perfect') {
      flash = 1;
      tone('perfect', state.lane);
      statusEl.innerHTML = '<b>PERFECT</b>' + ev.combo;
      statusEl.className = 'show';
      busy = true;
      statusTimer = setTimeout(advanceQueue, 550);
    } else if (name === 'good') {
      flash = .55;
      tone('good', state.lane);
      statusEl.innerHTML = '<b>GOOD</b>' + ev.combo;
      statusEl.className = 'show';
      busy = true;
      statusTimer = setTimeout(advanceQueue, 550);
    } else if (name === 'miss') {
      flash = -.7;
      tone('miss');
      statusEl.innerHTML = '<b>MISS</b>' + (C.MISS_LIMIT - ev.misses) + ' left';
      statusEl.className = 'show';
      busy = true;
      statusTimer = setTimeout(advanceQueue, 550);
    } else if (name === 'gameover') {
      flash = -.9;
      tone('gameover');
      statusEl.innerHTML = '<b>GAME OVER</b><small>' + finalResultBlock() + '<br>Press R or tap to ride again</small>';
      statusEl.className = 'show';
      busy = false; // terminal: stays visible until restart, nothing left to queue
    } else if (name === 'complete') {
      flash = 0;
      statusEl.innerHTML = '<b>RUN COMPLETE</b><small>' + finalResultBlock() + '<br>R to retry</small>';
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
    displayEvent(ev);
  }

  // Phase 3D.2 (transient judgment UI fix): once GAME OVER/RUN COMPLETE
  // fires, no further judgment can ever occur (press()/release()/tick()
  // all bail out once state.phase !== 'run'), so any STALE backlog left
  // over in `pending` from EARLIER frames is now moot — it can only ever
  // look wrong/confusing being shown after the run has already ended.
  // Previously the terminal event was appended to that same backlog and
  // simply waited its turn: on a run whose ending judgments land faster
  // than 550ms apart (HARD's dense sections), that could leave several
  // PERFECT/GOOD/MISS popups still queued right as the run ends, delaying
  // the correct result screen behind a burst of now-stale transient
  // popups. Now: this frame's OWN new events (state.events, still in
  // their original order — e.g. the MISS that directly causes GAME OVER
  // is always the event immediately before it) replace any older
  // backlog outright, rather than being appended to it. A single
  // currently-DISPLAYING popup (busy=true, its own short 550ms timer
  // already running) is still allowed to finish naturally before this
  // frame's events get their turn — only the (potentially large,
  // multi-judgment) backlog is what gets dropped.
  function handleEvent() {
    if (!state.events.length) {
      if (!busy && pending.length) showNext();
      return;
    }
    var incoming = state.events.splice(0, state.events.length);
    var last = incoming[incoming.length - 1];
    if (last.name === 'gameover' || last.name === 'complete') {
      pending = incoming;
    } else {
      for (var i = 0; i < incoming.length; i++) pending.push(incoming[i]);
    }
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

  // The one true shape geometry — used for BOTH the note head and (Phase
  // 3B.2) the Hold end marker, so the two can never independently drift
  // out of sync with each other OR with C.noteExtent()'s judgment extent:
  // this IS the exact same construction diamondHalfExtent() measures.
  // Caller must already be translated to the shape's center and have set
  // fillStyle/strokeStyle/lineWidth.
  function drawNoteShape(color, size, corner) {
    if (color === 0) {
      ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (color === 1) {
      ctx.rotate(Math.PI / 4); roundedRect(-size * C.DIAMOND_SCALE, -size * C.DIAMOND_SCALE, size * C.DIAMOND_SCALE * 2, size * C.DIAMOND_SCALE * 2, corner); ctx.fill(); ctx.stroke();
    } else {
      roundedRect(-size, -size, size * 2, size * 2, corner); ctx.fill(); ctx.stroke();
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
    // Hold tail + END MARKER (Phase 3B.2): the tail trails BEHIND the head
    // (toward smaller t, the direction it already fell from) at exactly
    // the hold's duration converted to the same t-scale (hold/TRAVEL) —
    // this is holdEndT() from game-core.js, inlined here since it's the
    // exact same formula the real release judgment uses (see release()),
    // so what the player sees IS what gets judged, never a separate
    // visual-only approximation. The END MARKER is drawn with drawNoteShape
    // — the SAME shape family (circle/diamond/square) and extent formula
    // the lane's real judgment (overlapRatio/noteExtent) uses, with a
    // thin, EXPLICITLY-reset lineWidth (the tail's much thicker lineWidth
    // must never leak into it — that was the HIGH-severity bug: a fat
    // inherited stroke made the marker visually ~90-100ms "early").
    // Both drawn first so the head shape (below) renders on top.
    if (gate.hold) {
      var tailT = gate.t - gate.hold / C.TRAVEL;
      var tailY = C.toScreenY(C.noteCenterYLogical(tailT), transform);
      var tailSize = C.noteBaseSize(tailT) * transform.scale;
      ctx.strokeStyle = C.COLORS[gate.color];
      ctx.lineWidth = size * 1.1;
      ctx.globalAlpha = gate.held ? .85 : .5; // brighter once actually being held
      ctx.beginPath();
      ctx.moveTo(x, tailY);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = gate.held ? 1 : .55; // the end marker itself: a clear release target
      ctx.save();
      ctx.translate(x, tailY);
      ctx.fillStyle = C.COLORS[gate.color];
      ctx.strokeStyle = '#fff'; // matches the head shapes' outline, so it reads as a real target
      ctx.lineWidth = 2; // reset — the SAME thin stroke an ordinary note head uses, not the tail's
      drawNoteShape(gate.color, tailSize, corner);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = C.COLORS[gate.color];
    ctx.shadowBlur = 18;
    ctx.fillStyle = C.COLORS[gate.color];
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    drawNoteShape(gate.color, size, corner);
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
    if (!started) {
      // A tap landing on the difficulty selector band ONLY selects — it
      // must never also start the run, so a mis-tap while choosing can't
      // accidentally launch the wrong difficulty. Any other tap keeps the
      // existing "tap anywhere to play" touch UX (desktop still starts
      // via Space only, unchanged).
      if (e.type === 'pointerdown') {
        var r = canvas.getBoundingClientRect();
        var hit = difficultyTapHit(e.clientX - r.left, e.clientY - r.top);
        if (hit) { setSelectedDifficulty(hit); return; }
      }
      if (touch) requestStart();
      return;
    }
    if (state.phase !== 'run') { beginRun(); return; } // retry: fresh shared origin, no re-decode
    if (e.type === 'pointerdown') {
      var lane = laneFromPointer(e);
      heldPointerLane = lane; // remembered for the matching pointerup/cancel, not recomputed from a possibly-drifted release position
      C.press(state, lane);
    }
    mChk();
  }
  function actUp() {
    if (heldPointerLane >= 0) { C.release(state, heldPointerLane); heldPointerLane = -1; mChk(); }
  }

  addEventListener('resize', resize);
  addEventListener('keydown', function(e) {
    if (!started) {
      // Only the 4 arrow keys change difficulty — A/S/D are deliberately
      // NOT wired here, so they can never accidentally change it (they're
      // the in-run lane keys, reused for nothing on the title screen).
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); moveSelectedDifficulty(-1); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveSelectedDifficulty(1); return; }
      if (!touch && e.key === ' ') { e.preventDefault(); requestStart(); }
      return;
    }
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); beginRun(); return; }
    if (state.phase !== 'run') return;
    // heldKey guards against OS key-repeat re-triggering C.press() for a
    // lane whose key is already down — a real key-up is required first.
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); if (!heldKey[0]) { heldKey[0] = true; C.press(state, 0); } }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); if (!heldKey[1]) { heldKey[1] = true; C.press(state, 1); } }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); if (!heldKey[2]) { heldKey[2] = true; C.press(state, 2); } }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); C.move(state, -1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); C.move(state, 1); }
    mChk();
    ensureAudio();
  });
  addEventListener('keyup', function(e) {
    var lane = e.key === 'a' || e.key === 'A' ? 0 : e.key === 's' || e.key === 'S' ? 1 : e.key === 'd' || e.key === 'D' ? 2 : -1;
    if (lane < 0) return;
    heldKey[lane] = false;
    if (started && state.phase === 'run') { C.release(state, lane); mChk(); }
  });
  canvas.addEventListener('pointerdown', act);
  canvas.addEventListener('pointerup', actUp);
  canvas.addEventListener('pointercancel', actUp);

  function frame(now) {
    if (started) {
      // dt is DERIVED from the shared audio clock every frame (the gap
      // between where state.time should be and where it currently is) —
      // never accumulated from performance.now() — so state.time can only
      // ever equal audio.currentTime - runOrigin, exactly, at all times.
      var dt = (audio.currentTime - runOrigin) - state.time;
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
    globalThis.__RRR_TEST__.start = requestStart;
    globalThis.__RRR_TEST__.started = function() { return started; };
    globalThis.__RRR_TEST__.wav = {
      src: () => wavSrc, audio: () => audio, preRoll: C.PRE_ROLL,
      runOrigin: () => runOrigin, ready: () => wavReady, pending: () => pendingStart,
      stop: mStop, error: () => audioLoadError
    };
    globalThis.__RRR_TEST__.drawNoteShape = drawNoteShape;
    globalThis.__RRR_TEST__.difficulty = {
      selected: () => selectedDifficulty,
      set: setSelectedDifficulty,
      move: moveSelectedDifficulty,
      tapHit: difficultyTapHit
    };
  }
})();
