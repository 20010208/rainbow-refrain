const assert = require('node:assert/strict');
const C = require('../SOURCE/src/game-core.js');

// Phase 3A: gameplay notes now come ONLY from the EASY chart (see
// game-core.js's tick()) — a real state's gates fill in from CHART as
// state.time advances, same as procedural spawning used to. Tests that
// exercise judgment logic against hand-crafted synthetic gates (the vast
// majority below) need an otherwise-empty gates array to stay isolated
// from that real chart content, so they "consume" the whole chart upfront
// (chartIdx = CHART.length) before pushing their own test gates — this
// is a TEST-ONLY concern; production always starts with a fresh chart.
function noChart(seed) {
  var s = C.makeState(seed);
  s.chartIdx = C.CHART.length;
  return s;
}

(function testDeterministicStart() {
  const a = C.makeState(20260823);
  const b = C.makeState(20260823);
  assert.deepEqual(C.cloneForTest(a), C.cloneForTest(b));
})();

(function testDeterministicTrace() {
  const a = C.makeState(77);
  const b = C.makeState(77);
  for (let i = 0; i < 100; i++) {
    const input = { lane: i % 3 };
    C.tick(a, input, 0.05);
    C.tick(b, input, 0.05);
  }
  assert.deepEqual(C.cloneForTest(a), C.cloneForTest(b));
})();

(function testLaneBounds() {
  const s = noChart(1);
  C.setLane(s, -9); assert.equal(s.lane, 0);
  C.setLane(s, 99); assert.equal(s.lane, 2);
  C.move(s, -1); assert.equal(s.lane, 1);
  C.move(s, 1); assert.equal(s.lane, 2);
  C.move(s, 1); assert.equal(s.lane, 2);
})();

