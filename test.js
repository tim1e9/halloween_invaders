/* ============================================================
 * Halloween Invaders — minimal logic tests (run: node test.js)
 * No framework, no dependencies. Pure Rules only.
 * ============================================================ */
'use strict';

const { Rules, GRID_MARGIN } = require('./game.js');
const CANVAS_W = 900;
const GRID_W = 11 * 56; // 11 cols × 56px (mirrors game.js layout for readability)

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(` FAIL ${name}`);
    console.error(`      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* -----------------------------------------------------------
 * Rules.aabbOverlaps
 * ----------------------------------------------------------- */
test('aabb: overlapping boxes collide', () => {
  assert(Rules.aabbOverlaps(0, 0, 10, 10, 5, 5, 10, 10) === true);
});

test('aabb: boxes touching only at an edge do NOT collide', () => {
  assert(Rules.aabbOverlaps(0, 0, 10, 10, 10, 0, 10, 10) === false);
  assert(Rules.aabbOverlaps(0, 0, 10, 10, 0, 10, 10, 10) === false);
});

test('aabb: disjoint boxes do not collide', () => {
  assert(Rules.aabbOverlaps(0, 0, 10, 10, 100, 100, 10, 10) === false);
});

test('aabb: point containment in either box collides', () => {
  assert(Rules.aabbOverlaps(0, 0, 100, 100, 50, 50, 2, 2) === true);
  assert(Rules.aabbOverlaps(50, 50, 2, 2, 0, 0, 100, 100) === true);
});

/* -----------------------------------------------------------
 * Rules.canShoot (1-bullet rule + cooldown)
 * ----------------------------------------------------------- */
test('canShoot: allowed when no bullets and no cooldown', () => {
  assert(Rules.canShoot([], 0) === true);
});

test('canShoot: blocked by a live bullet on screen', () => {
  assert(Rules.canShoot([{ y: 400 }], 0) === false);
});

test('canShoot: blocked while cooldown remains', () => {
  assert(Rules.canShoot([], 0.1) === false);
});

/* -----------------------------------------------------------
 * Rules.bulletOffScreen
 * ----------------------------------------------------------- */
test('bulletOffScreen: false while on screen', () => {
  assert(Rules.bulletOffScreen({ y: 0, height: 14 }) === false);
  assert(Rules.bulletOffScreen({ y: 400, height: 14 }) === false);
});

test('bulletOffScreen: true only once fully past the top edge', () => {
  assert(Rules.bulletOffScreen({ y: -13, height: 14 }) === false); // tip above, tail visible
  assert(Rules.bulletOffScreen({ y: -14, height: 14 }) === true);  // fully above
});

test('bulletOffScreen (invader/down): off only once past the bottom edge', () => {
  assert(Rules.bulletOffScreen({ y: 799, height: 12, direction: 1 }, 800) === false);
  assert(Rules.bulletOffScreen({ y: 800, height: 12, direction: 1 }, 800) === true);
});

/* -----------------------------------------------------------
 * Rules.pointsForRow / typeForRow (Q17 mapping)
 * ----------------------------------------------------------- */
test('pointsForRow: 30 / 20,20 / 10,10 banding', () => {
  const pts = [0, 1, 2, 3, 4].map((r) => Rules.pointsForRow(r));
  assert(JSON.stringify(pts) === JSON.stringify([30, 20, 20, 10, 10]), `got ${pts}`);
});

test('typeForRow: Dracula top, Ghost middle, Witch bottom', () => {
  const types = [0, 1, 2, 3, 4].map((r) => Rules.typeForRow(r));
  assert(JSON.stringify(types) === JSON.stringify([0, 1, 1, 2, 2]), `got ${types}`);
});

test('points values only decrease toward the bottom rows', () => {
  for (let r = 1; r < 5; r++) {
    assert(Rules.pointsForRow(r) <= Rules.pointsForRow(r - 1), `row ${r}`);
  }
});

/* -----------------------------------------------------------
 * Rules.waveSpeed (Q15: faster each wave, capped)
 * ----------------------------------------------------------- */
test('waveSpeed: positive and non-decreasing across waves', () => {
  let prev = 0;
  for (let wave = 1; wave <= 20; wave++) {
    const s = Rules.waveSpeed(wave);
    assert(Number.isFinite(s) && s > 0, `wave ${wave} → ${s}`);
    assert(s >= prev, `wave ${wave} (${s}) < previous (${prev})`);
    prev = s;
  }
});

test('waveSpeed: eventually caps, never explodes', () => {
  assert(Rules.waveSpeed(100) < 1000, `got ${Rules.waveSpeed(100)}`);
});

/* -----------------------------------------------------------
 * Rules.speedFactor (Q21: fewer survivors = faster, bounded)
 * ----------------------------------------------------------- */
test('speedFactor: is 1.0 on a full grid and grows as survivors drop', () => {
  const total = 55;
  assert(Rules.speedFactor(total, total) === 1, 'full grid = 1.0');
  const half = Rules.speedFactor(Math.floor(total / 2), total);
  const one = Rules.speedFactor(1, total);
  assert(half > 1, `half (${half}) should exceed 1`);
  assert(one > half, `last man (${one}) should exceed half (${half})`);
});

test('speedFactor: monotonic as survivors decrease', () => {
  const total = 55;
  let prev = 1;
  for (let alive = total; alive >= 1; alive--) {
    const s = Rules.speedFactor(alive, total);
    assert(s >= prev - 1e-9, `alive ${alive}: ${s} < ${prev}`);
    prev = s;
  }
});

test('speedFactor: bounded (approaches but never exceeds ~3)', () => {
  const total = 55;
  // As survivors → 0 the multiplier approaches its cap of 3 (never used in play,
  // since a cleared wave is a win). Bounded for any survivor count.
  assert(Rules.speedFactor(0, total) <= 3 + 1e-9, `empty factor ${Rules.speedFactor(0, total)}`);
  assert(Rules.speedFactor(1, total) < 3, `last-man factor ${Rules.speedFactor(1, total)}`);
  assert(Rules.speedFactor(100, 10) === 1, 'clamped when alive > total');
});

/* -----------------------------------------------------------
 * Rules.gridSpeed (wave base × alive-count factor)
 * ----------------------------------------------------------- */
test('gridSpeed: full grid equals the wave base; late game is faster', () => {
  assert(Rules.gridSpeed(3, 55, 55) === Rules.waveSpeed(3), 'full grid');
  assert(Rules.gridSpeed(3, 5, 55) > Rules.gridSpeed(3, 55, 55), 'fewer = faster');
});

test('gridSpeed: higher wave is faster at the same survivor count', () => {
  assert(Rules.gridSpeed(4, 20, 55) > Rules.gridSpeed(3, 20, 55));
});

/* -----------------------------------------------------------
 * Rules: Task 8 — invader fire
 * ----------------------------------------------------------- */
test('bottommostPerColumn: returns the lone survivor per occupied column', () => {
  const grid = [
    { row: 0, col: 0, alive: true },
    { row: 1, col: 0, alive: true },   // bottommost of col 0
    { row: 2, col: 0, alive: false },  // dead — ignored even though lower
    { row: 0, col: 1, alive: true },   // col 1's only survivor
    { row: 2, col: 1, alive: false },
    { row: 3, col: 2, alive: true },   // col 2's only survivor
    { row: 0, col: 3, alive: false },  // empty column → excluded
  ];
  const c = Rules.bottommostPerColumn(grid);
  assert(c.length === 3, `expected 3 candidates, got ${c.length}`);
  const byCol = {};
  for (const inv of c) byCol[inv.col] = inv.row;
  assert(byCol[0] === 1, 'col 0 → bottommost alive row 1');
  assert(byCol[1] === 0, 'col 1 → row 0');
  assert(byCol[2] === 3, 'col 2 → row 3');
  assert(byCol[3] === undefined, 'dead column 3 excluded');
});

test('bottommostPerColumn: empty grid → no candidates', () => {
  assert(Rules.bottommostPerColumn([]).length === 0);
  assert(Rules.bottommostPerColumn([{ row: 0, col: 0, alive: false }]).length === 0);
});

test('invaderFireInterval: shorter as survivors drop, positive, bounded', () => {
  const full = Rules.invaderFireInterval(1, 55, 55);
  const low = Rules.invaderFireInterval(1, 2, 55);
  assert(low < full, `few survivors ${low}s should fire faster than full ${full}s`);
  assert(low > 0, 'interval positive');
  assert(low >= 0.29, `interval ${low}s should respect the ~0.3s floor`);
});

test('invaderFireInterval: higher wave fires faster at the same survivor count', () => {
  const w1 = Rules.invaderFireInterval(1, 10, 55);
  const w3 = Rules.invaderFireInterval(3, 10, 55);
  assert(w3 < w1, `wave 3 (${w3}s) should outpace wave 1 (${w1}s)`);
});

test('maxInvaderBullets: ramps 1,2,3 across waves and caps at 3', () => {
  assert(Rules.maxInvaderBullets(1) === 1);
  assert(Rules.maxInvaderBullets(2) === 2);
  assert(Rules.maxInvaderBullets(3) === 3);
  assert(Rules.maxInvaderBullets(99) === 3, 'capped at 3');
});

/* -----------------------------------------------------------
 * Rules.gridEdgeReached
 * ----------------------------------------------------------- */
test('gridEdge: not reached in the middle of the field', () => {
  const mid = Math.floor((CANVAS_W - GRID_MARGIN - GRID_W) / 2);
  assert(Rules.gridEdgeReached(mid, GRID_W, CANVAS_W) === false);
});

test('gridEdge: reached at left and right margins (inclusive)', () => {
  assert(Rules.gridEdgeReached(GRID_MARGIN, GRID_W, CANVAS_W) === true);
  assert(Rules.gridEdgeReached(CANVAS_W - GRID_MARGIN - GRID_W, GRID_W, CANVAS_W) === true);
});

test('gridEdge: just inside the margins does NOT trigger', () => {
  assert(Rules.gridEdgeReached(GRID_MARGIN + 1, GRID_W, CANVAS_W) === false);
  assert(Rules.gridEdgeReached(CANVAS_W - GRID_MARGIN - GRID_W - 1, GRID_W, CANVAS_W) === false);
});

/* -----------------------------------------------------------
 * Rules: Task 9 — shields
 * ----------------------------------------------------------- */
const { Shield } = require('./game.js');

test('shieldInitialMask: correct dimensions and dome shape', () => {
  const m = Rules.shieldInitialMask(11, 7);
  assert(m.length === 7, '7 rows');
  assert(m.every(row => row.length === 11), '11 cols each');
  // Centered 3-wide top notch (cols 4,5,6) over 2 deep rows
  assert(m[0][4] === false && m[0][5] === false && m[0][6] === false, 'top-center notch row0');
  assert(m[1][4] === false && m[1][5] === false && m[1][6] === false, 'top-center notch row1');
  // Shaved top corners
  assert(m[0][0] === false && m[0][10] === false, 'top corners shaved');
  // Solid base row
  assert(m[6].every(v => v === true), 'bottom row fully solid');
});

test('shieldErosion: melts the hit cell, a 2-wide scrape, and a directional channel', () => {
  // Downward bullet (dir +1) hitting row 2, col 5
  const cells = Rules.shieldErosion(7, 11, 2, 5, 1);
  const has = (r, c) => cells.some(([rr, cc]) => rr === r && cc === c);
  assert(has(2, 5), 'hit cell removed');
  assert(has(2, 4) && has(2, 6), '2-wide scrape removed');
  assert(has(3, 5) && has(4, 5), 'downward channel removed');
  assert(has(1, 5), 'approach cell (above) removed');
  // All coordinates stay in bounds
  for (const [r, c] of cells) assert(r >= 0 && r < 7 && c >= 0 && c < 11, 'in bounds');
});

test('shieldErosion: channel extends in the direction of travel, not against it', () => {
  const down = new Set(Rules.shieldErosion(7, 11, 3, 5, 1).map(([r, c]) => r + ',' + c));
  const up = new Set(Rules.shieldErosion(7, 11, 3, 5, -1).map(([r, c]) => r + ',' + c));
  // Downward bullet (dir +1) at row 3 carves 2 ahead: rows 4 and 5 — never 2 back (row 1)
  assert(down.has('4,5') && down.has('5,5'), 'downward hole runs ahead (rows 4,5)');
  assert(!down.has('1,5'), 'downward hole does not reach back to row 1');
  // Upward bullet (dir -1) is the mirror image
  assert(up.has('2,5') && up.has('1,5'), 'upward hole runs ahead (rows 2,1)');
  assert(!up.has('5,5'), 'upward hole does not reach back to row 5');
});

test('Shield.hitByBullet: solid hit erodes + returns true; a gap clip passes + returns false', () => {
  const s = new Shield(0, 0);
  // Bullet aimed straight into the top-center notch (cols 4-6, rows 0-1 are gaps)
  const gapBullet = { x: 40, y: 2, width: 4, height: 12, direction: 1 };
  assert(s.hitByBullet(gapBullet) === false, 'bullet through the notch should pass');

  // Bullet into solid armor (col 8 area) should be absorbed and erode cells
  const solidBefore = s.mask.flat().filter(Boolean).length;
  const solidBullet = { x: 68, y: 2, width: 4, height: 12, direction: 1 };
  assert(s.hitByBullet(solidBullet) === true, 'solid hit should register');
  const solidAfter = s.mask.flat().filter(Boolean).length;
  assert(solidAfter < solidBefore, 'solid cells were eroded');
});

test('Shield: crushByRect over the whole bunker → isDestroyed; holes stop blocking', () => {
  const s = new Shield(0, 0);
  s.crushByRect(-10, -10, 200, 200); // grid sweeping over the entire bunker
  assert(s.isDestroyed() === true, 'fully crushed bunker is destroyed');
  assert(s.hitByBullet({ x: 40, y: 5, width: 6, height: 10, direction: 1 }) === false,
    'a destroyed bunker absorbs nothing');
});

/* ----------------------------------------------------------- */
/* -----------------------------------------------------------
 * Task 10 — the mystery ship (UFO)
 * ----------------------------------------------------------- */
test('Ufo: spawns fully off-screen and moves across in its chosen direction', () => {
  const { Ufo, UFO_SPEED } = require('./game.js');
  for (let i = 0; i < 20; i++) {
    const u = new Ufo();
    assert(Rules.ufoOffScreen(u.x, u.w, 900) === true, 'starts off-screen');
    assert(u.bonus >= 50 && u.bonus <= 300, 'carries a pool bonus');
    const x0 = u.x;
    u.update(1); // one second of travel
    const dx = u.x - x0;
    assert(Math.sign(dx) === u.dir, 'moves in its direction');
    assert(Math.abs(Math.abs(dx) - UFO_SPEED) < 2, 'at the expected speed');
  }
});

test('pickUfoBonus: only returns a value from the classic pool', () => {
  const allowed = new Set([50, 100, 150, 300]);
  for (let i = 0; i < 1000; i++) assert(allowed.has(Rules.pickUfoBonus()));
});

test('pickUfoBonus: 300 is the rare one, common tiers dominate', () => {
  const N = 2000;
  const counts = { 50: 0, 100: 0, 150: 0, 300: 0 };
  for (let i = 0; i < N; i++) counts[Rules.pickUfoBonus()]++;
  // 30/30/30/10 weighting: 300 must be clearly rarer than any common tier
  assert(counts[300] < counts[50] && counts[300] < counts[150], '300 is scarcer than the common values');
  assert(counts[300] > 0, '300 does show up');
});

test('nextUfoDelay: returns a finite value within [min, max]', () => {
  for (let i = 0; i < 100; i++) {
    const d = Rules.nextUfoDelay(14, 28);
    assert(d >= 14 && d <= 28, 'in range');
  }
});

test('ufoOffScreen: false while visible, true once fully past either edge', () => {
  const W = 900, w = 64;
  assert(Rules.ufoOffScreen(450, w, W) === false, 'center is on-screen');
  assert(Rules.ufoOffScreen(-w / 2, w, W) === true, 'fully off the left');
  assert(Rules.ufoOffScreen(W + w / 2, w, W) === true, 'fully off the right');
  assert(Rules.ufoOffScreen(2, w, W) === false, 'still peeking in from the left');
  assert(Rules.ufoOffScreen(W - 2, w, W) === false, 'still peeking in from the right');
});

/* -----------------------------------------------------------
 * Rules.explosionSpec — Task 11 (death-burst scaling)
 * ----------------------------------------------------------- */
test('explosionSpec: sane, finite params for any point value', () => {
  for (const pts of [1, 10, 20, 30, 100, 300]) {
    const s = Rules.explosionSpec(pts);
    assert(Number.isFinite(s.count) && s.count > 0, `count ${s.count} for ${pts}pt`);
    assert(s.speedMin > 0 && s.speedMax > s.speedMin, 'speeds ordered and positive');
    assert(s.life > 0 && Number.isFinite(s.life), 'life positive and finite');
  }
});

test('explosionSpec: high-value kills earn a bigger, longer, wider burst', () => {
  const small = Rules.explosionSpec(10);
  const big = Rules.explosionSpec(30);
  const jackpot = Rules.explosionSpec(300); // UFO kills ride the 30pt tier
  assert(big.count > small.count, `30pt burst (${big.count}) should outdo 10pt (${small.count})`);
  assert(big.speedMax > small.speedMax, '30pt spreads wider');
  assert(big.life > small.life, '30pt lives longer');
  assert(jackpot.count === big.count && jackpot.speedMax === big.speedMax, 'UFO jackpot tier = 30pt tier');
});

/* -----------------------------------------------------------
 * Task 12 — Halloween roster assets wired up (files exist, 3 types)
 * ----------------------------------------------------------- */
const fs = require('fs');
const { BOO_TYPES } = require('./game.js');

test('roster: exactly 3 invader types, each a distinct assets/*.png', () => {
  assert(BOO_TYPES.length === 3, `expected 3 types, got ${BOO_TYPES.length}`);
  const files = BOO_TYPES.map((t) => t.file);
  assert(new Set(files).size === 3, 'type files must be distinct');
  files.forEach((f) => assert(/^assets\/\S+\.png$/.test(f), `bad file path: ${f}`));
});

test('roster: all three Halloween PNGs exist on disk (dracula/ghost/witch)', () => {
  BOO_TYPES.forEach((t) => {
    assert(fs.existsSync(t.file), `missing image: ${t.file}`);
  });
  const names = BOO_TYPES.map((t) => t.name);
  assert(JSON.stringify(names) === JSON.stringify(['Dracula', 'Ghost', 'Witch']), `got ${names}`);
});

/* -----------------------------------------------------------
 * Task 12 fix (Q24) — thready gaps: sprites never exceed hitbox
 * ----------------------------------------------------------- */
test('fitSize: wide image clamps to box width, aspect preserved', () => {
  const s = Rules.fitSize(144, 108, 40, 46); // ghost-like aspect
  assert(s.w <= 40 + 1e-9 && s.h <= 46 + 1e-9, `oversize: ${JSON.stringify(s)}`);
  assert(Math.abs(s.w / s.h - 144 / 108) < 1e-9, 'aspect lost');
  assert(Math.abs(s.w - 40) < 1e-9, 'width should be the limiting dimension');
});

test('fitSize: tall image clamps to box height, aspect preserved', () => {
  const s = Rules.fitSize(60, 200, 40, 46);
  assert(s.w <= 40 + 1e-9 && s.h <= 46 + 1e-9, `oversize: ${JSON.stringify(s)}`);
  assert(Math.abs(s.h - 46) < 1e-9, 'height should be the limiting dimension');
});

test('fitSize: degenerate inputs yield zero size without throwing', () => {
  assert(Rules.fitSize(0, 0, 40, 46).w === 0);
  assert(Rules.fitSize(-5, 10, 40, 46).h === 0);
});

const { CELL_W, INVADER_W } = require('./game.js');

test('thready gap: adjacent invader hitboxes leave ≥ 12px (3× the 4px player bullet)', () => {
  const gap = CELL_W - INVADER_W;
  assert(gap >= 12, `gap of ${gap}px is too tight to reliably thread a 4px bullet`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
