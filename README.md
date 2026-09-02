# Rainbow Refrain

A js13kGames 2026 entry: a browser-based rhythm game where colored, symbol-matched
gates ("gates") fall down three lanes and must be tapped/held in time with an
EDM track. Built as vanilla JS/HTML5 Canvas with no external runtime dependencies.

## Status

This repository holds the current local development state: the size-constrained
`SOURCE/` build (the actual js13kGames submission candidate), a non-size-constrained
local playtest build with three difficulties (EASY/NORMAL/HARD) and full Hold-note
mechanics, the reference chart/audio data, and the test suites that validate both.

No js13kGames submission, Wavedash publish, or public release has been performed.
This repo is private and is not connected to any competition or publishing workflow.

## Main files

- `SOURCE/` — the size-constrained submission source (`src/game-core.js`,
  `src/game.js`, `src/wavedash-adapter.js`, `index.html`). This is what
  `BUILD/build.mjs` packages into the final js13k-size-limited ZIP.
- `BUILD/build.mjs` — deterministic build script that inlines/minifies `SOURCE/`
  into a single self-contained `dist/index.html` and a ZIP artifact.
- `DIST/index.html` — a validated, self-contained single-HTML build output.
- `GAME_BUILD/rainbow-refrain-easy-chart-local-playtest-phase3a1/` — the local
  playtest build (not size-constrained): EASY/NORMAL/HARD difficulty selection,
  Hold notes, and real WAV playback via Web Audio, served over local HTTP.
- `GAME_BUILD/rainbow-refrain-mvp-easy-chart-phase3a.zip` — the approved,
  byte-verified Phase 3A submission-candidate artifact (tracked by SHA256 in
  `HASHES_SHA256.txt`; must not be modified).
- `REFERENCES/` — the reference EDM track (WAV) and the EASY/NORMAL/HARD chart
  CSVs the runtime charts are compiled from.
- `TESTS/` — Node-based test suites (`core.test.js`, `static.test.js`,
  `runtime.test.js` for `SOURCE/`; `playtest_phase3a1.test.js` for the local
  playtest build).
- `REPORTS/` — historical validation logs/reports from earlier development phases.

## Running locally

### Playtest build (EASY / NORMAL / HARD, with audio)

The playtest build fetches its WAV over `fetch()`, which most browsers block on
`file://`, so serve it over local HTTP:

```
cd GAME_BUILD/rainbow-refrain-easy-chart-local-playtest-phase3a1
npx serve .
```

(or `python -m http.server 8080`), then open the printed `http://localhost:...`
address. See that folder's `HOW_TO_RUN.txt` for controls and details.

### Submission-candidate build

```
cd BUILD
node build.mjs
```

This regenerates `dist/index.html` and the size-constrained ZIP from `SOURCE/`.
Open the resulting `dist/index.html` directly in a browser (no server needed —
this build uses no external fetches).

## Tests

Requires only Node.js (no external packages):

```
node TESTS/core.test.js
node TESTS/static.test.js
node TESTS/runtime.test.js
node TESTS/playtest_phase3a1.test.js
```
