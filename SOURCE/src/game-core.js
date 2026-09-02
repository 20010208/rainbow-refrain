(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RainbowRefrainCore = factory();
})(globalThis, function() {
  'use strict';

  var COLORS = ['#ff4f91', '#ffd447', '#55d6ff'];
  var NAMES = ['PINK', 'GOLD', 'CYAN'];
  var LANES = 3;
  var TRAVEL = 2.25;
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
  var RUN_DURATION = 90;
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

  // EASY chart v1 (118 events, see REFERENCES/*.csv): hit time = .294 +
  // cumulative-beat-delta*.384 (BPM 156.25); d/l are per-event delta/lane
  // digits. A pre-declared globalThis.__RRR_TEST__.chart lets a harness
  // substitute e.g. [] for isolated judgment tests — a no-op in production,
  // since nothing there ever defines __RRR_TEST__ (same seam as game.js's).
  var CHART = (globalThis.__RRR_TEST__ && globalThis.__RRR_TEST__.chart) || (function() {
    var d = '0442222222222222222222222222222222222222222222222222222222222224444222221122211222112222222112221121121122222222222222';
    var l = '0121021201210212012102120121021201210212012102120121021201210212012102120121021201210212012102120121021201210212012102';
    var out = [], b = 0;
    for (var i = 0; i < d.length; i++) {
      b += +d[i];
      out.push({ t: .294 + b * .384, lane: +l[i] });
    }
    return out;
  })();

  function makeState(seed) {
    return {
      seed: seed | 0,
      phase: 'run',
      time: 0,
      lane: 1,
      score: 0,
      combo: 0,
      misses: 0,
      perfects: 0,
      goods: 0,
      maxCombo: 0,
      gates: [],
      chartIdx: 0,
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
      score: state.score,
      combo: state.combo,
      misses: state.misses,
      gates: state.gates.map(function(g) { return { color: g.color, t: +g.t.toFixed(6) }; }),
      chartIdx: state.chartIdx,
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
  function fire(state, name) {
    state.eventId += 1;
    state.lastEvent = name;
    state.eventAge = 0;
    state.events.push({ id: state.eventId, name: name });
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
  function press(state, lane) {
    if (state.phase !== 'run') return;
    setLane(state, lane);
    var idx = -1, bestRatio = 0;
    for (var i = 0; i < state.gates.length; i++) {
      var g = state.gates[i];
      if (g.color !== lane) continue;
      var ratio = overlapRatio(g.t, g.color);
      if (ratio > bestRatio) { bestRatio = ratio; idx = i; }
    }
    if (idx < 0) return;
    state.gates.splice(idx, 1);
    var kind = classify(bestRatio);
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
        state.phase = 'gameover';
        fire(state, 'gameover');
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

    if (state.time >= RUN_DURATION) {
      state.phase = 'complete';
      fire(state, 'complete');
      return state;
    }

    // Chart-driven spawn: hit time - TRAVEL = spawn time; t derives from
    // absolute elapsed time (not reset to 0) so a late tick self-corrects.
    while (state.chartIdx < CHART.length && CHART[state.chartIdx].t - TRAVEL <= state.time) {
      var cn = CHART[state.chartIdx++];
      state.gates.push({ color: cn.lane, t: (state.time - dt - cn.t + TRAVEL) / TRAVEL });
    }

    for (var i = state.gates.length - 1; i >= 0; i--) {
      var gate = state.gates[i];
      gate.t += dt / TRAVEL;
      if (gate.t - 1 < OVERLAP_WINDOW) continue;
      state.gates.splice(i, 1);
      state.misses += 1;
      state.combo = 0;
      fire(state, 'miss');
      if (state.misses >= MISS_LIMIT) {
        state.phase = 'gameover';
        fire(state, 'gameover');
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
    CHART: CHART,
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
    tick: tick
  };
});
