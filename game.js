/* ============================================================
 * Halloween Invaders — main game script
 * ============================================================ */
'use strict';

/* -----------------------------------------------------------
 * Constants
 * ----------------------------------------------------------- */
const CANVAS_W = 900;
const CANVAS_H = 800;

const STATE = {
  START: 'start',
  PLAYING: 'playing',
  GAME_OVER: 'game_over',
  VICTORY: 'victory', // all invaders of the wave cleared → next wave
};

const COLORS = {
  bg: '#000000',
  text: '#e8e8e8',
  accent: '#3cff9e',
  player: '#7df9ff',
  bullet: '#ffffff',
  shield: '#3ad07f',
  placeholder: '#444a5e',
};

/* Task 11 — explosion burst palettes (light, no assets) */
const BURST_COLORS_INVADER = ['#3cff9e', '#ffffff', '#9fffd0'];
const BURST_COLORS_UFO = ['#ff5fd0', '#ffd7f4', '#ffffff'];

const PLAYER_SPEED = 380; // px per second
const BULLET_SPEED = 720; // px per second (player, upward)
const INVADER_BULLET_SPEED = 420; // px per second (invader, downward — slower than the player's)
const BULLET_COOLDOWN = 0.25; // seconds (extra gate on top of the 1-bullet rule)

const STARTING_LIVES = 3;

/* Invader grid layout */
const GRID_COLS = 11;
const GRID_ROWS = 5;
const CELL_W = 56;
const CELL_H = 50;
const INVADER_W = 40; // hitbox narrower than the 56px cell → visible 16px thread for the 4px bullet (Q24)
const INVADER_H = 46;
const GRID_MARGIN = 12; // min distance of grid sides from canvas edges
const GRID_DROP_STEP = 30; // pixels the grid falls on each edge bounce

/* Destructible shield (bunker) layout */
const SHIELD_COUNT = 4;
const SHIELD_CELL = 8;               // px per shield cell
const SHIELD_COLS = 11;
const SHIELD_ROWS = 7;
const SHIELD_W = SHIELD_COLS * SHIELD_CELL; // 88
const SHIELD_H = SHIELD_ROWS * SHIELD_CELL; // 56
const SHIELD_Y = CANVAS_H - 170;         // top edge of the bunker row

/* UFO (mystery bonus ship) */
const UFO_Y = 86;                        // flies just above the grid's start altitude
const UFO_W = 64;
const UFO_H = 28;
const UFO_SPEED = 170;                   // px/s across the top of the field
const UFO_MIN_DELAY = 14;                // seconds between potential appearances…
const UFO_MAX_DELAY = 28;                // …timed, never spammed

/* Invader types (Halloween roster) — order matters: index maps to assets + row band */
const BOO_TYPES = [
  { file: 'assets/dracula.png', name: 'Dracula' },
  { file: 'assets/ghost.png',  name: 'Ghost' },
  { file: 'assets/witch.png',  name: 'Witch' },
];

/* -----------------------------------------------------------
 * Rules — pure, DOM-free logic (shared by game + tests)
 * ----------------------------------------------------------- */
