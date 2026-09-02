(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RainbowRefrainCore = factory();
})(globalThis, function() {
  'use strict';

  var COLORS = ['#ff4f91', '#ffd447', '#55d6ff'];
  var NAMES = ['PINK', 'GOLD', 'CYAN'];
  var LANES = 3;
  var TRAVEL = 2.25;
  // LOCAL PLAYTEST BUILD ONLY (Phase 3A.1): a pre-roll equal to the note
  // travel time, so a note "reaching the judgment line at wavTime X" and
  // "spawning at gameElapsed X" are the same moment shifted by one full
  // travel — the WAV starts at gameElapsed PRE_ROLL (see game.js), so
  // wavTime = gameElapsed - PRE_ROLL, and chart hit times below are
  // expressed directly on the gameElapsed clock as PRE_ROLL + csvHitTime.
  // This is why spawnTime (= gameHitTime - TRAVEL = PRE_ROLL + csvHitTime
  // - TRAVEL) collapses to exactly csvHitTime when PRE_ROLL === TRAVEL:
  // the very first note (csv 0.294s) spawns at gameElapsed 0.294s, never
  // negative. NOT part of the final size-constrained build.
  var PRE_ROLL = TRAVEL;
  var MISS_LIMIT = 3;
  // OVERLAP_WINDOW now controls only how long an unpressed note stays live
  // before auto-becoming a pass-by MISS (tick()) — a generous, deliberately
  // t-only timing window, NOT the judgment ratio (that's geometric now, see
  // overlapRatio below). Keeping these decoupled means "when a note leaves
  // play" and "how well-timed a press was" are governed independently.
  var OVERLAP_WINDOW = 0.2;
  var PERFECT_RATIO = 0.9;
  var GOOD_RATIO = 0.1;
  var PERFECT_SCORE = 100;
  var GOOD_SCORE = 50;
  // LOCAL PLAYTEST BUILD ONLY: the reference WAV is exactly 90.000s (48kHz
  // stereo PCM, verified against the file header). RUN_DURATION must cover
  // the full pre-roll + the entire WAV, plus a short buffer so the final
  // chart note (game hit time PRE_ROLL+89.382) fully resolves before the
  // run is cut off — never ending the run early and clipping the track.
  var RUN_DURATION = PRE_ROLL + 90 + 0.5;
  // Single authoritative geometry, in the same units drawTrack()/drawGate()
  // render with (fraction of canvas height for position; TARGET_RADIUS/
  // NOTE_MIN_SIZE/NOTE_MAX_SIZE are LOGICAL pixels, defined at the
  // LOGICAL_HEIGHT reference scale below — see scaleFor()). Rendering reads
  // these from C instead of hardcoding its own copies, so the visuals and
  // the judgment ratio below can never independently drift.
  var TRACK_TOP = 0.2;
  var TRACK_BOTTOM = 0.82;
  var TARGET_RADIUS = 33;
  var NOTE_MIN_SIZE = 15;
  var NOTE_MAX_SIZE = 39;
  // Shape geometry for the GOLD note: drawGate() draws it as a rounded
  // square of half-side size*DIAMOND_SCALE (corner radius
  // SHAPE_CORNER_RADIUS), rotated 45 degrees. Its vertical extent after
  // rotation is therefore NOT the circle/square's `size` — see
  // diamondHalfExtent below. Shared with rendering so the two can't drift.
  var DIAMOND_SCALE = 0.8;
  var SHAPE_CORNER_RADIUS = 5;
  // Position (TRACK_TOP/BOTTOM) is already a fraction of the real canvas
  // height, so it naturally scales with viewport size — a taller screen
  // means a longer travel span in pixels. But TARGET_RADIUS/NOTE_*_SIZE
  // used to be raw, un-scaled pixel constants: on a taller viewport the
  // travel distance grew while the hit-radius didn't, silently shrinking
  // the effective hit window (and, on a short-enough viewport, collapsing
  // a real hit into NO-OP). LOGICAL_HEIGHT is the reference scale those
  // three constants are defined at; scaleFor() converts real canvas height
  // to a multiplier so rendering can size the target/note in real pixels
  // while judgment reasons in scale-free logical units — see overlapRatio.
  var LOGICAL_HEIGHT = 720;
  // Codex re-audit (uniform-logical-space remediation): the lane group's
  // horizontal spacing used to be a raw, real-pixel value capped by the
  // live canvas WIDTH (min(126, width*.22)), independent of the
  // height-driven scale TARGET_RADIUS/NOTE_*_SIZE used. On a tall/narrow
  // viewport the target-radius scale grew (taller canvas) while lane
  // spacing didn't grow with it, so adjacent judgment circles overlapped.
  // LOGICAL_WIDTH plus LANE_GAP put horizontal geometry in the SAME
  // logical space as everything vertical; computeTransform() below picks
  // ONE scale for both axes, so radius and spacing can never drift apart.
  // 480 is comfortably below the width*720/height derived from every
  // required widescreen viewport (1280x720/1366x768/1920x1080 all land
  // at 1280), so those stay height-bound and pixel-identical to before;
  // it is comfortably above the 405 a tall 900x1600 viewport derives,
  // so that one becomes width-bound and the whole game uniformly shrinks
  // instead of letting the target circles collide.
  var LOGICAL_WIDTH = 480;
  var LANE_GAP = 126;
  // Tolerance for the >=0.10/>=0.90 threshold comparisons only, to absorb
  // float noise from dividing by OVERLAP_WINDOW (e.g. 0.18/0.2 can land on
  // 0.09999999999999998 instead of 0.1). Never applied to the 0-vs-positive
  // check, so a genuinely tiny positive overlap is never reclassified as 0.
  var JUDGE_EPS = 1e-9;

  // Phase 3C/3D/3D.1: THREE immutable compact chart representations —
  // EASY v2 (82 events, 3 Holds), NORMAL v2 (118 events, 5 Holds), HARD v2
  // (158 events, 8 Holds, REFERENCES/rainbow_refrain_hard_chart_v2.csv —
  // v1 was deleted and is NOT used anywhere; v2 is the sole authoritative
  // HARD reference) — all built by the SAME decode routine from
  // REFERENCES/*.csv, converted once at module load and never mutated at
  // runtime (no combining, no in-place editing of one into another).
  // hit time = .294 + cumulative-grid-delta*unit (EASY: quarter-beat
  // grid, unit .384s; NORMAL: 8th-note grid, unit .192s; HARD: TRUE
  // 16th-note grid, unit .096s — all at BPM 156.25; HARD is NOT quantized
  // back onto NORMAL's coarser 8th grid). Unlike HARD v1 (which a Codex
  // audit correctly flagged as only ever landing on EVEN grid_index_16th
  // values — an effective 0.192s-grid subset masquerading as a 0.096s
  // grid), HARD v2 contains 16 genuine ODD-index 16th-grid events that
  // are impossible to represent on a 0.192s grid at all — see
  // TEST_HARD_ODD_16TH_GRID_INDEX_COUNT_IS_16 in the test suite, which
  // verifies this from decoded runtime event timings, not from the unit
  // constant or source text. d/l are per-event delta/lane digits, ONE
  // CHARACTER each, parsed in BASE 36 (not base 10): EASY/NORMAL's deltas
  // never exceed 9 so this is unchanged for them, but HARD's density
  // means some gaps between consecutive 16th-grid steps exceed 9 (max
  // observed delta is 16) — base 36 covers 0-35 in a single character
  // without inflating the encoding to 2 chars/event or changing the
  // decode shape at all. HOLD_IDX marks which 0-based positions carry a
  // Hold (all three charts share the same 0.768s HOLD_DUR).
  var HOLD_DUR = .768;
  // Phase 3C.1 (Codex LOW-1 fix): freeze every event object AND the chart
  // array itself — production charts are never mutated at runtime (tick()
  // always spawns a NEW plain gate object copying color/t/hold from the
  // chart event, see the spawn loop below; it never reuses or writes back
  // to the chart event itself), so this is pure safety with zero behavior
  // change. Object.freeze is shallow, which is exactly what's needed here
  // (each event is a flat {t, lane[, hold]} object, one level deep).
  function decodeChart(d, l, unit, holdIdx) {
    var out = [], b = 0;
    for (var i = 0; i < d.length; i++) {
      b += parseInt(d[i], 36);
      out.push({ t: PRE_ROLL + .294 + b * unit, lane: parseInt(l[i], 36) }); // gameHitTime = PRE_ROLL + csvHitTime
    }
    for (var h = 0; h < holdIdx.length; h++) out[holdIdx[h]].hold = HOLD_DUR;
    for (var f = 0; f < out.length; f++) Object.freeze(out[f]);
    return Object.freeze(out);
  }
  var CHART_EASY = decodeChart(
    '0442424244242442424424242442424424244242444442423142224132442224131313222222422222',
    '0121210112101121011210110101101011010110120121210110121202212022021210121021012102',
    .384, [41, 42, 72]
  );
  var CHART_NORMAL = decodeChart(
    '0844483183181741741717417416183183181381741713817416147183181381784484174152534134532613357144318116233261344444844444',
    '0122121102112210010102100120121102112012010120120122101102110012202121221201110212012012020120222102122101121021012102',
    .192, [28, 64, 65, 86, 108]
  );
  var CHART_HARD = decodeChart(
    '0g8883d332b562a62958259712e286352e262c22e2426a622e262e24a262c226a62e26284286826a622c226a62eg268g8259352a491682671a6493266a3b283562g222a442646626853888d3888844',
    '01221020111021212021010110102211001120122011002121202121011011201120112121021100210210001220121212120120111102122012001202101200222102212221001121102120121022',
    .096, [18, 38, 61, 90, 91, 118, 129, 146]
  );
  var CHARTS = Object.freeze({ easy: CHART_EASY, normal: CHART_NORMAL, hard: CHART_HARD });
  var DIFFICULTIES = ['easy', 'normal', 'hard'];
  // Which difficulty's chart is currently active — selected on the title
  // screen (see game.js), locked for the duration of a run (setDifficulty
  // is only ever called while phase !== 'run'), and preserved across a
  // retry (reset() never touches this). A pre-declared
  // globalThis.__RRR_TEST__.chart still overrides CHART entirely (e.g. []
  // for isolated judgment tests) and takes priority over any difficulty
  // selection — a no-op in production, since nothing there ever defines
  // __RRR_TEST__ (same seam as game.js's), and unused by this build's own
  // test suite (which exercises real chart selection through setDifficulty).
  var difficulty = 'easy';
  var CHART = (globalThis.__RRR_TEST__ && globalThis.__RRR_TEST__.chart) || CHART_EASY;
  function setDifficulty(name) {
    var key = CHARTS.hasOwnProperty(name) ? name : 'easy';
    difficulty = key;
    if (!(globalThis.__RRR_TEST__ && globalThis.__RRR_TEST__.chart)) CHART = CHARTS[key];
  }
  function getDifficulty() { return difficulty; }

  // difficulty is captured from getDifficulty() AT RUN START, into the
  // state object itself — so a run's own difficulty is fixed for its
  // whole lifetime even if setDifficulty() is called again later (e.g.
  // from a title-screen selector still mounted underneath), and the
  // result screen can report which difficulty this particular run was.
  function makeState(seed) {
    return {
      seed: seed | 0,
      phase: 'run',
      time: 0,
      lane: 1,
      difficulty: getDifficulty(),
      score: 0,
      combo: 0,
      misses: 0,
      perfects: 0,
      goods: 0,
      maxCombo: 0,
      gates: [],
      chartIdx: 0,
      activeHold: null,
      lastEvent: 'start',
      eventAge: 0,
      eventId: 0,
      events: []
    };
  }

  function cloneForTest(state) {
    return {
      seed: state.seed,
      phase: state.phase,
      time: +state.time.toFixed(6),
      lane: state.lane,
      difficulty: state.difficulty,
      score: state.score,
      combo: state.combo,
      misses: state.misses,
      gates: state.gates.map(function(g) { return { color: g.color, t: +g.t.toFixed(6), hold: g.hold || 0, held: !!g.held }; }),
      chartIdx: state.chartIdx,
      activeHold: state.activeHold ? { lane: state.activeHold.lane } : null,
      lastEvent: state.lastEvent
    };
  }

  function setLane(state, lane) {
    state.lane = Math.max(0, Math.min(LANES - 1, lane | 0));
  }

  function move(state, direction) {
    setLane(state, state.lane + (direction < 0 ? -1 : 1));
  }

  // Every fired event is queued (not just remembered as a single "last"
  // name): a MISS immediately followed by GAME OVER in the same press() call
  // are two distinct events a display layer must show in order, one after
  // the other — never just the final one.
  //
  // Phase 3D.2 (transient judgment UI fix): combo/misses are SNAPSHOTTED
  // into the event itself, at the exact moment the judgment is committed
  // (every fire() call site already mutates combo/misses immediately
  // before calling fire(), so this is always the correct post-judgment
  // value for that specific event) — not left for a display layer to read
  // live later. A display can be delayed behind other queued events (each
  // judgment popup holds the screen for its own fixed duration before the
  // next can show), so "live" state by the time a queued event is finally
  // shown may already belong to a LATER judgment (e.g. a MISS that reset
  // combo to 0 after this PERFECT already happened) — reading state then
  // would show a combo/misses-left number that never actually applied to
  // THIS judgment. Carrying the value on the event guarantees whatever is
  // displayed always matches the judgment it's for, no matter how long it
  // sat queued.
  function fire(state, name) {
    state.eventId += 1;
    state.lastEvent = name;
    state.eventAge = 0;
    state.events.push({ id: state.eventId, name: name, combo: state.combo, misses: state.misses });
  }

  // Single authoritative logical->real transform: ONE scale factor fit to
  // whichever of width/height is the tighter constraint against the fixed
  // LOGICAL_WIDTH x LOGICAL_HEIGHT reference box, applied identically to
  // both axes (never independently stretched — circles stay circles), and
  // centered (letterboxed) in whichever axis has slack. Rendering AND
  // pointer/touch mapping both derive real-pixel geometry through this one
  // function — see toScreenX/toScreenY/toLogicalX/toLogicalY below — so
  // lane spacing, target radius, note size, and diamond corner radius can
  // never independently drift out of proportion with each other again.
  function computeTransform(width, height) {
    var scale = Math.min(width / LOGICAL_WIDTH, height / LOGICAL_HEIGHT);
    return {
      scale: scale,
      offsetX: (width - LOGICAL_WIDTH * scale) / 2,
      offsetY: (height - LOGICAL_HEIGHT * scale) / 2
    };
  }
  function toScreenX(logicalX, t) { return t.offsetX + logicalX * t.scale; }
  function toScreenY(logicalY, t) { return t.offsetY + logicalY * t.scale; }
  // Inverse projection: a real screen/canvas-local pixel coordinate back
  // into logical gameplay space. Pointer/touch input must go through this
  // (not a raw fraction of the full physical canvas) so a tap resolves
  // against the SAME coordinate system rendering placed things in,
  // including any letterbox offset.
  function toLogicalX(screenX, t) { return (screenX - t.offsetX) / t.scale; }
  function toLogicalY(screenY, t) { return (screenY - t.offsetY) / t.scale; }

  // Logical X center of a lane (0=left/PINK, 1=center/GOLD, 2=right/CYAN).
  // The single authoritative source for horizontal lane spacing: rendering
  // (drawTrack/drawGate/drawUnicorn) and pointer/touch hit-testing (see
  // laneFromLogicalX) both derive their real-pixel lane position from this
  // same function, so they cannot independently drift — the previous bug
  // (pointer split the full raw screen width into thirds while rendering
  // clustered all three lanes within a much narrower, centered band).
  function laneCenterX(lane) {
    return LOGICAL_WIDTH / 2 + (lane - 1) * LANE_GAP;
  }

  // Authoritative pointer/touch hit-test: resolves a logical X coordinate
  // to whichever lane center it is nearest, rather than dividing the full
  // canvas into three equal raw-pixel thirds (which silently stopped
  // matching the actual, narrower, letterboxed lane group).
  function laneFromLogicalX(logicalX) {
    var best = 0, bestDist = Infinity;
    for (var lane = 0; lane < LANES; lane++) {
      var d = Math.abs(logicalX - laneCenterX(lane));
      if (d < bestDist) { bestDist = d; best = lane; }
    }
    return best;
  }

  // Base size (before any per-shape correction) as a pure function of t, in
  // logical pixels: grows from NOTE_MIN_SIZE to NOTE_MAX_SIZE while
  // approaching (t: 0->1), then holds at NOTE_MAX_SIZE past the judgment
  // line, matching the note's actual on-screen growth animation.
  function noteBaseSize(t) {
    var p = t < 0 ? 0 : t > 1 ? 1 : t;
    return NOTE_MIN_SIZE + p * (NOTE_MAX_SIZE - NOTE_MIN_SIZE);
  }

  // The GOLD note is drawn as a size*DIAMOND_SCALE-half-side rounded square
  // (corner radius SHAPE_CORNER_RADIUS), rotated 45 degrees — see drawGate.
  // Its vertical half-extent after rotation is the rotated corner arc's own
  // extreme point (not the naive size*DIAMOND_SCALE*sqrt(2) sharp-corner
  // diagonal, since the corner is rounded): for a square of half-side a and
  // corner radius r, that point sits at distance sqrt(2)*a - (sqrt(2)-1)*r
  // from center, along the post-rotation vertical axis. Verified against a
  // brute-force sampling of the actual rounded-corner arc to float
  // precision before being trusted here.
  function diamondHalfExtent(size) {
    var a = size * DIAMOND_SCALE;
    return Math.SQRT2 * a - (Math.SQRT2 - 1) * SHAPE_CORNER_RADIUS;
  }

  // Per-shape actual current visual half-extent, in logical pixels
  // (multiply by scaleFor(heightPx) for real pixels) — this is what
  // rendering draws (see drawGate), and what judgment must use. The circle
  // (color 0) and axis-aligned square (color 2) both have vertical
  // half-extent exactly equal to their drawn size (a straight top/bottom
  // edge or radius, unaffected by corner rounding); the rotated diamond
  // (color 1) does not — see diamondHalfExtent. Do not assume they match.
  function noteExtent(t, color) {
    var size = noteBaseSize(t);
    return color === 1 ? diamondHalfExtent(size) : size;
  }

  // The two positions rendering and judgment must agree on, expressed once
  // — purely in LOGICAL units (project through toScreenY(transform) for
  // real pixels). noteCenterYLogical is intentionally unclamped so it
  // matches the note's actual rendered position for gate.t > 1 too
  // (continuous flow).
  function noteCenterYLogical(t) {
    return LOGICAL_HEIGHT * TRACK_TOP + LOGICAL_HEIGHT * (TRACK_BOTTOM - TRACK_TOP) * t;
  }
  function targetCenterYLogical() {
    return LOGICAL_HEIGHT * TRACK_BOTTOM;
  }

  // Genuine visual-overlap ratio, expressed in scale-free logical units so
  // it is IDENTICAL for a given t (and shape) regardless of real viewport
  // height. Both the note-to-target distance and the note/target radii
  // scale by the exact same real-height factor when rendered (see
  // scaleFor), so that factor cancels out of the ratio entirely:
  // LOGICAL_HEIGHT here stands in for any real height, and the result is
  // the actual value that would be computed at every real height alike.
  // This is deliberately NOT forced symmetric around t=1 — noteExtent(t)
  // genuinely shrinks on approach (matching the real growth animation) but
  // holds at max size on departure (matching the real render clamp), so
  // approach/departure ratios are intentionally asymmetric except very
  // near t=1, where the note is already at or near full size on both
  // sides. 1.0 only when the note's rendered center exactly coincides with
  // the judgment circle's (distance 0); 0 once they're far enough apart
  // that the shapes (at their true current size AND shape) no longer
  // visually touch at all.
  function overlapRatio(t, color) {
    var distance = LOGICAL_HEIGHT * (TRACK_BOTTOM - TRACK_TOP) * Math.abs(1 - t);
    var maxDistance = TARGET_RADIUS + noteExtent(t, color);
    var r = 1 - distance / maxDistance;
    return r < 0 ? 0 : r > 1 ? 1 : r;
  }

  // Classifies a raw, unrounded overlap ratio. Rounding the ratio itself
  // (as an earlier version did) can turn a genuinely positive but tiny
  // overlap — e.g. 7.77e-16, from float error right at the window edge —
  // into exactly 0, which would wrongly read as NO-OP. Only the >=0.10/
  // >=0.90 threshold comparisons get a tiny epsilon, to absorb unrelated
  // float noise from the OVERLAP_WINDOW division; the 0-vs-positive check
  // stays exact, so ANY positive overlap is always MISS/GOOD/PERFECT.
  function classify(ratio) {
    if (ratio <= 0) return 'noop';
    if (ratio >= PERFECT_RATIO - JUDGE_EPS) return 'perfect';
    if (ratio >= GOOD_RATIO - JUDGE_EPS) return 'good';
    return 'miss';
  }

  // Phase 3B.1: the Hold END is its own judgeable "virtual note" on the
  // exact same t-scale as any other — it reaches the judgment line
  // `hold` seconds (in t-units: hold/TRAVEL) after the head does, and its
  // own t keeps advancing at the identical rate as the held gate's t
  // (they're rigidly the same object). Deriving it fresh from the LIVE
  // gate.t — rather than tracking a separately-computed absolute end
  // timestamp — means overlapRatio()/classify() (the exact same TAP
  // judgment) can be reused directly for the release, with no second,
  // hidden timing model.
  function holdEndT(gate) {
    return gate.t - gate.hold / TRAVEL;
  }

  // Among unjudged notes in the pressed lane, the one with the HIGHEST
  // overlap is the judgment candidate. A candidate with zero overlap (e.g.
  // a note that only just spawned) is not a valid target: pressing when
  // nothing has any positive overlap in that lane is a no-op, matching an
  // empty-lane press. Any positive overlap, however small, is always
  // resolved to MISS/GOOD/PERFECT — it is never silently dropped.
  // overlapRatio no longer needs the live canvas height: the ratio is
  // scale-free (see overlapRatio), so the same judgment applies at every
  // viewport size for a given gate.t. It does need the gate's color/shape,
  // since shapes have different true vertical extents (see noteExtent).
  // A Hold note's START uses this exact same TAP judgment (no separate
  // hidden window) — g.held gates are excluded from matching here, so an
  // already-active Hold can't be re-triggered by a stray extra press.
  // Phase 3D.3 (Codex BLOCKING FINDING 2 fix): tears down an active Hold
  // FULLY — both the state.activeHold reference AND its own gate object
  // in state.gates — never just the reference alone. Two GAME OVER paths
  // (press()'s miss on a DIFFERENT lane than the active Hold, and tick()'s
  // ordinary pass-by-miss on a DIFFERENT gate) used to just null
  // state.activeHold when the run ended, leaving the still-held gate's
  // own object behind in state.gates forever — nothing ever processes it
  // again once phase !== 'run', so it kept rendering (note head, Hold
  // tail, end marker) every terminal frame after GAME OVER. Safe to call
  // even mid-loop in tick() (see the call site there): whichever gate this
  // splices, if any, is never the loop's own current index — it's always
  // either already-processed or, when it is the causing gate, this whole
  // branch already `break`s the loop immediately after, so there is never
  // another iteration left that could double-process a shifted gate.
  function clearActiveHold(state) {
    var h = state.activeHold;
    if (h) {
      var gi = state.gates.indexOf(h.gate);
      if (gi >= 0) state.gates.splice(gi, 1);
      state.activeHold = null;
    }
  }

  // Phase 3D.4 (Codex MEDIUM fix): the SINGLE canonical path for ALL GAME
  // OVER transitions. Phase 3D.3's clearActiveHold() only ever removed
  // the ACTIVE HOLD's own gate — a Codex audit reproduced OTHER,
  // unrelated, still-unresolved gates (e.g. an ordinary TAP note that
  // simply hadn't reached its own pass-by-miss threshold yet) surviving
  // in state.gates regardless of WHICH of the 4 real GAME OVER paths
  // (press() miss, release() miss, tick()'s held-gate timeout, tick()'s
  // ordinary pass-by-miss) triggered it — none of them had any reason to
  // know about or clean up a gate structurally unrelated to their own
  // branch. GAME OVER now clears the ENTIRE runtime gate list
  // unconditionally: once the run is over, EVERY gate is unresolved by
  // definition (nothing will ever judge them again), so there is no
  // "wrong" gate to accidentally leave behind. Every call site below
  // replaces its own ad-hoc `state.phase='gameover'; ...;
  // fire(state,'gameover');` triplet with a single call here, so there is
  // exactly one place that defines what "terminal" means at the
  // runtime-state level — chart spawning is already separately blocked by
  // tick()'s own `if (state.phase !== 'run') return` guard at its top, so
  // nothing further is needed for that once phase flips here.
  function enterGameOver(state) {
    state.phase = 'gameover';
    clearActiveHold(state); // still the one place that nulls activeHold — kept as a building block, not duplicated here
    state.gates.length = 0; // the actual fix: EVERY remaining unresolved gate, not just whichever one this branch already knew about
    fire(state, 'gameover');
  }

  function press(state, lane) {
    if (state.phase !== 'run') return;
    setLane(state, lane);
    var idx = -1, bestRatio = 0;
    for (var i = 0; i < state.gates.length; i++) {
      var g = state.gates[i];
      if (g.color !== lane || g.held) continue;
      var ratio = overlapRatio(g.t, g.color);
      if (ratio > bestRatio) { bestRatio = ratio; idx = i; }
    }
    if (idx < 0) return;
    var hit = state.gates[idx];
    var kind = classify(bestRatio);
    if (kind === 'perfect' || kind === 'good') {
      state.combo += 1;
      if (state.combo > state.maxCombo) state.maxCombo = state.combo;
      if (kind === 'perfect') { state.score += PERFECT_SCORE; state.perfects += 1; fire(state, 'perfect'); }
      else { state.score += GOOD_SCORE; state.goods += 1; fire(state, 'good'); }
      // Successful Hold start: keep the gate alive (held) so it keeps
      // rendering/traveling for the tail visual, instead of removing it
      // like an ordinary TAP — resolved later by tick()'s completion
      // check or by an early release(), never by pass-by MISS (see tick).
      if (hit.hold) {
        hit.held = true;
        state.activeHold = { lane: lane, gate: hit };
      } else {
        state.gates.splice(idx, 1);
      }
    } else {
      state.gates.splice(idx, 1);
      state.misses += 1;
      state.combo = 0;
      fire(state, 'miss');
      if (state.misses >= MISS_LIMIT) {
        enterGameOver(state);
      }
    }
  }

  // Called when the held lane's key/pointer is released. A no-op unless
  // that lane currently has an active Hold — an irrelevant release (e.g.
  // letting go of a key that was only ever used for ordinary TAPs) must
  // never affect state. Otherwise the release IS the judgment: the Hold
  // end is classified through the exact same overlapRatio/classify TAP
  // thresholds as any other note (see holdEndT) — PERFECT/GOOD score,
  // combo, and their counters exactly like a normal note; anything else
  // (MISS, or NOOP from releasing far too early) is exactly one MISS. The
  // gate/activeHold are always cleared here, so this Hold can never be
  // judged a second time from anywhere else.
  function release(state, lane) {
    if (state.phase !== 'run') return;
    var h = state.activeHold;
    if (!h || h.lane !== lane) return;
    var gate = h.gate;
    var kind = classify(overlapRatio(holdEndT(gate), gate.color));
    var gi = state.gates.indexOf(gate);
    if (gi >= 0) state.gates.splice(gi, 1);
    state.activeHold = null;
    if (kind === 'perfect' || kind === 'good') {
      state.combo += 1;
      if (state.combo > state.maxCombo) state.maxCombo = state.combo;
      if (kind === 'perfect') { state.score += PERFECT_SCORE; state.perfects += 1; fire(state, 'perfect'); }
      else { state.score += GOOD_SCORE; state.goods += 1; fire(state, 'good'); }
    } else {
      state.misses += 1;
      state.combo = 0;
      fire(state, 'miss');
      if (state.misses >= MISS_LIMIT) {
        enterGameOver(state);
      }
    }
  }

  function tick(state, input, dt) {
    input = input || {};
    dt = Math.max(0, Math.min(0.1, +dt || 0));
    if (state.phase !== 'run') {
      state.eventAge += dt;
      return state;
    }
    if (input.lane !== undefined && input.lane !== null) setLane(state, input.lane);
    if (input.left) move(state, -1);
    if (input.right) move(state, 1);

    state.time += dt;
    state.eventAge += dt;

    // RUN COMPLETE must wait for any in-progress Hold to resolve too (it
    // always will, well before RUN_DURATION, given the chart, but this
    // keeps the invariant explicit rather than accidental).
    if (state.time >= RUN_DURATION && !state.activeHold) {
      state.phase = 'complete';
      fire(state, 'complete');
      return state;
    }

    // Chart-driven spawn: hit time - TRAVEL = spawn time; t derives from
    // absolute elapsed time (not reset to 0) so a late tick self-corrects.
    while (state.chartIdx < CHART.length && CHART[state.chartIdx].t - TRAVEL <= state.time) {
      var cn = CHART[state.chartIdx++];
      state.gates.push({ color: cn.lane, t: (state.time - dt - cn.t + TRAVEL) / TRAVEL, hold: cn.hold });
    }

    for (var i = state.gates.length - 1; i >= 0; i--) {
      var gate = state.gates[i];
      gate.t += dt / TRAVEL; // held gates keep traveling too (tail/end-marker visual)
      if (gate.held) {
        // No release yet: once the END's own judgment window has closed
        // (holdEndT is as far past the line as an ordinary unpressed note
        // is ever allowed to be — the SAME OVERLAP_WINDOW grace period),
        // that is exactly one MISS — release() can no longer act on this
        // Hold from here on, since it is removed immediately below.
        if (holdEndT(gate) - 1 < OVERLAP_WINDOW) continue;
        state.gates.splice(i, 1);
        state.activeHold = null;
        state.misses += 1;
        state.combo = 0;
        fire(state, 'miss');
        if (state.misses >= MISS_LIMIT) {
          enterGameOver(state);
          break;
        }
        continue;
      }
      if (gate.t - 1 < OVERLAP_WINDOW) continue;
      state.gates.splice(i, 1);
      state.misses += 1;
      state.combo = 0;
      fire(state, 'miss');
      if (state.misses >= MISS_LIMIT) {
        enterGameOver(state);
        break;
      }
    }
    return state;
  }

  return {
    COLORS: COLORS,
    NAMES: NAMES,
    LANES: LANES,
    TRAVEL: TRAVEL,
    PRE_ROLL: PRE_ROLL,
    // A live getter (not a value snapshot) — CHART is reassigned by
    // setDifficulty() well after this object is built, so a plain
    // `CHART: CHART` property would freeze at whatever was active at
    // module-load time (always CHART_EASY) and silently go stale the
    // moment a test or the title screen switches to NORMAL.
    get CHART() { return CHART; },
    EASY_CHART: CHART_EASY,
    NORMAL_CHART: CHART_NORMAL,
    HARD_CHART: CHART_HARD,
    CHARTS: CHARTS,
    DIFFICULTIES: DIFFICULTIES,
    setDifficulty: setDifficulty,
    getDifficulty: getDifficulty,
    HOLD_DUR: HOLD_DUR,
    MISS_LIMIT: MISS_LIMIT,
    OVERLAP_WINDOW: OVERLAP_WINDOW,
    PERFECT_RATIO: PERFECT_RATIO,
    GOOD_RATIO: GOOD_RATIO,
    PERFECT_SCORE: PERFECT_SCORE,
    GOOD_SCORE: GOOD_SCORE,
    RUN_DURATION: RUN_DURATION,
    JUDGE_EPS: JUDGE_EPS,
    TRACK_TOP: TRACK_TOP,
    TRACK_BOTTOM: TRACK_BOTTOM,
    TARGET_RADIUS: TARGET_RADIUS,
    NOTE_MIN_SIZE: NOTE_MIN_SIZE,
    NOTE_MAX_SIZE: NOTE_MAX_SIZE,
    LOGICAL_HEIGHT: LOGICAL_HEIGHT,
    LOGICAL_WIDTH: LOGICAL_WIDTH,
    LANE_GAP: LANE_GAP,
    DIAMOND_SCALE: DIAMOND_SCALE,
    SHAPE_CORNER_RADIUS: SHAPE_CORNER_RADIUS,
    makeState: makeState,
    cloneForTest: cloneForTest,
    setLane: setLane,
    move: move,
    computeTransform: computeTransform,
    toScreenX: toScreenX,
    toScreenY: toScreenY,
    toLogicalX: toLogicalX,
    toLogicalY: toLogicalY,
    laneCenterX: laneCenterX,
    laneFromLogicalX: laneFromLogicalX,
    noteBaseSize: noteBaseSize,
    diamondHalfExtent: diamondHalfExtent,
    noteExtent: noteExtent,
    noteCenterYLogical: noteCenterYLogical,
    targetCenterYLogical: targetCenterYLogical,
    overlapRatio: overlapRatio,
    classify: classify,
    press: press,
    release: release,
    tick: tick
  };
});