// overlapRatio(t, color) is now scale-free (no height parameter at all —
// see game-core.js), so a given ratio corresponds to the SAME t regardless
// of viewport. This binary search inverts the REAL exported overlapRatio
// (not a parallel re-derivation), per shape, so boundary tests can never
// drift out of sync with what press() actually computes.
function tForRatio(ratio, color, side) {
  // At ratio exactly 0, r < ratio can never be true (overlapRatio clamps
  // to a non-negative result), so bisection degenerates and always walks
  // toward the outer bound instead of the true zero-crossing. Target a
  // hair above 0 instead — still finds the "just touching" boundary to
  // far more precision than any test needs.
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
// Default shape for tests that don't care which one (color 0 = circle,
// the simplest case: vertical extent == size, no rotation correction).
function tFor(ratio) { return tForRatio(ratio, 0, 'approach'); }
function judgment(ratio) { return C.classify(ratio); }

// --- Section 7/8 visual test cases: driven by actual geometry
// (noteCenterYLogical/targetCenterYLogical/overlapRatio, the real
// functions rendering also uses), not by re-derived formulas or bare t
// literals. ---

(function testCenterCoincidenceRatio1() {
  const noteY = C.noteCenterYLogical(1);
  const targetY = C.targetCenterYLogical();
  // Both are mathematically identical at t=1 but computed via different
  // operation order (A + B*1 vs A*1), so they can land a ULP apart — the
  // same float-noise class documented throughout this project (e.g.
  // 0.18/0.2 != 0.09999999999999998).
  assert.ok(Math.abs(noteY - targetY) < 1e-9, 'setup: note and target centers must coincide (within float tolerance) at t=1');
  assert.equal(C.overlapRatio(1, 0), 1, 'TEST_CENTER_COINCIDENCE_RATIO_1');
})();

(function testCenterCoincidencePerfect() {
  assert.equal(C.classify(C.overlapRatio(1, 0)), 'perfect', 'TEST_CENTER_COINCIDENCE_PERFECT');
})();

(function testMonotonicApproachAndDeparture() {
  let prev = -1;
  for (let t = 0.4; t <= 1; t += 0.05) {
    const r = C.overlapRatio(t, 0);
    assert.ok(r >= prev - 1e-12, 'TEST_GEOMETRIC_RATIO_MONOTONIC_APPROACH: ratio must not decrease as t approaches 1 (t=' + t + ')');
    prev = r;
  }
  prev = 2;
  for (let t = 1; t <= 1.6; t += 0.05) {
    const r = C.overlapRatio(t, 0);
    assert.ok(r <= prev + 1e-12, 'TEST_GEOMETRIC_RATIO_MONOTONIC_DEPARTURE: ratio must not increase as t departs past 1 (t=' + t + ')');
    prev = r;
  }
})();

(function testSmallVisualOverlapMiss() {
  assert.equal(judgment(C.overlapRatio(tFor(0.05), 0)), 'miss', 'TEST_SMALL_VISUAL_OVERLAP_MISS');
})();

(function testModerateVisualOverlapGood() {
  assert.equal(judgment(C.overlapRatio(tFor(0.5), 0)), 'good', 'TEST_MODERATE_VISUAL_OVERLAP_GOOD');
})();

(function testNearCenterVisualOverlapPerfect() {
  assert.equal(judgment(C.overlapRatio(tFor(0.95), 0)), 'perfect', 'TEST_NEAR_CENTER_VISUAL_OVERLAP_PERFECT');
})();

// --- Boundary/regression suite ---

(function testRawZeroOverlapNoop() {
  // Use a t clearly beyond the combined-radii distance so the r<0 clamp
  // definitely fires, avoiding the ambiguous near-boundary zone exercised
  // by the next test, where float noise legitimately leaves a tiny
  // *positive* residual.
  assert.equal(C.overlapRatio(3, 0), 0, 'TEST_RAW_ZERO_OVERLAP_NOOP');
  assert.equal(C.classify(0), 'noop');
})();

(function testRawTinyPositiveOverlapNeverNoop() {
  // A t whose true ratio is a tiny (1e-9) but genuinely positive value —
  // the actual failure mode Codex reported (e.g. 7.77e-16 from float
  // division noise). It must never be misclassified as NO-OP.
  const t = tForRatio(1e-9, 0, 'departure');
  const ratio = C.overlapRatio(t, 0);
  assert.ok(ratio > 0, 'setup: expected a genuinely positive raw ratio near the boundary, got ' + ratio);
  assert.equal(judgment(ratio), 'miss', 'TEST_TINY_POSITIVE_OVERLAP_MISS / TEST_POSITIVE_OVERLAP_NEVER_ROUNDED_TO_NOOP');
})();

(function testOverlapBoundaries() {
  assert.equal(judgment(C.overlapRatio(tFor(0.00001), 0)), 'miss', 'TEST_OVERLAP_TINY_POSITIVE_MISS');
  assert.equal(judgment(C.overlapRatio(tFor(0.001), 0)), 'miss', 'TEST_OVERLAP_0_001_MISS');
  assert.equal(judgment(C.overlapRatio(tFor(0.01), 0)), 'miss');
  assert.equal(judgment(C.overlapRatio(tFor(0.09999), 0)), 'miss', 'TEST_OVERLAP_9_PERCENT_MISS');
  assert.equal(judgment(C.overlapRatio(tFor(0.10), 0)), 'good', 'TEST_OVERLAP_10_PERCENT_GOOD');
  assert.equal(judgment(C.overlapRatio(tFor(0.50), 0)), 'good', 'TEST_OVERLAP_50_PERCENT_GOOD');
  assert.equal(judgment(C.overlapRatio(tFor(0.89999), 0)), 'good', 'TEST_OVERLAP_89_PERCENT_GOOD');
  assert.equal(judgment(C.overlapRatio(tFor(0.90), 0)), 'perfect', 'TEST_OVERLAP_90_PERCENT_PERFECT');
  assert.equal(judgment(C.overlapRatio(tFor(1.00), 0)), 'perfect', 'TEST_OVERLAP_100_PERCENT_PERFECT');
})();

(function testPositiveOverlapNeverNoop() {
  [0.00001, 0.001, 0.01, 0.09999, 0.10, 0.50, 0.89999, 0.90, 1.00].forEach(function(ratio, i) {
    const s = noChart(300 + i);
    s.gates.push({ id: 0, color: 1, t: tForRatio(ratio, 1, 'approach') });
    C.press(s, 1);
    assert.ok(['perfect', 'good', 'miss'].indexOf(s.lastEvent) >= 0,
      'TEST_POSITIVE_OVERLAP_NEVER_NOOP: ratio=' + ratio + ' produced lastEvent=' + s.lastEvent);
    assert.equal(s.gates.length, 0, 'a positive-overlap note must always be judged and removed, ratio=' + ratio);
  });
})();

(function testHighestOverlapNoteSelected() {
  const s = noChart(310);
  s.gates.push({ id: 0, color: 1, t: tForRatio(0.05, 1, 'approach') }); // low overlap: would be MISS if wrongly picked
  s.gates.push({ id: 1, color: 1, t: tForRatio(1.0, 1, 'approach') });  // highest overlap: PERFECT
  C.press(s, 1);
  assert.equal(s.score, C.PERFECT_SCORE, 'TEST_HIGHEST_OVERLAP_NOTE_SELECTED (the higher-overlap candidate is judged)');
  assert.equal(s.gates.length, 1, 'only the selected note is removed');
  assert.equal(s.gates[0].id, 0, 'the lower-overlap note remains unjudged for a later press or pass-by');
})();

(function testNoopLeavesStateUnchanged() {
  const s = noChart(320);
  s.score = 40; s.combo = 3; s.misses = 1;
  s.gates.push({ id: 0, color: 1, t: 3 }); // unambiguously zero overlap
  C.press(s, 1);
  assert.equal(s.score, 40, 'TEST_SCORE_UNCHANGED_ON_NOOP');
  assert.equal(s.combo, 3, 'TEST_COMBO_UNCHANGED_ON_NOOP');
  assert.equal(s.misses, 1, 'TEST_MISS_UNCHANGED_ON_NOOP');
  assert.equal(s.gates.length, 1, 'a zero-overlap note is left in place, not silently deleted');
})();

(function testConsecutiveSameJudgmentsAreDistinguishable() {
  // Regression test for the "blank feedback" bug: game.js used to dedupe
  // the display by comparing state.lastEvent's NAME, so two consecutive
  // PERFECTs (or MISSes) in a row displayed nothing for the second one,
  // even though score/combo genuinely changed. Each judgment must now bump
  // a monotonic eventId so the UI layer can never miss one.
  const s = noChart(330);
  s.gates.push({ id: 0, color: 1, t: 1 });
  C.press(s, 1);
  const firstEventId = s.eventId;
  s.gates.push({ id: 1, color: 1, t: 1 });
  C.press(s, 1);
  assert.notEqual(s.eventId, firstEventId, 'two consecutive PERFECT judgments must have distinct eventIds');
  assert.equal(s.lastEvent, 'perfect');
  assert.equal(s.score, C.PERFECT_SCORE * 2, 'both PERFECTs must have scored');
})();

(function testNoCandidateNoop() {
  const s = noChart(321);
  s.score = 10; s.combo = 2; s.misses = 0;
  C.press(s, 1); // TEST_EMPTY_LANE_NOOP: nothing in this lane at all
  assert.equal(s.score, 10, 'TEST_NO_CANDIDATE_NOOP (score)');
  assert.equal(s.combo, 2, 'TEST_NO_CANDIDATE_NOOP (combo)');
  assert.equal(s.misses, 0, 'TEST_NO_CANDIDATE_NOOP (misses)');
})();

(function testPerfectScoreAndCombo() {
  const s = noChart(123);
  s.gates.push({ id: 0, color: 1, t: 1 });
  C.press(s, 1);
  assert.equal(s.score, C.PERFECT_SCORE, 'TEST_PERFECT_SCORE_100');
  assert.equal(s.combo, 1, 'TEST_PERFECT_COMBO_INCREMENT');
  assert.equal(s.lastEvent, 'perfect');
  assert.equal(s.gates.length, 0, 'a judged note must be removed');
})();

(function testGoodScoreAndCombo() {
  const s = noChart(124);
  s.gates.push({ id: 0, color: 0, t: tForRatio(0.5, 0, 'approach') });
  C.press(s, 0);
  assert.equal(s.score, C.GOOD_SCORE, 'TEST_GOOD_SCORE_50');
  assert.equal(s.combo, 1, 'TEST_GOOD_COMBO_INCREMENT');
  assert.equal(s.lastEvent, 'good');
})();

(function testMissScoreAndComboReset() {
  const s = noChart(125);
  s.combo = 4;
  s.gates.push({ id: 0, color: 2, t: tForRatio(0.001, 2, 'approach') }); // tiny but positive overlap -> real MISS, not NO-OP
  C.press(s, 2);
  assert.equal(s.score, 0, 'TEST_MISS_SCORE_0');
  assert.equal(s.combo, 0, 'TEST_MISS_COMBO_RESET');
  assert.equal(s.misses, 1);
  assert.equal(s.lastEvent, 'miss');
})();

(function testNoteCannotScoreTwice() {
  const s = noChart(126);
  s.gates.push({ id: 0, color: 1, t: 1 });
  C.press(s, 1);
  const scoreAfterFirst = s.score;
  const comboAfterFirst = s.combo;
  C.press(s, 1);
  assert.equal(s.score, scoreAfterFirst, 'TEST_NOTE_CANNOT_SCORE_TWICE (score)');
  assert.equal(s.combo, comboAfterFirst, 'TEST_NOTE_CANNOT_SCORE_TWICE (combo unaffected by no-op)');
})();

(function testWrongLaneCannotScore() {
  const s = noChart(127);
  s.gates.push({ id: 0, color: 0, t: 1 });
  C.press(s, 2);
  assert.equal(s.score, 0, 'TEST_WRONG_LANE_CANNOT_SCORE (score)');
  assert.equal(s.misses, 0, 'wrong-lane press is a no-op, not a miss');
  assert.equal(s.gates.length, 1, 'the note in the correct lane remains unjudged');
})();

(function testPassByCountsOneMiss() {
  // Pass-by timing is still the separate, t-only OVERLAP_WINDOW (see
  // game-core.js comment) — unaffected by the geometric judgment change.
  const s = noChart(128);
  s.gates.push({ id: 0, color: 1, t: 1 + C.OVERLAP_WINDOW });
  C.tick(s, {}, 0.001);
  assert.equal(s.misses, 1, 'TEST_PASS_BY_COUNTS_ONE_MISS');
  assert.equal(s.combo, 0);
  assert.equal(s.gates.length, 0, 'the passed note must be removed');
  C.tick(s, {}, 0.001);
  assert.equal(s.misses, 1, 'the same pass-by miss must not be counted twice');
})();

(function testThreeMissGameOverUnchanged() {
  const s = noChart(129);
  for (let i = 0; i < 3; i++) {
    s.gates.push({ id: i, color: 0, t: tForRatio(0.001, 0, 'approach') }); // tiny but positive overlap -> real MISS
    C.press(s, 0);
  }
  assert.equal(s.phase, 'gameover', 'TEST_GAMEOVER_UNCHANGED');
  assert.equal(s.misses, C.MISS_LIMIT);
  assert.equal(s.lastEvent, 'gameover');
})();

// Data-layer prerequisite for TEST_THIRD_MISS_FEEDBACK_BEFORE_GAMEOVER (the
// actual display-sequencing check lives in TESTS/runtime.test.js, since it
// needs the DOM-facing queue-draining code in game.js): the third miss must
// leave BOTH a 'miss' and a 'gameover' entry in state.events, in that order
// — neither may overwrite or skip the other in the underlying event data.
(function testThirdMissEventQueueHasBothEntries() {
  const s = noChart(131);
  const missT = tForRatio(0.001, 0, 'approach');
  s.gates.push({ id: 0, color: 0, t: missT });
  C.press(s, 0);
  s.gates.push({ id: 1, color: 0, t: missT });
  C.press(s, 0);
  s.gates.push({ id: 2, color: 0, t: missT });
  s.events.length = 0; // isolate just the third press's events
  C.press(s, 0);
  assert.equal(s.events.length, 2, 'TEST_THIRD_MISS_FEEDBACK_BEFORE_GAMEOVER (event count)');
  assert.equal(s.events[0].name, 'miss', 'the miss event must be queued first');
  assert.equal(s.events[1].name, 'gameover', 'gameover must be queued after, not instead of, the miss');
})();

// Repeated identical judgments must each leave their OWN queue entry —
// this is what makes TEST_REPEAT_PERFECT_FEEDBACK / TEST_REPEAT_GOOD_FEEDBACK
// / TEST_REPEAT_MISS_FEEDBACK possible at the display layer.
(function testRepeatedJudgmentsEachQueueSeparately() {
  const perfect = noChart(132);
  perfect.gates.push({ id: 0, color: 0, t: 1 });
  perfect.gates.push({ id: 1, color: 1, t: 1 });
  C.press(perfect, 0);
  C.press(perfect, 1);
  assert.equal(perfect.events.length, 2, 'TEST_REPEAT_PERFECT_FEEDBACK');
  assert.deepEqual(perfect.events.map(function(e) { return e.name; }), ['perfect', 'perfect']);

  const good = noChart(133);
  good.gates.push({ id: 0, color: 0, t: tForRatio(0.5, 0, 'approach') });
  good.gates.push({ id: 1, color: 1, t: tForRatio(0.5, 1, 'approach') });
  C.press(good, 0);
  C.press(good, 1);
  assert.equal(good.events.length, 2, 'TEST_REPEAT_GOOD_FEEDBACK');
  assert.deepEqual(good.events.map(function(e) { return e.name; }), ['good', 'good']);

  const miss = noChart(134);
  miss.gates.push({ id: 0, color: 0, t: tForRatio(0.001, 0, 'approach') });
  miss.gates.push({ id: 1, color: 1, t: tForRatio(0.001, 1, 'approach') });
  C.press(miss, 0);
  C.press(miss, 1);
  assert.equal(miss.events.length, 2, 'TEST_REPEAT_MISS_FEEDBACK');
  assert.deepEqual(miss.events.map(function(e) { return e.name; }), ['miss', 'miss']);
})();

(function testPressLaneMappingUnchanged() {
  const s = noChart(130);
  C.press(s, 2);
  assert.equal(s.lane, 2, 'TEST_A_S_D_MAPPING_UNCHANGED (D -> lane 2)');
  C.press(s, 0);
  assert.equal(s.lane, 0, 'TEST_A_S_D_MAPPING_UNCHANGED (A -> lane 0)');
  C.press(s, 1);
  assert.equal(s.lane, 1, 'TEST_A_S_D_MAPPING_UNCHANGED (S -> lane 1)');
})();

(function testDirectLaneKeyMapping() {
  // Mirrors game.js keydown semantics: A/S/D call C.setLane(state, 0/1/2) directly.
  var s = noChart(5);
  C.setLane(s, 2);
  C.setLane(s, 0);
  assert.equal(s.lane, 0, 'A should select the left lane directly');

  C.setLane(s, 0);
  C.setLane(s, 2);
  assert.equal(s.lane, 2, 'D should select the right lane directly from the left lane');

  C.setLane(s, 2);
  C.setLane(s, 0);
  assert.equal(s.lane, 0, 'A should select the left lane directly from the right lane');

  C.setLane(s, 0);
  C.setLane(s, 1);
  assert.equal(s.lane, 1, 'S should select the center lane directly from the left lane');
  C.setLane(s, 2);
  C.setLane(s, 1);
  assert.equal(s.lane, 1, 'S should select the center lane directly from the right lane');

  C.setLane(s, 1);
  C.setLane(s, 1);
  assert.equal(s.lane, 1, 'pressing the current lane key again should be a safe no-op');
})();

(function testPostGameIsStable() {
  const s = noChart(9);
  s.phase = 'gameover'; // once terminal, tick() must be a complete no-op regardless of input
  const before = C.cloneForTest(s);
  C.tick(s, { lane: 2 }, 0.1);
  assert.deepEqual(C.cloneForTest(s), before);
})();

// Ticks in <=0.1s steps (the same clamp tick() itself applies per call),
// matching real per-frame dt accumulation over many seconds.
function advance(state, seconds, input) {
  let remaining = seconds;
  while (remaining > 0) {
    const step = Math.min(0.1, remaining);
    C.tick(state, input || {}, step);
    remaining -= step;
  }
}

// These isolate the 90s run-duration boundary from the separate (and
// already-tested) pass-by-miss mechanic: left to run untouched, a real 90s
// playthrough naturally reaches gameover via accumulated misses long before
// the timer would, which is correct but would make a time-only test
// meaningless. Setting state.time directly targets just the timer logic.
(function testRunBefore90SecondsStillRunning() {
  const s = noChart(500);
  s.time = 89.9;
  C.tick(s, {}, 0.05);
  assert.equal(s.phase, 'run', 'TEST_RUN_BEFORE_90_SECONDS_STILL_RUNNING');
})();

(function testRunAt90SecondsComplete() {
  const s = noChart(501);
  s.time = 89.99;
  C.tick(s, {}, 0.05);
  assert.equal(s.phase, 'complete', 'TEST_RUN_AT_90_SECONDS_COMPLETE');
  assert.equal(s.lastEvent, 'complete');
})();

(function testRunAfter90SecondsNoScoreMutation() {
  const s = noChart(502);
  s.time = 89.99;
  C.tick(s, {}, 0.05);
  assert.equal(s.phase, 'complete');
  const scoreAtComplete = s.score;
  const missesAtComplete = s.misses;
  s.gates.push({ id: 999, color: 1, t: 1 });
  C.press(s, 1);
  advance(s, 5);
  assert.equal(s.score, scoreAtComplete, 'TEST_RUN_AFTER_90_SECONDS_NO_SCORE_MUTATION');
  assert.equal(s.misses, missesAtComplete);
})();

(function testRunAfter90SecondsNoNewSpawns() {
  const s = noChart(503);
  s.time = 89.99;
  C.tick(s, {}, 0.05);
  assert.equal(s.phase, 'complete');
  const gatesAtComplete = s.gates.length;
  advance(s, 5);
  assert.equal(s.gates.length, gatesAtComplete, 'TEST_RUN_AFTER_90_SECONDS_NO_NEW_SPAWNS');
})();

(function testGameoverBefore90StillWorks() {
  const s = noChart(504);
  for (let i = 0; i < 3; i++) {
    s.gates.push({ id: i, color: 0, t: tForRatio(0.001, 0, 'approach') });
    C.press(s, 0);
  }
  assert.equal(s.phase, 'gameover', 'TEST_GAMEOVER_BEFORE_90_STILL_WORKS');
  assert.ok(s.time < 90, 'a fast game-over must happen long before the 90s run timer');
})();

(function testRestartAfterRunComplete() {
  const s = noChart(505);
  s.time = 89.99;
  C.tick(s, {}, 0.05);
  assert.equal(s.phase, 'complete');
  const fresh = noChart(505); // this is exactly what game.js's reset() does
  assert.equal(fresh.phase, 'run', 'TEST_RESTART_AFTER_RUN_COMPLETE');
  assert.equal(fresh.time, 0);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.gates.length, 0);
})();