const Rules = {
  /** Axis-aligned bbox overlap. Touching edges does NOT count. */
  aabbOverlaps(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  },

  /**
   * Contain-fit an image into a box, aspect preserved (Q24).
   * The drawn sprite can NEVER exceed the hitbox, so the visible pixels are a
   * subset of the shootable pixels — gaps between invaders stay visible and
   * aimable. (The old cover-fit let wide 8-bit sprites bleed ~10px past their
   * cell and paint over the only thread between neighbors.)
   * @returns {{w:number,h:number}} drawn size
   */
  fitSize(imgW, imgH, boxW, boxH) {
    if (imgW <= 0 || imgH <= 0 || boxW <= 0 || boxH <= 0) return { w: 0, h: 0 };
    const scale = Math.min(boxW / imgW, boxH / imgH);
    return { w: imgW * scale, h: imgH * scale };
  },

  /** Classic rule: at most one live bullet on screen, plus cooldown gate. */
  canShoot(liveBullets, cooldownLeft) {
    return liveBullets.length === 0 && cooldownLeft <= 0;
  },

  /**
   * Point values per row (0 = top).
   * Q17 mapping (Task 12 roster): Row1 Dracula 30 | Rows2-3 Ghost 20 | Rows4-5 Witch 10
   */
  pointsForRow(row) {
    return [30, 20, 20, 10, 10][row] ?? 10;
  },

  /** Boo type index for a row (row band groupings) */
  typeForRow(row) {
    return [0, 1, 1, 2, 2][row] ?? 2;
  },

  /** Grid horizontal base speed for a wave: faster each wave, capped (Q15) */
  waveSpeed(wave) {
    return Math.min(55 + 25 * (wave - 1), 300);
  },

  /**
   * Classic "fewer survivors = faster" multiplier on the wave base speed.
   * 1.0 at a full grid, approaching ~2.98 as the last invaders stand. Bounded.
   */
  speedFactor(alive, total) {
    if (total <= 0) return 1;
    alive = Math.max(0, Math.min(alive, total));
    return 1 + 2 * ((total - alive) / total);
  },

  /** Final grid speed: wave base × alive-count speed factor (Q21) */
  gridSpeed(wave, alive, total) {
    return this.waveSpeed(wave) * this.speedFactor(alive, total);
  },

  /**
   * Is a bullet fully off-screen? Direction-aware.
   *   direction <= 0 (player, up):   gone once its bottom edge passes y=0.
   *   direction > 0  (invader, down): gone once its top edge passes canvasH.
   * canvasH defaults to Infinity so an unspecified caller never culls a down-bullet.
   */
  bulletOffScreen(bullet, canvasH = Number.POSITIVE_INFINITY) {
    if (bullet.direction > 0) return bullet.y >= canvasH;
    return bullet.y + bullet.height <= 0;
  },

  /**
   * Task 8 — shooter selection. For each column that still has an alive invader,
   * the bottom-most alive invader in that column is a valid shooter. Pure so it's
   * testable; the random pick among the returned list happens in the game loop.
   * @param {Array<{row:number,col:number,alive:boolean}>} invaders
   * @returns the bottom-most alive invader of each occupied column
   */
  bottommostPerColumn(invaders) {
    const best = {}; // col -> invader with the greatest row that is alive
    for (const inv of invaders) {
      if (!inv.alive) continue;
      const cur = best[inv.col];
      if (!cur || inv.row > cur.row) best[inv.col] = inv;
    }
    return Object.values(best);
  },

  /**
   * Task 8 — base seconds between invader shots. Shorter (faster) the fewer
   * survivors remain and the higher the wave; always bounded by a floor.
   */
  invaderFireInterval(wave, alive, total) {
    const sf = this.speedFactor(alive, total); // 1 .. ~3, classic few=faster
    const base = Math.max(1.6 - (wave - 1) * 0.15, 0.8); // per-wave full-grid base (s)
    return Math.max(base / sf, 0.3); // absolute floor (s)
  },

  /**
   * Task 8 — classic cap on CONCURRENT invader bullets on screen:
   * wave 1 → 1, wave 2 → 2, wave 3+ → 3.
   */
  maxInvaderBullets(wave) {
    return Math.min(3, Math.max(1, wave));
  },

  /** True when the grid touches/exceeds the left/right playfield bounds */
  gridEdgeReached(gridX, gridWidth, canvasW) {
    return gridX <= GRID_MARGIN || gridX + gridWidth >= canvasW - GRID_MARGIN;
  },

  /**
   * Task 9 — initial bunker silhouette (boolean grid, true = solid).
   * A dome: shaved top corners + a centered 3-wide × 2-deep notch, solid base.
   */
  shieldInitialMask(cols, rows) {
    const g = [];
    for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(true));
    const nw = Math.min(3, cols), nd = Math.min(2, rows);
    const sc = Math.floor((cols - nw) / 2);
    for (let r = 0; r < nd; r++) for (let c = sc; c < sc + nw; c++) g[r][c] = false;
    if (cols > 2 && rows > 1) { g[0][0] = false; g[0][cols - 1] = false; }
    return g;
  },

  /**
   * Task 9 — which shield cells a bullet melts on impact. Deterministic so it's
   * testable: a 2-wide scrape at the hit row, a 2-deep channel in the bullet's
   * direction of travel, plus the one cell it approached from. All clamped.
   * @returns {Array<[number,number]>} [row,col] pairs to clear
   */
  shieldErosion(rows, cols, hitRow, hitCol, dir) {
    const out = new Set();
    const add = (r, c) => { if (r >= 0 && r < rows && c >= 0 && c < cols) out.add(r * 1000 + c); };
    add(hitRow, hitCol);
    add(hitRow, hitCol - 1);
    add(hitRow, hitCol + 1);
    for (let d = 1; d <= 2; d++) add(hitRow + dir * d, hitCol);
    add(hitRow - dir, hitCol);
    return [...out].map((k) => [Math.floor(k / 1000), k % 1000]);
  },

  /**
   * Task 10 — classic-weighted UFO bonus: 50 / 100 / 150 / 300 at 30/30/30/10.
   * (In the original the value was a hidden per-run random; we keep the pool.)
   */
  pickUfoBonus() {
    const r = Math.random() * 100;
    if (r < 30) return 50;
    if (r < 60) return 100;
    if (r < 90) return 150;
    return 300;
  },

  /** Task 10 — uniform random seconds between UFO appearances. */
  nextUfoDelay(min, max) {
    return min + Math.random() * (max - min);
  },

  /** Task 10 — UFO fully clear of the playfield on either side (center-x based). */
  ufoOffScreen(x, w, canvasW) {
    return x + w / 2 <= 0 || x - w / 2 >= canvasW;
  },

  /**
   * Task 11 — death-burst parameters scaled by the kill's point value:
   * more particles, wider spread, longer-lived for high-value kills.
   * The 30pt tier doubles as the UFO jackpot tier (call with 300).
   */
  explosionSpec(points) {
    const big = points >= 30;
    return {
      count: big ? 24 : 14,
      speedMin: 60,
      speedMax: big ? 280 : 190,
      life: big ? 0.6 : 0.45,
    };
  },
};

/* -----------------------------------------------------------
 * AudioManager — 8-bit Web Audio synthesis (no sound files)
 * ----------------------------------------------------------- */
