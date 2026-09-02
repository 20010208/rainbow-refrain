const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mvpRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(mvpRoot, 'SOURCE');
const read = (p) => fs.readFileSync(path.join(sourceRoot, p), 'utf8');
const index = read('index.html');
const core = read('src/game-core.js');
const adapter = read('src/wavedash-adapter.js');
const game = read('src/game.js');

assert.match(index, /src\/game-core\.js/);
assert.match(index, /src\/wavedash-adapter\.js/);
assert.match(index, /src\/game\.js/);
assert.doesNotMatch(index + core + adapter + game, /https?:\/\//i, 'MVP must have no external URLs');
assert.doesNotMatch(index + core + adapter + game, /\b(fetch|XMLHttpRequest|WebSocket)\b/, 'MVP must make no external network calls');
assert.doesNotMatch(index + core + adapter + game, /\b(?:cdn|unpkg|jsdelivr)\b/i, 'MVP must have no CDN dependency');
assert.doesNotMatch(index + core + adapter + game, /<img\b|<audio\b|<video\b|url\(/i, 'MVP must have no external asset element');
assert.match(index, /Canvas 2D|canvas/i);
assert.match(game, /AudioContext|webkitAudioContext/);
assert.match(game, /tones = \[330, 440, 550\]/, 'MVP must define three explicit WebAudio tones');
assert.match(adapter, /RainbowRefrainWavedash/);
assert.match(adapter, /Wavedash/);
assert.match(game, /RainbowRefrainWavedash\.init/);
assert.doesNotMatch(core, /Wavedash/);
assert.match(core, /MISS_LIMIT = 3/);
assert.match(core, /COLORS = \['#ff4f91', '#ffd447', '#55d6ff'\]/);
assert.match(game, /C\.press\(state, 0\)/, 'A must select and judge the left lane directly');
assert.match(game, /C\.press\(state, 1\)/, 'S must select and judge the center lane directly');
assert.match(game, /C\.press\(state, 2\)/, 'D must select and judge the right lane directly');
assert.match(game, /C\.press\(state, laneFromPointer\(e\)\)/, 'pointer press must also judge');
// Viewport-invariant judgment (Codex re-audit HIGH finding): press() must
// NOT take a height/viewport argument at all — overlapRatio is scale-free
// (see below), so there is nothing viewport-dependent left to pass in.
assert.doesNotMatch(game, /C\.press\([^)]*height/, 'press() must not receive a viewport-dependent argument');
assert.match(core, /OVERLAP_WINDOW = 0\.2/);
assert.match(core, /PERFECT_RATIO = 0\.9/);
assert.match(core, /GOOD_RATIO = 0\.1/);
assert.match(core, /RUN_DURATION = 90/, 'the run must be a fixed 90 seconds');
assert.match(core, /state\.time >= RUN_DURATION/, 'core must transition to complete once elapsed run time reaches RUN_DURATION');

// Human-found finding: PERFECT was reachable at ~50% apparent visual
// overlap because overlapRatio was a pure time falloff, unrelated to the
// shapes' actual rendered sizes. game-core.js is now the sole geometry
// authority (position AND radii); game.js must read from it, not hardcode
// independent copies that could silently drift from what's judged.
assert.match(core, /var TRACK_TOP = 0\.2;/);
assert.match(core, /var TRACK_BOTTOM = 0\.82;/);
assert.match(core, /var TARGET_RADIUS = 33;/);
assert.match(core, /var NOTE_MIN_SIZE = 15;/);
assert.match(core, /var NOTE_MAX_SIZE = 39;/);
assert.match(core, /function noteCenterYLogical\(t\)/);
assert.match(core, /function targetCenterYLogical\(\)/);
assert.doesNotMatch(game, /var TRACK_TOP =/, 'game.js must not keep its own independent copy of TRACK_TOP');
assert.doesNotMatch(game, /var TRACK_BOTTOM =/, 'game.js must not keep its own independent copy of TRACK_BOTTOM');
assert.match(game, /C\.LOGICAL_HEIGHT \* C\.TRACK_TOP/, 'drawTrack must read the track span from C, in logical units');
assert.match(game, /C\.LOGICAL_HEIGHT \* C\.TRACK_BOTTOM/, 'drawTrack and the unicorn must read the track span from C, in logical units');
assert.match(game, /C\.noteCenterYLogical\(gate\.t\)/, 'drawGate must render position via the same function overlapRatio() uses internally');
assert.match(game, /C\.toScreenY\(C\.LOGICAL_HEIGHT \* C\.TRACK_BOTTOM, transform\) \+ Math\.sin/, 'the unicorn (the player\'s visual target reference) must sit exactly at the judgment center, projected through the shared transform');
assert.doesNotMatch(game, /height \* \.81/, 'the unicorn must no longer sit ~1% above the actual judgment center');

// Codex re-audit HIGH finding: judgment must be viewport-invariant.
// overlapRatio previously divided a height-scaled distance by a FIXED
// pixel radius, so the effective hit window shrank on taller viewports
// (Codex measured the SAME t=0.9 classifying GOOD/GOOD/MISS/NO-OP across
// four sizes). The fix: overlapRatio takes no height parameter at all —
// both the distance and the radii are expressed in LOGICAL-relative units,
// so the real height cancels out of the ratio entirely. This invariant
// must survive the uniform-logical-transform remediation below untouched.
assert.match(core, /var LOGICAL_HEIGHT = 720;/);
assert.match(core, /function overlapRatio\(t, color\)/, 'overlapRatio must take no height/viewport parameter — that IS the invariance fix');
assert.doesNotMatch(core, /function overlapRatio\(t, heightPx\)/, 'must not regress to the height-dependent signature');
assert.match(core, /var distance = LOGICAL_HEIGHT \* \(TRACK_BOTTOM - TRACK_TOP\) \* Math\.abs\(1 - t\);/);

// Codex re-audit (this task) HIGH #2: non-uniform logical space. Target
// radius previously scaled with a height-only factor while lane spacing
// was capped in raw real pixels by width, independent of that factor — on
// a tall/narrow viewport the target circles grew (taller canvas) while
// lane spacing didn't grow with them, so adjacent judgment circles
// overlapped. Fixed by ONE uniform scale (computeTransform), fit to
// whichever of width/height is the tighter constraint against a fixed
// LOGICAL_WIDTH x LOGICAL_HEIGHT box, applied to every piece of gameplay
// geometry alike. scaleFor(heightPx) (a height-only factor) must be gone
// entirely — a second scale model left lying around is exactly how this
// class of bug reappears.
assert.match(core, /var LOGICAL_WIDTH = 480;/);
assert.match(core, /var LANE_GAP = 126;/);
assert.match(core, /function computeTransform\(width, height\)/, 'one authoritative uniform transform must exist');
assert.match(core, /Math\.min\(width \/ LOGICAL_WIDTH, height \/ LOGICAL_HEIGHT\)/, 'the transform scale must be the tighter of the two axis constraints, never independently stretched');
assert.doesNotMatch(core, /function scaleFor\(/, 'the old height-only scale model must be removed, not left alongside the new uniform one');
assert.doesNotMatch(game, /scaleFor/, 'game.js must not reference the removed height-only scale model');
assert.match(core, /function laneCenterX\(lane\)/, 'lane spacing must be a single authoritative logical function');
assert.match(core, /function laneFromLogicalX\(logicalX\)/, 'pointer/touch hit-testing must have a shared authoritative nearest-lane function');
assert.match(game, /C\.laneCenterX\(i\)/, 'drawTrack must consume the shared lane-center geometry');
assert.match(game, /C\.laneCenterX\(gate\.color\)/, 'drawGate must consume the shared lane-center geometry');
assert.match(game, /C\.laneCenterX\(state\.lane\)/, 'drawUnicorn must consume the shared lane-center geometry');
assert.doesNotMatch(game, /width \* \.22/, 'game.js must not keep its own independent, width-only lane-spacing formula');
assert.match(game, /C\.TARGET_RADIUS \* transform\.scale/, 'rendered target radius must scale with the same uniform transform judgment-consistent geometry uses');
assert.match(game, /C\.noteBaseSize\(gate\.t\) \* transform\.scale/, 'rendered note size must scale with the same uniform transform');

// Codex re-audit (this task) HIGH #1: pointer/touch mis-mapping. Pointer
// input previously split the FULL raw canvas width into three equal
// thirds, but the rendered lane group only ever occupies a narrow,
// centered band — at every required viewport all three visible lane
// centers fell inside the single middle third. Fixed: pointer input must
// project through the SAME transform/lane-center geometry rendering uses.
assert.doesNotMatch(game, /Math\.floor\(\(\(e\.clientX - r\.left\) \/ r\.width\) \* 3\)/, 'pointer mapping must not regress to the raw-thirds-of-full-width formula');
assert.match(game, /C\.toLogicalX\(e\.clientX - r\.left, transform\)/, 'pointer mapping must project the tap into logical space via the shared transform');
assert.match(game, /C\.laneFromLogicalX\(logicalX\)/, 'pointer mapping must resolve to the shared nearest-lane-center function, not a duplicated formula');

// Codex re-audit MEDIUM finding: true rendered shape extent. The GOLD note
// is a rotated rounded square, not a circle — its actual vertical extent
// is larger than `size`. Judgment must use noteExtent(t, color), not a
// single shape-agnostic value, and rendering must share the exact same
// DIAMOND_SCALE constant judgment derives it from, with a corner radius
// scaled by the SAME uniform transform as everything else (Codex MEDIUM,
// this task: the corner radius previously stayed a raw, unscaled 5 real
// pixels regardless of viewport, so the rendered diamond only matched its
// judged extent at the one reference height where the old height-only
// scale happened to equal 1).
assert.match(core, /function noteExtent\(t, color\)/, 'judgment must be per-shape aware, not a single shared extent');
assert.match(core, /function diamondHalfExtent\(size\)/);
assert.match(core, /var DIAMOND_SCALE = 0\.8;/);
assert.match(core, /var SHAPE_CORNER_RADIUS = 5;/);
assert.match(game, /var corner = C\.SHAPE_CORNER_RADIUS \* transform\.scale;/, 'the diamond/square corner radius must be scaled by the same uniform transform as the shape size itself');
assert.match(game, /size \* C\.DIAMOND_SCALE, -size \* C\.DIAMOND_SCALE, size \* C\.DIAMOND_SCALE \* 2, size \* C\.DIAMOND_SCALE \* 2, corner/, 'the diamond render call must use the SAME scale constant judgment derives its extent formula from, and the scaled corner radius');
assert.doesNotMatch(game, /-size \* \.8, -size \* \.8, size \* 1\.6, size \* 1\.6, 5/, 'must not regress to independently-hardcoded diamond constants');
assert.doesNotMatch(game, /C\.SHAPE_CORNER_RADIUS\)/, 'the corner radius passed to roundedRect must be transform-scaled, not the raw logical constant');

// Finding #3 (Codex MEDIUM): overlapRatio must not round toward zero.
assert.doesNotMatch(core, /Math\.round\(r \*/, 'overlapRatio must return the raw clamped ratio, not a rounded one');
assert.match(core, /function classify\(ratio\)/, 'classification must be a single exported function, not duplicated inline logic');
assert.match(core, /if \(ratio <= 0\) return 'noop';/);

// Finding #4 (Codex MEDIUM): terminal MISS must not be overwritten by GAME OVER.
assert.match(core, /state\.events\.push/, 'core must queue every fired event, not just remember the latest name');
assert.match(game, /function displayEvent/, 'game.js must display queued events one at a time');
assert.match(game, /function advanceQueue/, 'game.js must advance to the next queued event when the current one\'s display window ends');
assert.doesNotMatch(game, /lastEvent === state\.lastEvent/, 'must not regress to name-based event dedup, which drops consecutive same-type judgments');

assert.match(game, /name === 'complete'/, 'game.js must handle the RUN_COMPLETE event');
assert.match(game, /RUN COMPLETE/, 'RUN_COMPLETE UI text must be present');
assert.match(game, /localStorage/, 'best score must be persisted via the existing lightweight localStorage approach, not a new mechanism');

// Finding #6 (Codex LOW): build must not perform unsafe // comment
// stripping. That logic lived in BUILD/build.mjs, not in the source files
// themselves, so this suite checks build.mjs directly.
const buildScript = fs.readFileSync(path.join(mvpRoot, 'BUILD', 'build.mjs'), 'utf8');
assert.doesNotMatch(buildScript, /indexOf\('\/\/'\)/, 'build must not perform ad-hoc // comment stripping (it can corrupt strings/URLs containing //)');
assert.doesNotMatch(buildScript, /\\s\{2,\}/, 'build must not perform the unsafe global whitespace collapse');

// Terminal copy: STORM GOT YOU -> GAME OVER (headline only; retry
// instruction and terminal logic are unchanged).
assert.match(game, /<b>GAME OVER<\/b><small>' \+ stats\(\) \+ '<br>Press R or tap to ride again<\/small>/, 'terminal headline must read GAME OVER with the retry instruction (now alongside result stats) preserved');
assert.doesNotMatch(game, /STORM GOT YOU/, 'old terminal copy must not remain');

// Cross-browser layout finding (superseded by the uniform-logical-space
// remediation): the lane group's horizontal half-spread used to be an
// independently recomputed raw-pixel formula. It is now the shared
// `transform`, a single value recomputed once in resize() alongside
// width/height, consumed by drawTrack/drawGate/drawUnicorn AND by pointer
// mapping alike — see the laneCenterX/toScreenX/toLogicalX assertions
// above.
assert.equal((game.match(/^\s*transform = C\.computeTransform\(width, height\);/m) || []).length, 1, 'transform must be assigned exactly once, in resize()');
assert.equal((game.match(/C\.toScreenX\(C\.laneCenterX\(/g) || []).length, 3, 'drawTrack/drawGate/drawUnicorn must all project lane position through the shared transform, not their own copies');

if (fs.existsSync(path.join(mvpRoot, 'BUILD', 'dist', 'index.html'))) {
  const dist = fs.readFileSync(path.join(mvpRoot, 'BUILD', 'dist', 'index.html'), 'utf8');
  assert.doesNotMatch(dist, /src="src\//, 'dist should be self-contained');
  assert.match(dist, /RainbowRefrainCore/);
  assert.match(dist, /RainbowRefrainWavedash/);
  assert.match(dist, /Wavedash/);
}

// Phase 1 title screen: scope guard. Gameplay/geometry constants in
// game-core.js must be byte-for-byte the ones from the prior remediation
// (this phase touches ONLY game.js), and no music/difficulty/hold-note
// system may have been introduced alongside it.
assert.match(game, /var started = false;/, 'a title-screen gate must exist');
assert.match(game, /function start\(\)/, 'a single authoritative start() must exist');
assert.match(core, /var LOGICAL_WIDTH = 480;/, 'geometry constants from the prior phase must be untouched');
assert.match(core, /var LOGICAL_HEIGHT = 720;/, 'geometry constants from the prior phase must be untouched');
assert.doesNotMatch(core, /difficulty/i, 'no difficulty system may be introduced in the title-screen phase');
assert.doesNotMatch(game, /difficulty/i, 'no difficulty system may be introduced in the title-screen phase');
assert.doesNotMatch(game + core, /\bhold\b/i, 'no hold-note mechanic may be introduced in the title-screen phase');
// Phase 1.1's guard was "no new audio subsystem at all"; Phase 2 (below)
// explicitly adds procedural music, so the guard now confirms it reuses
// the SAME AudioContext rather than creating a second one.
assert.equal((game.match(/new AC\(\)/g) || []).length, 1, 'music must reuse the single existing AudioContext, not construct a second one');

// Phase 1.1 start UX refinement: scope guard. One shared title renderer
// and one shared touch-capability flag, no user-agent parsing, and the
// per-mode start-input rules the spec requires.
assert.match(game, /var touch = 'ontouchstart' in globalThis;/, 'touch capability must use a tiny feature test, not UA parsing');
assert.doesNotMatch(game, /navigator\.userAgent/, 'must not parse the user agent to detect touch capability');
assert.equal((game.match(/function drawTitle\(\)/g) || []).length, 1, 'there must be exactly one shared title renderer, not separate desktop/touch systems');
assert.match(game, /touch \? 'TAP TO PLAY' : 'PRESS SPACE TO PLAY'/, 'the title must vary only the displayed instruction text by mode, from the one drawTitle()');
assert.match(game, /touch \? 'TAP LANES' : 'A S D = LANES'/, 'the title must vary only the displayed control hint by mode, from the one drawTitle()');
assert.match(game, /if \(!touch && e\.key === ' '\) \{ e\.preventDefault\(\); start\(\); \}/, 'desktop/non-touch mode must start on Space only');
assert.doesNotMatch(game, /e\.key === 'Enter'\) \{ e\.preventDefault\(\); start\(\)/, 'Enter must no longer start the game from the title screen');
assert.match(game, /if \(!started\) \{ if \(touch\) start\(\); return; \}/, 'a pre-start pointerdown must only start the game in touch-capable mode');

// Phase 2 procedural music: scope guard + structural checks.
assert.doesNotMatch(index + core + adapter + game, /\.(mp3|wav|ogg)\b/i, 'no audio file extensions may appear anywhere in the source');
assert.match(game, /var BPM = 132, BEAT = 60 \/ BPM, STEP = BEAT \/ 2;/, 'BPM/BEAT/SUBDIVISION must be explicit, derivable constants (a real beat grid), not implicit magic numbers');
assert.ok(132 >= 120 && 132 <= 150, 'chosen BPM must fall inside the preferred 120-150 rhythm-game range');
assert.match(game, /function mLoop\(\)/, 'music must be its own compact scheduler, not folded into tone()');
assert.doesNotMatch(game, /new (AudioContext|webkitAudioContext)\(\)/, 'music must reuse ensureAudio()/the existing `audio` var, not construct its own context directly');
// Phase 2.1 scheduler remediation (Codex MEDIUM-1/MEDIUM-2 fixes).
// MEDIUM-2 (cumulative drift): every step's time must derive from ONE
// fixed run origin plus a step index, never from callback-time
// currentTime + a local offset — that was the drift bug.
assert.match(game, /var mT, mI, mO, mA = \[\];/, 'music needs a fixed-origin (mO) and a persistent global step index (mI), not per-batch local ones');
assert.match(game, /t0 = mO \+ mI \* STEP/, 'every scheduled step time must derive from the fixed origin, not audio.currentTime read inside the scheduler');
assert.doesNotMatch(game, /var t = audio\.currentTime;/, 'mLoop must not regress to re-deriving its own time base from callback-time currentTime');
assert.match(game, /mO = audio\.currentTime \+ \.05; mI = 0; mLoop\(\);/, 'starting/restarting music must (re)anchor a fresh origin (with the scheduling lookahead) at step 0');
// MEDIUM-1 (retry/terminal overlap): stopping must cancel already-.start()ed
// sources too (a cleared timer alone leaves already-scheduled oscillators
// audible for up to a full batch), and must happen at the EARLIEST point
// core state goes terminal — not only when the delayed displayEvent()
// eventually renders GAME OVER/RUN COMPLETE, which could be up to a
// queued judgment's 550ms later.
assert.match(game, /mA\.push\(o\);/, 'every scheduled oscillator must be tracked so it can be cancelled early');
assert.match(game, /function mStop\(\) \{[\s\S]*?mA\.forEach\(o => \{ try \{ o\.stop\(\) \} catch \(e\) \{\} \}\);[\s\S]*?mA = \[\];[\s\S]*?\}/, 'mStop must stop every tracked source (ignoring an already-ended one) and clear tracking, not just clear the timer');
assert.match(game, /function mChk\(\) \{ if \(state\.phase !== 'run'\) mStop\(\); \}/, 'a single shared terminal check must exist');
assert.doesNotMatch(game, /gameover'\) \{[\s\S]{0,40}mStop\(\)/, 'GAME OVER must no longer rely on the delayed displayEvent to stop music — it must already be stopped by mChk() well before this renders');
assert.doesNotMatch(game, /complete'\) \{[\s\S]{0,40}mStop\(\)/, 'RUN COMPLETE must no longer rely on the delayed displayEvent to stop music — it must already be stopped by mChk() well before this renders');
// mChk() must run immediately after EVERY place state can go terminal:
// C.tick() in frame() (pass-by MISS, RUN COMPLETE) and C.press() in both
// act() (pointer/touch) and the keydown handler (A/S/D) — 3 call sites.
assert.equal((game.match(/mChk\(\);/g) || []).length, 3, 'mChk() must run right after every state-mutating entry point that can reach a terminal phase');
assert.match(game, /C\.tick\(state, \{\}, dt\);\s*mChk\(\);/, 'frame() must check for terminal state immediately after tick()');
// Volume balance: music note gains (.05/.03) must stay below every
// judgment-hit SFX gain in tone() (.06 GOOD / .09 PERFECT).
assert.match(game, /mn\(110, t0, STEP \* \.9, 'triangle', \.05\);/);
assert.match(game, /mn\(220 \* Math\.pow\(2, SCALE\[PATTERN\[s\]\] \/ 12\), t0, STEP \* \.7, 'square', \.03\);/);

// Phase 2.2: absolute wake-up + late-step skip (the one remaining Codex
// Medium). The scheduler callback itself was still a fixed relative delay
// (setTimeout(mLoop, 4*STEP)), so callback lateness accumulated across
// batch boundaries even though each NOTE's timestamp was already
// grid-correct. The fix: derive the NEXT wake-up from the absolute grid
// and current audio time, not a fixed recurring interval.
assert.doesNotMatch(game, /setTimeout\(mLoop, STEP \* 4000\)/, 'the scheduler wake-up must no longer be a fixed relative recurring delay');
assert.match(game, /mT = setTimeout\(mLoop, \(mO \+ mI \* STEP - audio\.currentTime - \.05\) \* 1000\);/, 'the next wake-up must be computed from the absolute grid and current audio time (a small constant lookahead), not from a fixed interval');
// Negative delays are intentionally left unclamped in source: the HTML
// timers spec already treats a negative setTimeout delay as 0 (fire ASAP),
// so an explicit Math.max(0, ...) would only cost bytes for no behavior
// change.
assert.doesNotMatch(game, /Math\.max\(0,/, 'no explicit negative-delay clamp is needed — setTimeout already clamps a negative delay to 0 per spec');
// Late-callback policy: skip past-due steps (advance the step index) —
// never bunch/replay them, never shift mO, never touch BPM/STEP.
assert.match(game, /while \(mO \+ mI \* STEP < audio\.currentTime\) mI\+\+;/, 'a late callback must skip every step whose ideal time has already passed, continuing the SAME grid phase — not replay or bunch them');

// Phase 3A: EASY chart integration. Procedural note generation must be
// fully removed (not merely bypassed), and the chart data must be baked
// in as compact source — no loose CSV/WAV asset in the runtime ZIP.
assert.match(core, /var CHART = /, 'a compiled chart constant must exist');
assert.doesNotMatch(core, /function spawn\(state\)/, 'PROCEDURAL_NOTE_GENERATION_DISABLED: the old PRNG spawn() function must be removed, not just unused');
assert.doesNotMatch(core, /var SPAWN = /, 'the old procedural spawn-interval constant must be removed');
assert.doesNotMatch(core, /function rng\(/, 'the PRNG helper must be removed — nothing needs randomness anymore');
assert.doesNotMatch(core, /state\.random/, 'no code may reference a PRNG state field');
assert.doesNotMatch(core, /nextGate/, 'the old procedural spawn-timer field must be gone everywhere');
assert.doesNotMatch(core, /gateId/, 'the old per-gate id counter must be gone (gates are no longer procedurally numbered)');
assert.match(core, /CHART\[state\.chartIdx\]\.t - TRAVEL <= state\.time/, 'chart notes must spawn TRAVEL seconds before their intended hit time, not at hit time');
assert.doesNotMatch(index + core + adapter + game, /rainbow_refrain_easy_chart|beat_index|hold_sec|salience/i, 'the source CSV must not be embedded as a loose/verbose runtime asset — only the compiled compact chart may exist');
assert.doesNotMatch(index + core + adapter + game, /\.wav\b/i, 'REFERENCE_WAV_RUNTIME_INCLUDED must be NO — no .wav reference of any kind belongs in the runtime source');
assert.doesNotMatch(index + core + adapter + game, /RIFF|WAVEfmt/, 'no raw/embedded WAV audio data may appear in the runtime source');

if (fs.existsSync(path.join(mvpRoot, 'BUILD', 'dist', 'index.html'))) {
  const dist = fs.readFileSync(path.join(mvpRoot, 'BUILD', 'dist', 'index.html'), 'utf8');
  assert.doesNotMatch(dist, /rainbow_refrain_easy_chart|beat_index|hold_sec|salience/i, 'AFTER_ZIP: the built artifact must not embed the loose/verbose CSV');
  assert.doesNotMatch(dist, /\.wav\b|RIFF|WAVEfmt/i, 'AFTER_ZIP: the built artifact must not embed or reference the reference WAV');
  assert.match(dist, /var CHART = /, 'AFTER_ZIP: the compiled chart must be present in the built artifact');
}

console.log('static tests: PASS');