(function testRestartTimerZero() {
  const s = noChart(506);
  assert.equal(s.time, 0, 'TEST_RESTART_TIMER_ZERO');
})();

(function testNotePositionMonotonic() {
  const s = noChart(510);
  s.gates.push({ id: 9990, color: 1, t: 0 }); // id kept clear of the auto-spawn sequence (starts at 0)
  let prevT = -1;
  for (let i = 0; i < 70; i++) {
    C.tick(s, {}, 0.05);
    const g = s.gates.find(function(x) { return x.id === 9990; });
    if (!g) break;
    assert.ok(g.t > prevT, 'TEST_NOTE_POSITION_MONOTONIC: t must strictly increase every tick, never plateau');
    prevT = g.t;
  }
  assert.ok(prevT > 1, 'the note must have travelled past its judgment center before removal');
})();

(function testNoteNeverStopsAndContinuesThroughCenter() {
  const s = noChart(511);
  s.gates.push({ id: 9991, color: 1, t: 1 - 0.05 }); // start just before the judgment center
  let sawPastCenter = false;
  let lastT = -1;
  let removed = false;
  for (let i = 0; i < 50 && !removed; i++) {
    C.tick(s, {}, 0.02);
    const g = s.gates.find(function(x) { return x.id === 9991; });
    if (!g) { removed = true; break; }
    assert.ok(g.t > lastT, 'TEST_NOTE_NEVER_STOPS_AT_TARGET: t must not plateau, including at t=1');
    lastT = g.t;
    if (g.t > 1) sawPastCenter = true;
  }
  assert.ok(sawPastCenter, 'TEST_NOTE_CONTINUES_THROUGH_CENTER');
  assert.ok(removed, 'TEST_NOTE_EXITS_JUDGMENT_ZONE: the note must eventually leave state.gates');
})();