class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.heartbeatStep = 0;
  }

  /** Must be called from a user gesture (autoplay policy). Idempotent. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // very old browser — game plays silently
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  /** Single square/sine/triangle blip with optional pitch glide */
  tone({ freq, glideTo = null, type = 'square', dur = 0.1, vol = 0.3, when = 0 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Short white-noise burst (explosion body) */
  noise({ dur = 0.2, vol = 0.4, when = 0, cutoff = 1200 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + when;
    const frames = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t0);
  }

  /* ---------------- game-facing cues ---------------- */

  playShoot() {
    this.tone({ freq: 880, glideTo: 220, type: 'square', dur: 0.12, vol: 0.25 });
  }

  /** Invader shots are lower/muddier than the player's (readability). */
  playInvaderFire() {
    this.tone({ freq: 320, glideTo: 110, type: 'square', dur: 0.1, vol: 0.12 });
  }

  /** A bullet is chewed to bits by a bunker. */
  playShieldHit() {
    this.tone({ freq: 200, glideTo: 90, type: 'triangle', dur: 0.07, vol: 0.14 });
  }

  /** Task 10 — UFO down: a sparkly two-note "ding-ching" plus soft blast. */
  playUfo() {
    this.tone({ freq: 880, glideTo: 1760, type: 'triangle', dur: 0.16, vol: 0.2 });
    this.tone({ freq: 1320, type: 'square', dur: 0.18, vol: 0.14, when: 0.14 });
    this.noise({ dur: 0.18, vol: 0.22, cutoff: 2200 });
  }

  playKill(points) {
    this.noise({ dur: 0.18, vol: 0.5, cutoff: 900 });
    if (points >= 30) {
      this.tone({ freq: 660, glideTo: 440, type: 'square', dur: 0.15, vol: 0.22 });
      this.tone({ freq: 990, glideTo: 660, type: 'square', dur: 0.15, vol: 0.15, when: 0.06 });
    }
  }

  playHit() {
    this.tone({ freq: 220, glideTo: 55, type: 'sawtooth', dur: 0.4, vol: 0.35 });
    this.noise({ dur: 0.3, vol: 0.4, cutoff: 500 });
  }

  playGameOver() {
    const notes = [392, 330, 262, 196]; // G4 E4 C4 G3
    notes.forEach((f, i) => this.tone({ freq: f, type: 'square', dur: 0.22, vol: 0.28, when: i * 0.18 }));
  }

  playVictory() {
    const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
    notes.forEach((f, i) => this.tone({ freq: f, type: 'square', dur: 0.14, vol: 0.25, when: i * 0.11 }));
  }

  /**
   * Classic grid "heartbeat": C5 E5 G5 E5 arpeggio, one note per grid step.
   * Step index advances externally (every cell-width of travel).
   */
  playHeartbeat() {
    const notes = [523, 659, 784, 659];
    const f = notes[this.heartbeatStep % 4];
    this.heartbeatStep += 1;
    this.tone({ freq: f, type: 'square', dur: 0.07, vol: 0.12 });
  }
}

/* -----------------------------------------------------------
 * Input
 * ----------------------------------------------------------- */
class InputHandler {
  constructor() {
    /** @type {Set<string>} codes currently held down */
    this.down = new Set();
    /** codes that were pressed this frame (edge-triggered) */
    this.pressed = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });

    // Don't let stray held keys survive a tab switch
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(...codes) {
    return codes.some((c) => this.down.has(c));
  }

  /** True only on the frame the key went down */
  wasPressed(...codes) {
    return codes.some((c) => this.pressed.has(c));
  }

  /** Call once per frame, at the end, to clear edge-trigger state */
  endFrame() {
    this.pressed.clear();
  }
}

class Shield {
  /**
   * A destructible bunker: a boolean cell-grid. Either bullet kind melts a
   * small cluster on impact and is absorbed; the descending invader grid crushes
   * whatever cells it covers. Fully-eroded shields stop blocking and stop drawing.
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.cell = SHIELD_CELL;
    this.cols = SHIELD_COLS;
    this.rows = SHIELD_ROWS;
    this.mask = Rules.shieldInitialMask(this.cols, this.rows);
  }

  get width() { return this.cols * this.cell; }
  get height() { return this.rows * this.cell; }

  isDestroyed() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.mask[r][c]) return false;
    return true;
  }

  cellSolid(r, c) {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols && this.mask[r][c];
  }

  /**
   * @param {Bullet} b any bullet
   * @returns {boolean} true if the bullet struck solid material (and was eroded/absorbed)
   */
  hitByBullet(b) {
    const cell = this.cell;
    const lx = b.x - b.width / 2 - this.x;
    const ly = b.y - this.y;
    const c0 = Math.max(0, Math.floor(lx / cell));
    const c1 = Math.min(this.cols - 1, Math.floor((lx + b.width) / cell));
    const r0 = Math.max(0, Math.floor(ly / cell));
    const r1 = Math.min(this.rows - 1, Math.floor((ly + b.height) / cell));

    // Impact cell = solid cell nearest the bullet's center
    const bcx = lx + b.width / 2;
    const bcy = ly + b.height / 2;
    let best = null, bd = Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!this.cellSolid(r, c)) continue;
        const d = (c * cell + cell / 2 - bcx) ** 2 + (r * cell + cell / 2 - bcy) ** 2;
        if (d < bd) { bd = d; best = [r, c]; }
      }
    }
    if (!best) return false; // bullet clipped through a gap → passes on

    for (const [r, c] of Rules.shieldErosion(this.rows, this.cols, best[0], best[1], b.direction))
      this.mask[r][c] = false;
    return true;
  }

  /** Erase every solid cell covered by an absolute-coord rect (the descending grid). */
  crushByRect(gx, gy, gw, gh) {
    const cell = this.cell;
    const c0 = Math.max(0, Math.floor((gx - this.x) / cell));
    const c1 = Math.min(this.cols - 1, Math.floor((gx + gw - this.x) / cell));
    const r0 = Math.max(0, Math.floor((gy - this.y) / cell));
    const r1 = Math.min(this.rows - 1, Math.floor((gy + gh - this.y) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.mask[r][c] = false;
  }

  draw(ctx) {
    ctx.fillStyle = COLORS.shield;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.mask[r][c]) ctx.fillRect(this.x + c * this.cell, this.y + r * this.cell, this.cell, this.cell);
      }
    }
  }
}