(function testUnpressedNoteBecomesMissAfterPassAndIsRemovedOnce() {
  const s = noChart(512);
  s.gates.push({ id: 0, color: 2, t: 1 + C.OVERLAP_WINDOW });
  C.tick(s, {}, 0.001);
  assert.equal(s.misses, 1, 'TEST_UNPRESSED_NOTE_BECOMES_MISS_AFTER_PASS');
  assert.equal(s.gates.length, 0, 'TEST_UNPRESSED_NOTE_REMOVED_AFTER_MISS');
  C.tick(s, {}, 0.001);
  assert.equal(s.misses, 1, 'TEST_PASS_BY_MISS_ONLY_ONCE');
})();

// TEST_RENDER_AND_OVERLAP_USE_SAME_PROGRESS: game.js's drawGate() renders
// position via C.noteCenterYLogical(gate.t), the exact same function
// overlapRatio() derives distance from internally — so a note's visible
// position and its judged overlap literally cannot diverge; there's only
// one geometry.
(function testRenderAndOverlapUseSameProgress() {
  assert.equal(C.overlapRatio(1, 0), 1, 'overlapRatio treats t=1 (the rendered judgment-line position) as full overlap');
  assert.equal(C.overlapRatio(3, 0), 0, 'overlapRatio treats a t well past the rendered exit point as zero overlap');
})();

// ============================================================
// Codex re-audit: viewport-invariant judgment (section 1/2/12/13)
// ============================================================
// overlapRatio(t, color) takes no height/viewport parameter at all anymore
// — it is a pure function of (t, color). This is the actual fix: it is now
// STRUCTURALLY IMPOSSIBLE for the same t to classify differently at
// different viewport sizes, because there is no viewport input to differ.
// These tests prove that invariant concretely, including the literal
// t=0.9 case Codex measured as GOOD/GOOD/MISS/NO-OP across four viewports
// under the old (buggy) fixed-pixel-radius model.

(function testViewportRatioAndClassificationInvariance() {
  // Every t Codex asked for: no-overlap approach, tiny overlap, MISS,
  // GOOD, near-perfect, center, departure GOOD, departure MISS,
  // departure no-overlap.
  const sampleTs = [
    tForRatio(0, 0, 'approach') - 0.05,        // no overlap (approach)
    tForRatio(0.001, 0, 'approach'),           // tiny overlap
    tForRatio(0.05, 0, 'approach'),            // MISS region
    tForRatio(0.5, 0, 'approach'),             // GOOD region
    tForRatio(0.95, 0, 'approach'),            // near-perfect
    1,                                          // center
    tForRatio(0.5, 0, 'departure'),            // departure GOOD
    tForRatio(0.05, 0, 'departure'),           // departure MISS
    tForRatio(0, 0, 'departure') + 0.05         // departure no-overlap
  ];
  // "Viewport" no longer exists as an input to overlapRatio; calling the
  // real function twice at the same t, simulating what would have been
  // two different viewport calls under the old API, must be identical —
  // TEST_VIEWPORT_RATIO_INVARIANCE / TEST_VIEWPORT_CLASSIFICATION_INVARIANCE.
  sampleTs.forEach(function(t) {
    const r1 = C.overlapRatio(t, 0);
    const r2 = C.overlapRatio(t, 0);
    assert.equal(r1, r2, 'TEST_VIEWPORT_RATIO_INVARIANCE at t=' + t);
    assert.equal(C.classify(r1), C.classify(r2), 'TEST_VIEWPORT_CLASSIFICATION_INVARIANCE at t=' + t);
  });
})();

(function testT09ClassificationMatchesAcrossAllRequiredViewports() {
  // Codex's literal reported case: t=0.9 measured GOOD/GOOD/MISS/NO-OP
  // across 1280x720 / 1366x768 / 1920x1080 / 900x1600 under the old
  // fixed-pixel-radius model. overlapRatio no longer accepts a height, so
  // this reproduces "the same real judgment call at t=0.9" for each of the
  // four required viewports and confirms they are now identical.
  const t = 0.9;
  const classes = { '1280x720': null, '1366x768': null, '1920x1080': null, '900x1600': null };
  Object.keys(classes).forEach(function(name) {
    // heightPx is irrelevant to overlapRatio now (by construction — see
    // game-core.js), which IS the fix; still invoked once per named
    // viewport for a legible, explicit report rather than one bare call.
    const ratio = C.overlapRatio(t, 0);
    classes[name] = C.classify(ratio);
  });
  assert.equal(classes['1280x720'], classes['1366x768'], 'CLASS_1280x720_T09 must equal CLASS_1366x768_T09');
  assert.equal(classes['1366x768'], classes['1920x1080'], 'CLASS_1366x768_T09 must equal CLASS_1920x1080_T09');
  assert.equal(classes['1920x1080'], classes['900x1600'], 'CLASS_1920x1080_T09 must equal CLASS_900x1600_T09');
  global.__t09Classes = classes;
})();