class Ufo {
  /**
   * Task 10 — the mystery ship. Crosses the top of the field once, in a random
   * direction, carrying a weighted bonus (50/100/150/300 at 30/30/30/10).
   */
  constructor() {
    this.w = UFO_W;
    this.h = UFO_H;
    this.y = UFO_Y;
    const fromLeft = Math.random() < 0.5;
    this.dir = fromLeft ? 1 : -1;
    this.x = fromLeft ? -this.w / 2 : CANVAS_W + this.w / 2; // start fully off-screen
    this.bonus = Rules.pickUfoBonus();
  }

  update(dt) {
    this.x += this.dir * UFO_SPEED * dt;
  }

  draw(ctx) {
    const x = this.x;
    const y = this.y;
    const w = this.w;
    const h = this.h;
    // Dome
    ctx.fillStyle = '#ffd7f4';
    ctx.beginPath();
    ctx.ellipse(x, y + h * 0.45, w * 0.22, h * 0.45, 0, Math.PI, 2 * Math.PI);
    ctx.fill();
    // Body
    ctx.fillStyle = '#ff5fd0';
    ctx.beginPath();
    ctx.ellipse(x, y + h * 0.45, w * 0.5, h * 0.34, 0, 0, 2 * Math.PI);
    ctx.fill();
    // A few glowing lights
    ctx.fillStyle = '#ffffff';
    for (let i = -1; i <= 1; i++) ctx.fillRect(x + i * (w * 0.2), y + h * 0.45 - 2, 4, 4);
  }
}

/** Task 10 — short-lived floating "+150" at the kill spot; fades and drifts up. */
class ScorePopup {
  constructor(x, y, text) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.age = 0;
    this.life = 1.0;
  }

  update(dt) {
    this.age += dt;
    this.y -= 26 * dt;
  }

  get dead() { return this.age >= this.life; }

  draw(ctx) {
    ctx.globalAlpha = Math.max(0, 1 - this.age / this.life);
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.textAlign = 'center';
    // Task 11 — dark outline keeps the bonus legible over faces/bunkers
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.strokeText(this.text, this.x, this.y);
    ctx.fillStyle = '#ff5fd0';
    ctx.fillText(this.text, this.x, this.y);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}

/* -----------------------------------------------------------
 * Task 11 — Particle (explosion sparkle)
 * ----------------------------------------------------------- */