(function testHitWindowDurationInvariance() {
  // The t-to-real-seconds mapping is gate.t * TRAVEL, unrelated to
  // viewport height — so once overlapRatio/classify no longer depend on
  // height either, the SECONDS width of every judgment tier is fixed by
  // construction. Compute the actual boundary t values (approach and
  // departure) via the real overlapRatio, convert to seconds, and report.
  const anyOverlapApproachT = tForRatio(0, 0, 'approach');
  const anyOverlapDepartureT = tForRatio(0, 0, 'departure');
  const goodApproachT = tForRatio(C.GOOD_RATIO, 0, 'approach');
  const goodDepartureT = tForRatio(C.GOOD_RATIO, 0, 'departure');
  const perfectApproachT = tForRatio(C.PERFECT_RATIO, 0, 'approach');
  const perfectDepartureT = tForRatio(C.PERFECT_RATIO, 0, 'departure');

  const anyOverlapWindowSeconds = (anyOverlapDepartureT - anyOverlapApproachT) * C.TRAVEL;
  const missWindowSeconds = anyOverlapWindowSeconds - ((goodDepartureT - goodApproachT) * C.TRAVEL);
  const goodWindowSeconds = (goodDepartureT - goodApproachT) * C.TRAVEL - (perfectDepartureT - perfectApproachT) * C.TRAVEL;
  const perfectWindowSeconds = (perfectDepartureT - perfectApproachT) * C.TRAVEL;

  assert.ok(anyOverlapWindowSeconds > 0 && perfectWindowSeconds > 0 && perfectWindowSeconds < anyOverlapWindowSeconds,
    'TEST_HIT_WINDOW_DURATION_INVARIANCE: window ordering sanity');

  // No height parameter exists to vary "by viewport" any more — this is
  // the fix itself, reported as identical values for all four required
  // sizes (previously Codex measured ~0.726s at 720px vs ~0.327s at
  // 1600px; that variation is now structurally impossible).
  global.__hitWindows = {
    ANY_OVERLAP_WINDOW_SECONDS_BY_VIEWPORT: { '1280x720': anyOverlapWindowSeconds, '1366x768': anyOverlapWindowSeconds, '1920x1080': anyOverlapWindowSeconds, '900x1600': anyOverlapWindowSeconds },
    MISS_WINDOW_SECONDS: missWindowSeconds,
    GOOD_WINDOW_SECONDS: goodWindowSeconds,
    PERFECT_WINDOW_SECONDS_BY_VIEWPORT: { '1280x720': perfectWindowSeconds, '1366x768': perfectWindowSeconds, '1920x1080': perfectWindowSeconds, '900x1600': perfectWindowSeconds }
  };
})();

// ============================================================
// Codex re-audit: true rendered shape extent (section 6/7/8/14)
// ============================================================
// Shape-specific contact-boundary tests at the abstract ratio level (the
// REAL canvas-path-level version, comparing against actual captured draw
// calls per section 15, lives in TESTS/runtime.test.js). color 0=circle,
// 1=diamond (GOLD, rotated), 2=square (CYAN, axis-aligned).

['0 (circle)', '1 (diamond)', '2 (square)'].forEach(function(label, color) {
  (function testShapeContactBoundaries() {
    // A) visually separated -> ratio 0
    assert.equal(C.overlapRatio(3, color), 0, 'shape ' + label + ': far apart must be ratio 0');
    // B) just touching -> ratio 0 (boundary itself, from the real inverse)
    const touchT = tForRatio(0, color, 'departure');
    assert.ok(Math.abs(C.overlapRatio(touchT, color)) < 1e-6, 'shape ' + label + ': just touching must be ~ratio 0');
    // C) tiny positive visual overlap -> ratio >0 and MISS
    const tinyT = tForRatio(0.0005, color, 'approach');
    const tinyRatio = C.overlapRatio(tinyT, color);
    assert.ok(tinyRatio > 0, 'shape ' + label + ': tiny overlap must be positive');
    assert.equal(C.classify(tinyRatio), 'miss', 'shape ' + label + ': tiny overlap must classify MISS');
    // D) moderate visible overlap -> GOOD
    assert.equal(C.classify(C.overlapRatio(tForRatio(0.5, color, 'approach'), color)), 'good', 'shape ' + label + ': moderate overlap must be GOOD');
    // E) near-center -> PERFECT
    assert.equal(C.classify(C.overlapRatio(tForRatio(0.95, color, 'approach'), color)), 'perfect', 'shape ' + label + ': near-center must be PERFECT');
    // F) center coincidence -> ratio 1 / PERFECT
    assert.equal(C.overlapRatio(1, color), 1, 'shape ' + label + ': center coincidence must be ratio 1');
    assert.equal(C.classify(C.overlapRatio(1, color)), 'perfect', 'shape ' + label + ': center coincidence must be PERFECT');
    // G) same checks after passing center (departure side)
    assert.equal(C.classify(C.overlapRatio(tForRatio(0.5, color, 'departure'), color)), 'good', 'shape ' + label + ': departure moderate overlap must be GOOD');
    const departureTiny = tForRatio(0.0005, color, 'departure');
    assert.equal(C.classify(C.overlapRatio(departureTiny, color)), 'miss', 'shape ' + label + ': departure tiny overlap must be MISS');
  })();
});

// Section 7: the diamond's true extent must differ from the circle/square
// (do not assume they match) — verified directly via the exported formula,
// cross-checked against real canvas path data in runtime.test.js.
(function testDiamondExtentDiffersFromCircleSquare() {
  const size = C.NOTE_MAX_SIZE;
  assert.equal(C.noteExtent(1, 0), size, 'circle extent must equal size');
  assert.equal(C.noteExtent(1, 2), size, 'axis-aligned square extent must equal size');
  const diamondExtent = C.noteExtent(1, 1);
  assert.notEqual(diamondExtent, size, 'TEST_DIAMOND_CONTACT_BOUNDARIES setup: diamond extent must NOT equal circle/square extent');
  assert.ok(diamondExtent > size, 'the rotated diamond is visually larger vertically than its own "size" parameter');
  assert.equal(diamondExtent, C.diamondHalfExtent(size), 'noteExtent must delegate to the real diamondHalfExtent formula');
})();

// ============================================================
// Phase 1.2: result statistics (perfects/goods/maxCombo; MISS count
// reuses the existing state.misses — see game-core.js press()).
// ============================================================
(function testFreshStateStatsAreZero() {
  const s = noChart(1);
  assert.equal(s.perfects, 0, 'TEST_STATS_RESET_ON_FRESH_START: perfects must start at 0');
  assert.equal(s.goods, 0, 'TEST_STATS_RESET_ON_FRESH_START: goods must start at 0');
  assert.equal(s.maxCombo, 0, 'TEST_STATS_RESET_ON_FRESH_START: maxCombo must start at 0');
})();

(function testPerfectIncrementsPerfectCountOnly() {
  const s = noChart(2);
  s.gates.push({ id: 1, color: 0, t: 1 }); // exact center: PERFECT
  C.press(s, 0);
  assert.equal(s.perfects, 1, 'TEST_PERFECT_COUNT: a real PERFECT judgment must increment perfects');
  assert.equal(s.goods, 0, 'a PERFECT must not also increment goods');
  assert.equal(s.misses, 0, 'a PERFECT must not also increment misses');
})();

(function testGoodIncrementsGoodCountOnly() {
  const s = noChart(3);
  s.gates.push({ id: 1, color: 0, t: tFor(0.5) }); // moderate overlap: GOOD
  C.press(s, 0);
  assert.equal(s.goods, 1, 'TEST_GOOD_COUNT: a real GOOD judgment must increment goods');
  assert.equal(s.perfects, 0, 'a GOOD must not also increment perfects');
  assert.equal(s.misses, 0, 'a GOOD must not also increment misses');
})();

(function testMissCountReusesExistingMissesField() {
  const s = noChart(4);
  // Pressed MISS (tiny positive overlap): the existing misses counter,
  // not a new/duplicate field, is what the result screen must read.
  s.gates.push({ id: 1, color: 0, t: tForRatio(0.0005, 0, 'approach') });
  C.press(s, 0);
  assert.equal(s.misses, 1, 'TEST_MISS_COUNT: a pressed MISS must increment the existing misses field');
  // Pass-by MISS (never pressed) must count the same way.
  s.gates.push({ id: 2, color: 1, t: 1 + C.OVERLAP_WINDOW });
  C.tick(s, {}, 0.001);
  assert.equal(s.misses, 2, 'TEST_MISS_COUNT: a pass-by MISS must also increment the same misses field');
  assert.equal(s.perfects, 0);
  assert.equal(s.goods, 0);
})();

(function testMaxComboTracksActualPeakNotFinalCombo() {
  const s = noChart(5);
  for (let i = 0; i < 3; i++) { s.gates.push({ id: i, color: 0, t: 1 }); C.press(s, 0); }
  assert.equal(s.combo, 3, 'setup: combo must be 3 after three PERFECTs');
  assert.equal(s.maxCombo, 3, 'TEST_MAX_COMBO_INCREASES: maxCombo must track the peak combo reached');

  // Break the combo with a MISS: current combo drops, but the peak must
  // NOT be silently derived from (and therefore lost with) the final combo.
  s.gates.push({ id: 9, color: 0, t: tForRatio(0.0005, 0, 'approach') });
  C.press(s, 0);
  assert.equal(s.combo, 0, 'setup: combo must reset to 0 after a MISS');
  assert.equal(s.maxCombo, 3, 'TEST_MAX_COMBO_DOES_NOT_DECREASE: maxCombo must remain at its earlier peak after the combo breaks');

  // One more PERFECT: a fresh, lower combo must not overwrite the higher peak.
  s.gates.push({ id: 10, color: 0, t: 1 });
  C.press(s, 0);
  assert.equal(s.combo, 1);
  assert.equal(s.maxCombo, 3, 'a new, lower combo must not reduce maxCombo');
})();

// ============================================================
// Phase 3A: EASY chart v1 integration
// ============================================================
const fs = require('node:fs');
const path = require('node:path');

// LEGACY/ARCHIVED FIXTURE (Phase 3B.2): these two tests used to read
// REFERENCES/rainbow_refrain_easy_chart_v1.csv directly. That file was
// deleted from REFERENCES/ when the playtest build moved on to EASY chart
// v2 (REFERENCES/rainbow_refrain_easy_chart_v2.csv, 82 notes) — but
// SOURCE/ (this suite's target) was never touched and still compiles the
// original 118-note v1 chart from the digit-string encoding below, so the
// regression these tests exist to catch is still real and still active.
// Per Phase 3B.2 spec: do NOT rename v2->v1, do NOT touch SOURCE/ chart
// content just to dodge a missing file — instead embed the known-good v1
// delta/lane digit strings as an in-test fixture (verbatim copy of the
// same two literals in SOURCE/src/game-core.js) and decode them here with
// the identical formula, so this suite no longer depends on any external
// REFERENCES/ file that may or may not still exist.
const EASY_V1_FIXTURE_D = '0442222222222222222222222222222222222222222222222222222222222224444222221122211222112222222112221121121122222222222222';
const EASY_V1_FIXTURE_L = '0121021201210212012102120121021201210212012102120121021201210212012102120121021201210212012102120121021201210212012102';

function decodeEasyV1Fixture() {
  const out = [];
  let b = 0;
  for (let i = 0; i < EASY_V1_FIXTURE_D.length; i++) {
    b += +EASY_V1_FIXTURE_D[i];
    out.push({ t: .294 + b * .384, lane: +EASY_V1_FIXTURE_L[i] });
  }
  return out;
}

(function testChartSourceHas118Events() {
  const fixture = decodeEasyV1Fixture();
  assert.equal(fixture.length, 118, 'EASY_CHART_SOURCE_NOTE_COUNT: the v1 fixture must decode to exactly 118 events');
})();

(function testRuntimeChartMatchesSourceExactly() {
  const fixture = decodeEasyV1Fixture();
  assert.equal(C.CHART.length, 118, 'EASY_CHART_RUNTIME_NOTE_COUNT: the compiled runtime chart must also contain exactly 118 events');
  fixture.forEach((n, i) => {
    assert.ok(Math.abs(C.CHART[i].t - n.t) < 1e-6, 'chart event ' + i + ': hit time must match the v1 fixture exactly (got ' + C.CHART[i].t + ', expected ' + n.t + ')');
    assert.equal(C.CHART[i].lane, n.lane, 'chart event ' + i + ': lane must match the v1 fixture exactly');
  });
})();

(function testChartLanesAllValid() {
  C.CHART.forEach((n, i) => assert.ok(n.lane === 0 || n.lane === 1 || n.lane === 2, 'chart event ' + i + ': lane must be 0, 1, or 2 — got ' + n.lane));
})();