/** A small drifting spark: radial velocity + gentle gravity, fades out. */
class Particle {
  constructor(x, y, angle, speed, life, color, size) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.life = life;
    this.age = 0;
    this.color = color;
    this.size = size;
  }

  update(dt) {
    this.age += dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += 60 * dt; // gentle gravity — sparks arc and fall, arcade-style
  }

  get dead() { return this.age >= this.life; }

  draw(ctx) {
    ctx.globalAlpha = Math.max(0, 1 - this.age / this.life);
    ctx.fillStyle = this.color;
    const s = this.size;
    ctx.fillRect(this.x - s / 2, this.y - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
}

/* -----------------------------------------------------------
 * Player
 * ----------------------------------------------------------- */
class Player {
  constructor(width, height, speed, x, y) {
    this.width = width;
    this.height = height;
    this.speed = speed; // px per second
    this.x = x; // center x
    this.y = y; // bottom edge y
  }

  get left() { return this.x - this.width / 2; }
  get right() { return this.x + this.width / 2; }
  get top() { return this.y - this.height; }

  reset() {
    this.x = CANVAS_W / 2;
    this.y = CANVAS_H - 64;
  }

  update(dt, input) {
    if (input.isDown('ArrowLeft', 'KeyA')) this.x -= this.speed * dt;
    if (input.isDown('ArrowRight', 'KeyD')) this.x += this.speed * dt;

    const half = this.width / 2;
    this.x = Math.max(half + 8, Math.min(CANVAS_W - half - 8, this.x));
  }

  /* Classic Space Invaders cannon, drawn as filled vectors.
   * x = center, y = bottom edge of the ship. */
  draw(ctx) {
    const { x, y, width: w } = this;
    const hw = w / 2;

    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    // Base
    ctx.rect(x - hw, y - 12, w, 12);
    // Mid trapezoid
    ctx.moveTo(x - hw + 8, y - 12);
    ctx.lineTo(x + hw - 8, y - 12);
    ctx.lineTo(x + hw - 16, y - 24);
    ctx.lineTo(x - hw + 16, y - 24);
    ctx.closePath();
    // Barrel (bullet spawns from here)
    ctx.rect(x - 4, y - 40, 8, 16);
    ctx.fill();
  }
}

/* -----------------------------------------------------------
 * Bullet
 * ----------------------------------------------------------- */
class Bullet {
  /**
   * @param {number} x center x
   * @param {number} y top-edge y
   * @param {object} [opts]
   *   direction: -1 (up, player) | +1 (down, invader)
   *   kind: 'player' | 'invader'  (drives which collisions it participates in)
   */
  constructor(x, y, opts = {}) {
    const { width = 4, height = 14, speed = BULLET_SPEED, direction = -1, kind = 'player' } = opts;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.speed = speed;
    this.direction = direction;
    this.kind = kind;
  }

  update(dt) {
    this.y += this.direction * this.speed * dt; // -1 → up, +1 → down
  }

  draw(ctx) {
    ctx.fillStyle = this.kind === 'invader' ? '#ff9d5c' : COLORS.bullet;
    ctx.fillRect(this.x - this.width / 2, this.y, this.width, this.height);
  }
}

/* -----------------------------------------------------------
 * Invader
 * ----------------------------------------------------------- */
class Invader {
  constructor(row, col, typeIndex, typeDef, points) {
    this.row = row;
    this.col = col;
    this.typeIndex = typeIndex;
    this.type = typeDef;
    this.points = points;
    this.alive = true;
    this.image = typeDef.image; // HTMLImageElement (may not be loaded yet)
    this.w = INVADER_W;
    this.h = INVADER_H;
  }

  /** Top-left position within the grid cell area (grid provides offsets). */
  draw(ctx, offsetX, offsetY) {
    if (!this.alive) return;
    const x = offsetX + this.col * CELL_W + (CELL_W - this.w) / 2;
    const y = offsetY + this.row * CELL_H + (CELL_H - this.h) / 2;

    if (this.image && this.image.complete && this.image.naturalWidth > 0) {
      // Contain-fit inside the hitbox — the sprite never bleeds into a neighbor's cell (Q24)
      const { w: dw, h: dh } = Rules.fitSize(this.image.naturalWidth, this.image.naturalHeight, this.w, this.h);
      ctx.drawImage(this.image, x + (this.w - dw) / 2, y + (this.h - dh) / 2, dw, dh);
    } else {
      // Placeholder until the PNG is loaded
      ctx.fillStyle = COLORS.placeholder;
      ctx.fillRect(x, y, this.w, this.h);
    }
  }
}

/* -----------------------------------------------------------
 * InvaderGrid
 * ----------------------------------------------------------- */
class InvaderGrid {
  /** @param {HTMLImageElement[]} typeImages one image per 'boo' type */
  constructor(typeImages) {
    this.typeImages = typeImages;

    // Build the 5x11 formation, row-banded by 'boo' type
    this.invaders = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      const typeIndex = Rules.typeForRow(row);
      for (let col = 0; col < GRID_COLS; col++) {
        this.invaders.push(new Invader(
          row, col, typeIndex,
          { ...BOO_TYPES[typeIndex], image: typeImages[typeIndex] },
          Rules.pointsForRow(row),
        ));
      }
    }

    /* Grid position (top-left of the whole formation), centered at start */
    this.width = GRID_COLS * CELL_W;
    this.height = GRID_ROWS * CELL_H;
    this.x = (CANVAS_W - this.width) / 2;
    this.y = 130;
    this.direction = 1;
    this.reachedBottom = false;
  }

  update(dt, speed) {
    if (this.reachedBottom || this.getAliveCount() === 0) return;

    this.x += speed * this.direction * dt;

    if (Rules.gridEdgeReached(this.x, this.width, CANVAS_W)) {
      this.direction *= -1;
      this.y += GRID_DROP_STEP;
    }

    /* Hard floor: let the grid descend onto the player so the
     * player-overlap game-over check (Task 4) can trigger. */
    const floor = CANVAS_H - 60;
    if (this.y + this.height >= floor) {
      this.y = floor - this.height;
      this.reachedBottom = true;
    }
  }

  draw(ctx) {
    for (const invader of this.invaders) invader.draw(ctx, this.x, this.y);
  }

  getAliveCount() {
    return this.invaders.reduce((n, i) => n + (i.alive ? 1 : 0), 0);
  }

  /** Iterate alive invaders with their absolute (screen-space) rects */
  *forEachAlive() {
    for (const inv of this.invaders) {
      if (!inv.alive) continue;
      yield {
        invader: inv,
        x: this.x + inv.col * CELL_W + (CELL_W - inv.w) / 2,
        y: this.y + inv.row * CELL_H + (CELL_H - inv.h) / 2,
        w: inv.w,
        h: inv.h,
      };
    }
  }
}

/* -----------------------------------------------------------
 * Game
 * ----------------------------------------------------------- */