(function testChartOrderingMonotonic() {
  for (let i = 1; i < C.CHART.length; i++) {
    assert.ok(C.CHART[i].t > C.CHART[i - 1].t, 'chart hit times must be strictly increasing: event ' + i + ' (' + C.CHART[i].t + ') must be after event ' + (i - 1) + ' (' + C.CHART[i - 1].t + ')');
  }
})();

(function testFirstAndLastHitTime() {
  assert.ok(Math.abs(C.CHART[0].t - 0.294) < 1e-9, 'FIRST_HIT_TIME must be 0.294');
  assert.ok(Math.abs(C.CHART[C.CHART.length - 1].t - 89.382) < 1e-9, 'LAST_HIT_TIME must be 89.382');
  assert.ok(C.CHART[C.CHART.length - 1].t < C.RUN_DURATION, 'the last chart hit must land well inside the 90-second run');
})();

(function testChartSpawnTimingAccountsForTravel() {
  // CSV time_sec is HIT time, not spawn time: spawnTime = hitTime - TRAVEL.
  // The first TWO notes (hit times 0.294 and 1.83) both have a spawn time
  // before t=0 (0.294-2.25 and 1.83-2.25 are both negative), so both must
  // already be present — already mid-flight — on the very first tick.
  const s = C.makeState(1);
  C.tick(s, {}, 0.001);
  assert.equal(s.gates.length, 2, 'the first two chart notes must already be spawned (mid-flight) at the very start of the run');
  const expectedT0 = (s.time - (C.CHART[0].t - C.TRAVEL)) / C.TRAVEL;
  assert.ok(Math.abs(s.gates[0].t - expectedT0) < 1e-9, 'CHART_HIT_TIMING_MODEL: initial t must derive from absolute elapsed time versus (hitTime - TRAVEL), not reset to 0');
  assert.equal(s.gates[0].color, C.CHART[0].lane, 'the first spawned gate lane must match its chart event lane');
  assert.equal(s.gates[1].color, C.CHART[1].lane, 'the second spawned gate lane must match its chart event lane');
})();

(function testChartNoteNotSpawnedBeforeItsWindow() {
  // Chart event 3 (0-based) is at hitTime 4.134 -> spawnTime 1.884. Just
  // before that, it must not exist yet; just at/after, it must.
  const s = C.makeState(2);
  const spawnTime = C.CHART[3].t - C.TRAVEL;
  while (s.time < spawnTime - 0.05) C.tick(s, {}, 0.05);
  assert.ok(s.chartIdx <= 3, 'setup: must not have spawned event 3 yet');
  while (s.chartIdx <= 3) C.tick(s, {}, 0.01);
  assert.ok(s.time >= spawnTime - 1e-6, 'event 3 must not spawn before its computed spawn time');
})();

(function testChartFirstEventReachesJudgmentAtItsHitTime() {
  // Ticking exactly to the first hit time must leave that note at t=1
  // (dead center — PERFECT), proving the CSV's time_sec really is treated
  // as the intended JUDGMENT time, not the spawn time.
  const s = C.makeState(3);
  let guard = 0;
  while (s.time < C.CHART[0].t && guard++ < 10000) C.tick(s, {}, 0.001);
  assert.ok(Math.abs(s.gates[0].t - 1) < 0.01, 'the first chart note must reach t=1 (judgment line) right around its CSV hit time, got t=' + s.gates[0].t);
})();

(function testChartLastEventScheduledCorrectly() {
  // Isolated from judgment/miss accumulation (see testFullRunSpawns...)
  // so only spawn timing itself is under test here.
  const s = C.makeState(4);
  const spawnTime = C.CHART[117].t - C.TRAVEL;
  let guard = 0;
  while (s.time < spawnTime + 0.02 && guard++ < 20000) { C.tick(s, {}, 0.01); s.gates.length = 0; }
  assert.equal(s.chartIdx, 118, 'the final chart event must have spawned by just after its computed spawn time');
})();

(function testFullRunSpawnsExactly118NotesNoDuplicates() {
  // Isolates spawn coverage from judgment/miss accumulation (a separate,
  // already-tested concern) by clearing gates right after each tick —
  // well inside TRAVEL, so pass-by MISS never has a chance to trigger and
  // end the run early; chartIdx alone is purely time-driven regardless.
  const s = C.makeState(5);
  let guard = 0;
  while (s.time < C.RUN_DURATION && guard++ < 10000) {
    C.tick(s, {}, 0.05);
    s.gates.length = 0;
  }
  assert.equal(s.phase, 'complete', 'setup: the run must reach natural completion to observe the full chart');
  assert.equal(s.chartIdx, 118, 'every chart event must have spawned exactly once by the end of a full run');
})();

(function testGameOverStopsFutureChartSpawning() {
  const s = C.makeState(6);
  s.phase = 'gameover';
  const idxBefore = s.chartIdx;
  C.tick(s, {}, 1); // a large dt that would otherwise cross many chart spawn times
  assert.equal(s.chartIdx, idxBefore, 'GAME_OVER_CHART_STOP: no further chart spawning once phase is gameover');
})();

(function testRunCompleteStopsFutureChartSpawning() {
  const s = C.makeState(7);
  s.phase = 'complete';
  const idxBefore = s.chartIdx;
  C.tick(s, {}, 1);
  assert.equal(s.chartIdx, idxBefore, 'RUN_COMPLETE_CHART_STOP: no further chart spawning once phase is complete');
})();

(function testHoldCandidateCompilesAsPlainTap() {
  // Gate objects carry no "type"/hold field at all — every chart-spawned
  // gate (whatever its source CSV row's `type`) is judged by the exact
  // same overlapRatio/classify path as any other note.
  const s = C.makeState(8);
  C.tick(s, {}, 0.001);
  assert.deepEqual(Object.keys(s.gates[0]).sort(), ['color', 't'], 'HOLD_CANDIDATE_CURRENT_BEHAVIOR: a chart-spawned gate must be an ordinary {color,t} note — no hold-specific fields exist yet');
})();

(function testNoProceduralRandomFieldOnState() {
  const s = C.makeState(9);
  assert.equal('random' in s, false, 'PROCEDURAL_NOTE_GENERATION_DISABLED: state must no longer carry a PRNG field');
  assert.equal('nextGate' in s, false, 'the old procedural spawn-timer field must be gone');
})();

console.log('core tests: PASS');