class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = null;
    this.player = new Player(48, 40, PLAYER_SPEED, CANVAS_W / 2, CANVAS_H - 64);
    this.bullets = [];
    this.shotCooldown = 0;
    this.invaderFireTimer = 0.6; // small grace period before the first enemy shot
    this.grid = null;
    this.wave = 1;

    this.typeImages = BOO_TYPES.map((t) => new Image());
    this.audio = new AudioManager();
    this.heartbeatAccum = 0; // px of grid travel since last heartbeat
    this.lastGridX = 0;
    this.score = 0;
    this.lives = STARTING_LIVES;
    this.state = STATE.START;
    this.lastTime = 0;
    // Task 10 — mystery ship
    this.ufo = null;
    this.ufoTimer = Rules.nextUfoDelay(UFO_MIN_DELAY, UFO_MAX_DELAY);
    this.popups = [];
    this.particles = []; // Task 11 — spark pool
  }

  init() {
    this.input = new InputHandler();

    // First keypress counts as a user gesture → unlock Web Audio
    window.addEventListener('keydown', () => this.audio.unlock());

    BOO_TYPES.forEach((type, i) => {
      this.typeImages[i].src = type.file;
    });
  }

  start() {
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.gameLoop(t));
  }

  gameLoop(timestamp) {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
    this.lastTime = timestamp;

    this.update(dt);
    this.draw();

    this.input.endFrame();
    requestAnimationFrame((t) => this.gameLoop(t));
  }

  beginPlay() {
    this.score = 0;
    this.lives = STARTING_LIVES;
    this.wave = 1;
    this.resetField();
  }

  /** Fresh grid at current wave (classic: same level, same base speed, score kept) */
  restartWave() {
    this.resetField();
  }

  nextWave() {
    this.wave += 1;
    this.resetField();
  }

  resetField() {
    this.player.reset();
    this.bullets = [];
    this.shotCooldown = 0;
    this.invaderFireTimer = 0.6;
    this.heartbeatAccum = 0;
    this.audio.heartbeatStep = 0;
    this.grid = new InvaderGrid(this.typeImages);
    this.shields = this.makeShields(); // fresh bunkers on every respawn (Q23)
    this.lastGridX = this.grid.x;
    // Task 10 — clear any in-flight bonus ship / popups on field reset
    this.ufo = null;
    this.ufoTimer = Rules.nextUfoDelay(UFO_MIN_DELAY, UFO_MAX_DELAY);
    this.popups = [];
    this.particles = []; // Task 11 — no sparks carry across a respawn
  }

  /** Four bunkers spread symmetrically across the field, just above the player. */
  makeShields() {
    const gap = (CANVAS_W - SHIELD_COUNT * SHIELD_W) / 5;
    const shields = [];
    for (let i = 0; i < SHIELD_COUNT; i++) {
      shields.push(new Shield(gap + i * (SHIELD_W + gap), SHIELD_Y));
    }
    return shields;
  }

  /** The descending invader grid physically crushes any bunker cells it covers. */
  updateShields() {
    const g = this.grid;
    for (const s of this.shields) {
      if (s.isDestroyed()) continue;
      if (Rules.aabbOverlaps(g.x, g.y, g.width, g.height, s.x, s.y, s.width, s.height)) {
        s.crushByRect(g.x, g.y, g.width, g.height);
      }
    }
  }

  /* ---------------------------------------------------------
   * Task 10 — the mystery ship (UFO) + score popups
   * --------------------------------------------------------- */
  updateUfo(dt) {
    if (this.ufo) {
      this.ufo.update(dt);
      if (Rules.ufoOffScreen(this.ufo.x, this.ufo.w, CANVAS_W)) this.ufo = null; // drifted away
      return;
    }
    this.ufoTimer -= dt;
    if (this.ufoTimer <= 0) this.ufo = new Ufo(); // timed appearance, never spammed
  }

  updatePopups(dt) {
    for (const p of this.popups) p.update(dt);
    this.popups = this.popups.filter((p) => !p.dead);
  }

  /* ---------------------------------------------------------
   * Task 11 — particle bursts (juice on kills)
   * --------------------------------------------------------- */
  /** Radial spark burst at (x, y), scaled by the kill's point value. */
  spawnBurst(x, y, points, colors) {
    const spec = Rules.explosionSpec(points);
    for (let i = 0; i < spec.count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = spec.speedMin + Math.random() * (spec.speedMax - spec.speedMin);
      const life = spec.life * (0.6 + Math.random() * 0.4);
      const color = colors[Math.floor(Math.random() * colors.length)];
      this.particles.push(new Particle(x, y, angle, speed, life, color, 2 + Math.random() * 2));
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) p.update(dt);
    this.particles = this.particles.filter((p) => !p.dead);
  }

  drawParticles(ctx) {
    for (const p of this.particles) p.draw(ctx);
  }

  update(dt) {
    switch (this.state) {
      case STATE.START:
        if (this.input.wasPressed('Space')) {
          this.state = STATE.PLAYING;
          this.beginPlay();
        }
        break;

      case STATE.PLAYING:
        if (this.input.wasPressed('KeyM')) this.audio.toggleMute();
        this.player.update(dt, this.input);
        this.updateShooting(dt);
        this.updateBullets(dt);
        this.grid.update(dt, Rules.gridSpeed(this.wave, this.grid.getAliveCount(), this.grid.invaders.length));
        this.updateShields(); // grid crush (classic: invaders grind the bunkers)
        this.updateUfo(dt);   // Task 10 — the mystery ship
        this.updatePopups(dt);
        this.updateParticles(dt); // Task 11 — spark physics
        this.updateInvaderFire(dt);
        this.updateHeartbeat();
        this.updateCollisions();
        this.checkEndConditions();
        break;

      case STATE.GAME_OVER:
        this.updateParticles(dt); // let the last burst finish fading behind the menu
        if (this.input.wasPressed('Space')) this.state = STATE.START;
        break;

      case STATE.VICTORY:
        this.updateParticles(dt);
        if (this.input.wasPressed('Space')) {
          this.nextWave();
          this.state = STATE.PLAYING;
        }
        break;
    }
  }

  updateShooting(dt) {
    this.shotCooldown = Math.max(0, this.shotCooldown - dt);

    const livePlayerBullets = this.bullets.filter((b) => b.kind === 'player');
    if (this.input.wasPressed('Space') && Rules.canShoot(livePlayerBullets, this.shotCooldown)) {
      this.bullets.push(new Bullet(this.player.x, this.player.y - 48));
      this.shotCooldown = BULLET_COOLDOWN;
      this.audio.playShoot();
    }
  }

  updateBullets(dt) {
    for (const bullet of this.bullets) bullet.update(dt);
    this.bullets = this.bullets.filter((b) => !Rules.bulletOffScreen(b, CANVAS_H));
  }

  /**
   * Task 8 — invaders shoot back. A random bottom-most invader of a random
   * occupied column fires one downward bullet, subject to the classic cap on
   * concurrent enemy bullets for this wave. Resamples a jittered interval.
   */
  updateInvaderFire(dt) {
    this.invaderFireTimer -= dt;
    if (this.invaderFireTimer > 0) return;

    const total = this.grid.invaders.length;
    const alive = this.grid.getAliveCount();
    const base = Rules.invaderFireInterval(this.wave, alive, total);
    const onscreen = this.bullets.reduce((n, b) => n + (b.kind === 'invader' ? 1 : 0), 0);

    if (onscreen < Rules.maxInvaderBullets(this.wave)) {
      const candidates = Rules.bottommostPerColumn(this.grid.invaders);
      if (candidates.length > 0) {
        const s = candidates[Math.floor(Math.random() * candidates.length)];
        const sx = this.grid.x + s.col * CELL_W + CELL_W / 2;
        const sy = this.grid.y + s.row * CELL_H + CELL_H; // just below the shooter
        this.bullets.push(new Bullet(sx, sy, {
          width: 5, height: 12, speed: INVADER_BULLET_SPEED, direction: 1, kind: 'invader',
        }));
        this.audio.playInvaderFire();
      }
    }

    // Next shot: base interval with ±up-to-50% random jitter (0.5x..1.5x).
    this.invaderFireTimer = base * (0.5 + Math.random());
  }

  updateCollisions() {
    // Task 10 — the mystery ship: only the player can shoot it, one bullet is spent.
    if (this.ufo) {
      const u = this.ufo;
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (b.kind !== 'player') continue;
        if (Rules.aabbOverlaps(b.x - b.width / 2, b.y, b.width, b.height, u.x - u.w / 2, u.y, u.w, u.h)) {
          this.score += u.bonus;
          this.popups.push(new ScorePopup(u.x, u.y + u.h / 2, '+' + u.bonus));
          this.spawnBurst(u.x, u.y + u.h / 2, 300, BURST_COLORS_UFO); // Task 11 — jackpot-tier burst
          this.audio.playUfo();
          this.bullets.splice(i, 1);
          this.ufo = null;
          this.ufoTimer = Rules.nextUfoDelay(UFO_MIN_DELAY, UFO_MAX_DELAY);
          break;
        }
      }
    }

    // Shields absorb any bullet that strikes solid material — for BOTH sides.
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      let absorbed = false;
      for (const s of this.shields) {
        if (s.isDestroyed()) continue;
        const bx = b.x - b.width / 2;
        if (!Rules.aabbOverlaps(bx, b.y, b.width, b.height, s.x, s.y, s.width, s.height)) continue;
        if (s.hitByBullet(b)) { absorbed = true; this.audio.playShieldHit(); break; }
      }
      if (absorbed) this.bullets.splice(i, 1);
    }

    // Player bullets (up) → invaders (those that got through / along holes)
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (b.kind !== 'player') continue;
      const bx = b.x - b.width / 2;

      for (const slot of this.grid.forEachAlive()) {
        if (Rules.aabbOverlaps(bx, b.y, b.width, b.height, slot.x, slot.y, slot.w, slot.h)) {
          slot.invader.alive = false;
          this.score += slot.invader.points;
          this.spawnBurst(slot.x + slot.w / 2, slot.y + slot.h / 2, slot.invader.points, BURST_COLORS_INVADER); // Task 11
          this.bullets.splice(i, 1);
          this.audio.playKill(slot.invader.points);
          break; // one bullet = one invader
        }
      }
    }

    // Invader bullets (down) → player
    const p = this.player;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (b.kind !== 'invader') continue;
      const bx = b.x - b.width / 2;
      if (Rules.aabbOverlaps(bx, b.y, b.width, b.height, p.left, p.top, p.width, p.height)) {
        this.bullets.splice(i, 1);
        this.onPlayerHit();
        break; // one hit this frame is enough
      }
    }
  }

  /** Shared life-loss path: hit by an invader bullet OR the grid reaching you. */
  onPlayerHit() {
    this.audio.playHit();
    this.lives -= 1;
    if (this.lives <= 0) {
      this.audio.playGameOver();
      this.state = STATE.GAME_OVER;
    } else {
      this.restartWave(); // classic: same wave, same base speed, fresh grid
    }
  }

  /* Classic grid "heartbeat": one C-E-G-E note per cell-width of travel,
   * so the pattern naturally quickens as the grid (and waves) speed up. */
  updateHeartbeat() {
    const dx = Math.abs(this.grid.x - this.lastGridX);
    this.lastGridX = this.grid.x;
    if (dx <= 0) return;
    this.heartbeatAccum += dx;
    while (this.heartbeatAccum >= CELL_W) {
      this.heartbeatAccum -= CELL_W;
      this.audio.playHeartbeat();
    }
  }

  checkEndConditions() {
    if (this.state !== STATE.PLAYING) return; // a bullet hit may have already resolved this frame

    // Wave cleared → victory screen → Space starts the next, faster wave
    if (this.grid.getAliveCount() === 0) {
      this.audio.playVictory();
      this.state = STATE.VICTORY;
      return;
    }

    // Grid reached the player line → lose a life
    if (this.grid.reachedBottom || this.gridTouchesPlayer()) {
      this.onPlayerHit();
    }
  }

  gridTouchesPlayer() {
    const p = this.player;
    for (const slot of this.grid.forEachAlive()) {
      if (Rules.aabbOverlaps(p.left, p.top, p.width, p.height, slot.x, slot.y, slot.w, slot.h)) {
        return true;
      }
    }
    return false;
  }

  draw() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (this.state === STATE.START) {
      this.drawStartScreen(ctx);
    }
    if (this.state === STATE.PLAYING) {
      if (this.ufo) this.ufo.draw(ctx);
      this.grid.draw(ctx);
      for (const s of this.shields) if (!s.isDestroyed()) s.draw(ctx);
      this.drawHud(ctx);
      for (const bullet of this.bullets) bullet.draw(ctx);
      this.player.draw(ctx);
      for (const p of this.popups) p.draw(ctx);
      this.drawParticles(ctx); // Task 11 — sparks render on top
    }
    if (this.state === STATE.GAME_OVER) {
      this.grid.draw(ctx);
      for (const s of this.shields) if (!s.isDestroyed()) s.draw(ctx);
      this.drawHud(ctx);
      this.player.draw(ctx);
      this.drawGameOverScreen(ctx);
      this.drawParticles(ctx);
    }
    if (this.state === STATE.VICTORY) {
      this.grid.draw(ctx);
      for (const s of this.shields) if (!s.isDestroyed()) s.draw(ctx);
      this.drawHud(ctx);
      this.player.draw(ctx);
      this.drawVictoryScreen(ctx);
      this.drawParticles(ctx);
    }
  }

  /* ---------------------------------------------------------
   * Screens & HUD
   * --------------------------------------------------------- */
  drawStartScreen(ctx) {
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.accent;
    ctx.font = 'bold 64px "Courier New", monospace';
    ctx.fillText('Halloween Invaders', CANVAS_W / 2, 300);

    ctx.fillStyle = COLORS.text;
    ctx.font = '24px "Courier New", monospace';
    ctx.fillText('The Monsters are coming.', CANVAS_W / 2, 370);

    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    if (blink) {
      ctx.fillStyle = COLORS.accent;
      ctx.font = '28px "Courier New", monospace';
      ctx.fillText('PRESS SPACE TO START', CANVAS_W / 2, 480);
    }

    ctx.fillStyle = '#888';
    ctx.font = '18px "Courier New", monospace';
    ctx.fillText('A / D  or  ← / →  to move   ·   SPACE to shoot', CANVAS_W / 2, 560);
  }

  drawHud(ctx) {
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    // Task 11 — HUD: score/wave bumped to 22px with a touch more top margin
    ctx.font = '22px "Courier New", monospace';
    ctx.fillText(`SCORE  ${String(this.score).padStart(5, '0')}`, 16, 32);
    ctx.textAlign = 'right';
    ctx.fillText(`WAVE ${this.wave}`, CANVAS_W - 16, 32);

    ctx.font = '14px "Courier New", monospace';
    ctx.fillStyle = this.audio.muted ? '#666' : '#3cff9e';
    ctx.fillText(this.audio.muted ? 'SOUND OFF (M)' : 'SOUND ON (M)', CANVAS_W - 16, 54);

    /* Lives as small ship icons, bottom-left */
    for (let i = 0; i < this.lives; i++) {
      this.drawShipIcon(ctx, 22 + i * 30, CANVAS_H - 14);
    }
  }

  /* Mini cannon icon: cx = center, y = bottom edge */
  drawShipIcon = (ctx, cx, y) => {
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.rect(cx - 12, y - 6, 24, 6);          // base
    ctx.moveTo(cx - 6, y - 6);                 // trapezoid
    ctx.lineTo(cx + 6, y - 6);
    ctx.lineTo(cx + 3, y - 12);
    ctx.lineTo(cx - 3, y - 12);
    ctx.closePath();
    ctx.rect(cx - 2, y - 17, 4, 5);            // barrel
    ctx.fill();
  };

  drawGameOverScreen(ctx) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5555';
    ctx.font = 'bold 56px "Courier New", monospace';
    ctx.fillText('GAME OVER', CANVAS_W / 2, 360);

    ctx.fillStyle = COLORS.text;
    ctx.font = '26px "Courier New", monospace';
    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    if (blink) ctx.fillText('PRESS SPACE TO RESTART', CANVAS_W / 2, 440);
  }

  drawVictoryScreen(ctx) {
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.accent;
    ctx.font = 'bold 52px "Courier New", monospace';
    ctx.fillText(`WAVE ${this.wave} CLEARED!`, CANVAS_W / 2, 360);

    ctx.fillStyle = COLORS.text;
    ctx.font = '24px "Courier New", monospace';
    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    if (blink) ctx.fillText('PRESS SPACE FOR NEXT WAVE', CANVAS_W / 2, 440);
  }
}

/* -----------------------------------------------------------
 * Boot (browser only)
 * ----------------------------------------------------------- */
if (typeof window !== 'undefined') {
  const game = new Game(document.getElementById('game'));
  game.init();
  game.start();
}

/* Node export for test.js — invisible in the browser */
if (typeof module !== 'undefined') {
  module.exports = { Rules, GRID_MARGIN, CELL_W, INVADER_W, INVADER_H, BOO_TYPES, Shield, SHIELD_COUNT, SHIELD_CELL, SHIELD_COLS, SHIELD_ROWS, SHIELD_Y, Ufo, UFO_W, UFO_H, UFO_SPEED, UFO_MIN_DELAY, UFO_MAX_DELAY };
}
