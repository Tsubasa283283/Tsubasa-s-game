'use strict';

// ════════════════════════════════════════════════════════
//  1. CONSTANTS
// ════════════════════════════════════════════════════════
const C = {
  BG:                   '#0a0a0f',
  PLAYER_SPEED:         180,
  PLAYER_HP:            60,
  PLAYER_RADIUS:        14,
  BULLET_SPEED:         440,
  BULLET_DAMAGE:        18,
  BULLET_RADIUS:        6,
  BULLET_FIRE_RATE:     0.85,   // shots/sec
  ENEMY_BASE_HP:        30,
  ENEMY_BASE_SPEED:     68,
  ENEMY_RADIUS:         13,
  ORB_RADIUS:           6,
  ORB_ATTRACT_RANGE:    90,
  ORB_ATTRACT_SPEED:    240,
  PARTICLE_COUNT:       8,
  WAVE_INTERVAL:        5,
  DIFF_INTERVAL:        30,
  MAX_ENEMIES:          300,
  MAX_BULLETS:          200,
  MAX_PARTICLES:        600,
  MAX_ORBS:             400,
  CELL_SIZE:            120,
};

// ════════════════════════════════════════════════════════
//  2. UTILITIES
// ════════════════════════════════════════════════════════
function distSq(ax, ay, bx, by) { const dx=ax-bx,dy=ay-by; return dx*dx+dy*dy; }
function dist(ax, ay, bx, by)   { return Math.sqrt(distSq(ax,ay,bx,by)); }
function clamp(v, lo, hi)        { return v < lo ? lo : v > hi ? hi : v; }
function randRange(a, b)         { return a + Math.random() * (b - a); }
function randInt(a, b)           { return Math.floor(randRange(a, b + 1)); }
function randAngle()             { return Math.random() * Math.PI * 2; }
function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2,'0');
  const ss = Math.floor(s % 60).toString().padStart(2,'0');
  return `${m}:${ss}`;
}

// ════════════════════════════════════════════════════════
//  3. SPATIAL HASH GRID
// ════════════════════════════════════════════════════════
class SpatialHashGrid {
  constructor(cellSize) {
    this.cs = cellSize;
    this.cells = new Map();
  }
  _key(cx, cy) { return (cx & 0xffff) | ((cy & 0xffff) << 16); }
  clear() { this.cells.clear(); }
  insert(e) {
    const r = e.radius;
    const x0 = Math.floor((e.x - r) / this.cs);
    const x1 = Math.floor((e.x + r) / this.cs);
    const y0 = Math.floor((e.y - r) / this.cs);
    const y1 = Math.floor((e.y + r) / this.cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this._key(cx, cy);
        let bucket = this.cells.get(k);
        if (!bucket) { bucket = []; this.cells.set(k, bucket); }
        bucket.push(e);
      }
    }
  }
  query(x, y, radius) {
    const result = [];
    const seen = new Set();
    const x0 = Math.floor((x - radius) / this.cs);
    const x1 = Math.floor((x + radius) / this.cs);
    const y0 = Math.floor((y - radius) / this.cs);
    const y1 = Math.floor((y + radius) / this.cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(this._key(cx, cy));
        if (!bucket) continue;
        for (const e of bucket) {
          if (!seen.has(e)) { seen.add(e); result.push(e); }
        }
      }
    }
    return result;
  }
}

// ════════════════════════════════════════════════════════
//  4. OBJECT POOL
// ════════════════════════════════════════════════════════
class ObjectPool {
  constructor(factory, maxSize) {
    this.factory = factory;
    this.pool = [];
    this.active = [];
    this.maxSize = maxSize;
  }
  acquire() {
    const obj = this.pool.length > 0 ? this.pool.pop() : this.factory();
    this.active.push(obj);
    return obj;
  }
  releaseIf(pred) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (pred(this.active[i])) {
        this.pool.push(this.active.splice(i, 1)[0]);
      }
    }
  }
}

// ════════════════════════════════════════════════════════
//  5. PLAYER
// ════════════════════════════════════════════════════════
class Player {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.radius = C.PLAYER_RADIUS;
    // base stats
    this.speed         = C.PLAYER_SPEED;
    this.maxHp         = C.PLAYER_HP;
    this.hp            = C.PLAYER_HP;
    this.damage        = C.BULLET_DAMAGE;
    this.fireRate      = C.BULLET_FIRE_RATE;
    this.bulletRadius  = C.BULLET_RADIUS;
    this.bulletCount   = 1;
    this.pierceCount   = 0;
    this.shield        = 0;
    // state
    this.fireCooldown  = 0;
    this.invTimer      = 0;
    this.level         = 1;
    this.xp            = 0;
    this.xpToNext      = 5;
    this.alive         = true;
    this.angle         = 0; // facing angle for visual
  }

  update(dt, dir, enemies, bulletPool) {
    // movement
    this.x += dir.x * this.speed * dt;
    this.y += dir.y * this.speed * dt;

    // update facing
    if (dir.x !== 0 || dir.y !== 0) {
      this.angle = Math.atan2(dir.y, dir.x);
    }

    // invincibility countdown
    if (this.invTimer > 0) this.invTimer -= dt;

    // auto-fire
    this.fireCooldown -= dt;
    if (this.fireCooldown <= 0) {
      const target = this._nearest(enemies);
      if (target) {
        this._fire(target, bulletPool);
        this.fireCooldown = 1 / this.fireRate;
      }
    }
  }

  _nearest(enemies) {
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      const d = distSq(this.x, this.y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  _fire(target, bulletPool) {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const d  = Math.sqrt(dx*dx + dy*dy) || 1;
    const baseAngle = Math.atan2(dy, dx);
    const spread = (this.bulletCount - 1) * 0.22;

    for (let i = 0; i < this.bulletCount; i++) {
      const angle = baseAngle + (this.bulletCount > 1
        ? -spread/2 + (spread / (this.bulletCount-1)) * i
        : 0);
      const b = bulletPool.acquire();
      b.x      = this.x;
      b.y      = this.y;
      b.vx     = Math.cos(angle) * C.BULLET_SPEED;
      b.vy     = Math.sin(angle) * C.BULLET_SPEED;
      b.radius = this.bulletRadius;
      b.damage = this.damage;
      b.pierce = this.pierceCount;
      b.alive  = true;
      b.hitSet.clear();
    }
  }

  takeDamage(amount) {
    if (this.invTimer > 0) return;
    const dmg = Math.max(0, amount - this.shield);
    this.hp -= dmg;
    this.invTimer = 0.15;
    screenShake(7, 0.25);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }

  gainXP(amount) {
    this.xp += amount;
    while (this.xp >= this.xpToNext && this.alive) {
      this.xp      -= this.xpToNext;
      this.xpToNext = Math.floor(this.xpToNext * 1.20);
      this.levelUp();
    }
  }

  levelUp() {
    this.level++;
    gs.pendingLevelUp = true;
  }

  draw(ctx) {
    const { x, y, invTimer, shield, angle } = this;
    const flash = invTimer > 0 && Math.floor(invTimer * 14) % 2 === 0;
    const t = Date.now() * 0.001;
    const s = 2.1; // drawing scale (1 unit = 2.1px)

    ctx.save();
    ctx.translate(x, y);

    // flip sprite to face movement direction
    if (Math.cos(angle) < -0.1) ctx.scale(-1, 1);

    if (flash) ctx.globalAlpha = 0.4;

    // ── purple aura ──
    const aura = ctx.createRadialGradient(0, -8*s, 2*s, 0, -8*s, 18*s);
    aura.addColorStop(0, 'rgba(160,0,220,0.20)');
    aura.addColorStop(1, 'rgba(160,0,220,0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, -8*s, 18*s, 0, Math.PI * 2);
    ctx.fill();

    // ── cat tail ──
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1e1030';
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(-2*s, 4*s);
    ctx.bezierCurveTo(-8*s, 2*s, -12*s, -4*s, -8*s, -9*s);
    ctx.stroke();
    ctx.strokeStyle = '#3a1850';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(-8*s, -9*s);
    ctx.bezierCurveTo(-10*s, -13*s, -7*s, -14*s, -5.5*s, -11*s);
    ctx.stroke();
    ctx.restore();

    // ── cape ──
    ctx.save();
    ctx.fillStyle = '#0d0720';
    ctx.beginPath();
    ctx.moveTo(-5*s, -3*s);
    ctx.bezierCurveTo(-10*s, 0, -12*s, 7*s, -9*s, 13*s);
    ctx.lineTo(9*s, 13*s);
    ctx.bezierCurveTo(12*s, 7*s, 10*s, 0, 5*s, -3*s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1a0838';
    ctx.beginPath();
    ctx.moveTo(-3*s, 0);
    ctx.bezierCurveTo(-5*s, 4*s, -6*s, 9*s, -4*s, 13*s);
    ctx.lineTo(4*s, 13*s);
    ctx.bezierCurveTo(6*s, 9*s, 5*s, 4*s, 3*s, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── staff pole ──
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#4a3018';
    ctx.lineWidth = 1.8 * s;
    ctx.beginPath();
    ctx.moveTo(4*s, 5*s);
    ctx.lineTo(7.5*s, -16*s);
    ctx.stroke();
    // staff head ring
    ctx.fillStyle = '#3d2810';
    ctx.beginPath();
    ctx.arc(8*s, -16.5*s, 2.8*s, 0, Math.PI * 2);
    ctx.fill();
    // gem glow
    ctx.shadowBlur = 18;
    ctx.shadowColor = '#bf00ff';
    ctx.fillStyle = '#6600bb';
    ctx.beginPath();
    ctx.moveTo(8*s,  -21*s);
    ctx.lineTo(10.5*s,-17*s);
    ctx.lineTo(8*s,  -13.5*s);
    ctx.lineTo(5.5*s, -17*s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#cc55ff';
    ctx.beginPath();
    ctx.moveTo(8*s,  -20*s);
    ctx.lineTo(10*s, -17*s);
    ctx.lineTo(8*s,  -14.5*s);
    ctx.lineTo(6*s,  -17*s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,210,255,0.9)';
    ctx.beginPath();
    ctx.arc(7.4*s, -17.8*s, 0.9*s, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // ── boots ──
    ctx.save();
    ctx.fillStyle = '#110810';
    ctx.beginPath(); ctx.roundRect(-4.2*s, 7.5*s, 3.2*s, 5.5*s, s); ctx.fill();
    ctx.beginPath(); ctx.roundRect(1*s,   7.5*s, 3.2*s, 5.5*s, s); ctx.fill();
    ctx.fillStyle = '#251220';
    ctx.fillRect(-4.2*s, 7.5*s, 3.2*s, 1.4*s);
    ctx.fillRect(1*s,   7.5*s, 3.2*s, 1.4*s);
    ctx.restore();

    // ── coat body ──
    ctx.save();
    ctx.fillStyle = '#15102a';
    ctx.shadowBlur = 4; ctx.shadowColor = '#4a1060';
    ctx.beginPath(); ctx.roundRect(-4.8*s, -3.5*s, 9.6*s, 12*s, 1.5*s); ctx.fill();
    ctx.shadowBlur = 0;
    // gold trim
    ctx.strokeStyle = '#8a6828'; ctx.lineWidth = 0.7 * s;
    ctx.beginPath(); ctx.moveTo(-1*s, -3.5*s); ctx.lineTo(-1*s, 8*s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(1*s,  -3.5*s); ctx.lineTo(1*s,  8*s); ctx.stroke();
    // belt
    ctx.fillStyle = '#2a1a08';
    ctx.beginPath(); ctx.roundRect(-4.8*s, 1.5*s, 9.6*s, 2*s, 0.5*s); ctx.fill();
    ctx.fillStyle = '#9a7830'; ctx.strokeStyle = '#c8a840'; ctx.lineWidth = 0.5*s;
    ctx.beginPath(); ctx.roundRect(-1.3*s, 1.2*s, 2.6*s, 2.4*s, 0.5*s); ctx.fill(); ctx.stroke();
    ctx.restore();

    // ── skirt ──
    ctx.save();
    ctx.fillStyle = '#0e0820';
    ctx.beginPath();
    ctx.moveTo(-5.5*s, 7*s); ctx.lineTo(-7.5*s, 12*s);
    ctx.lineTo(7.5*s,  12*s); ctx.lineTo(5.5*s,  7*s);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(230,215,255,0.35)';
    ctx.beginPath(); ctx.ellipse(0, 12*s, 7.5*s, 1.5*s, 0, 0, Math.PI); ctx.fill();
    ctx.restore();

    // ── left arm ──
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#15102a'; ctx.lineWidth = 3 * s;
    ctx.beginPath(); ctx.moveTo(-3.5*s, -3*s); ctx.lineTo(-5.5*s, 2*s); ctx.stroke();
    ctx.fillStyle = '#f0e0d0';
    ctx.beginPath(); ctx.arc(-5.5*s, 2.8*s, 1.5*s, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // ── right arm (holding staff) ──
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#15102a'; ctx.lineWidth = 3 * s;
    ctx.beginPath(); ctx.moveTo(3.5*s, -3*s); ctx.lineTo(5*s, 4*s); ctx.stroke();
    ctx.fillStyle = '#f0e0d0';
    ctx.beginPath(); ctx.arc(4.8*s, 4.5*s, 1.4*s, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // ── head (skin) ──
    ctx.save();
    ctx.fillStyle = '#f5e8d8';
    ctx.beginPath(); ctx.arc(0, -10*s, 6.5*s, 0, Math.PI*2); ctx.fill();

    // ── hair strands ──
    ctx.fillStyle = '#d4ccdf';
    ctx.beginPath();
    ctx.moveTo(-5*s, -12*s);
    ctx.bezierCurveTo(-8*s, -9*s, -9*s, -5*s, -7*s, -2*s);
    ctx.bezierCurveTo(-6*s, -1*s, -4.5*s, -2*s, -4.5*s, -3.5*s);
    ctx.bezierCurveTo(-6*s, -6*s, -6.5*s, -9*s, -5*s, -12*s);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(5*s, -12*s);
    ctx.bezierCurveTo(8*s, -9*s, 9*s, -5*s, 7*s, -2*s);
    ctx.bezierCurveTo(6*s, -1*s, 4.5*s, -2*s, 4.5*s, -3.5*s);
    ctx.bezierCurveTo(6*s, -6*s, 6.5*s, -9*s, 5*s, -12*s);
    ctx.fill();

    // ── hood ──
    ctx.fillStyle = '#13102a';
    ctx.beginPath();
    ctx.arc(0, -11*s, 8*s, Math.PI * 1.07, Math.PI * 1.93);
    ctx.lineTo(0, -11*s); ctx.closePath(); ctx.fill();
    // hood left drape
    ctx.beginPath();
    ctx.moveTo(-8*s, -11.5*s);
    ctx.bezierCurveTo(-9.5*s, -7*s, -9.5*s, -3*s, -7*s, -1.5*s);
    ctx.lineTo(-4*s, -1.5*s);
    ctx.bezierCurveTo(-6*s, -4*s, -6.5*s, -8*s, -5.5*s, -11.5*s);
    ctx.closePath(); ctx.fill();
    // hood right drape
    ctx.beginPath();
    ctx.moveTo(8*s, -11.5*s);
    ctx.bezierCurveTo(9.5*s, -7*s, 9.5*s, -3*s, 7*s, -1.5*s);
    ctx.lineTo(4*s, -1.5*s);
    ctx.bezierCurveTo(6*s, -4*s, 6.5*s, -8*s, 5.5*s, -11.5*s);
    ctx.closePath(); ctx.fill();
    // hood gold trim
    ctx.strokeStyle = '#8a6828'; ctx.lineWidth = 0.8 * s;
    ctx.beginPath(); ctx.arc(0, -11*s, 8*s, Math.PI*1.07, Math.PI*1.93); ctx.stroke();

    // ── cat ears ──
    // left outer
    ctx.fillStyle = '#13102a';
    ctx.beginPath();
    ctx.moveTo(-5*s, -18*s); ctx.lineTo(-9*s, -24*s); ctx.lineTo(-1.5*s, -19.5*s);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#8a6828'; ctx.lineWidth = 0.6*s; ctx.stroke();
    // left inner
    ctx.fillStyle = '#3a1858';
    ctx.beginPath();
    ctx.moveTo(-5.2*s, -18.8*s); ctx.lineTo(-8*s, -22.8*s); ctx.lineTo(-2.5*s, -20.2*s);
    ctx.closePath(); ctx.fill();
    // right outer
    ctx.fillStyle = '#13102a';
    ctx.beginPath();
    ctx.moveTo(5*s, -18*s); ctx.lineTo(9*s, -24*s); ctx.lineTo(1.5*s, -19.5*s);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#8a6828'; ctx.lineWidth = 0.6*s; ctx.stroke();
    // right inner
    ctx.fillStyle = '#3a1858';
    ctx.beginPath();
    ctx.moveTo(5.2*s, -18.8*s); ctx.lineTo(8*s, -22.8*s); ctx.lineTo(2.5*s, -20.2*s);
    ctx.closePath(); ctx.fill();

    // ── eyes ──
    // left
    ctx.fillStyle = '#4a14a0';
    ctx.beginPath(); ctx.ellipse(-2.3*s, -10.5*s, 2.1*s, 2.5*s, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#8833dd';
    ctx.beginPath(); ctx.ellipse(-2.3*s, -10.5*s, 1.3*s, 1.7*s, 0, 0, Math.PI*2); ctx.fill();
    // right
    ctx.fillStyle = '#4a14a0';
    ctx.beginPath(); ctx.ellipse(2.3*s, -10.5*s, 2.1*s, 2.5*s, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#8833dd';
    ctx.beginPath(); ctx.ellipse(2.3*s, -10.5*s, 1.3*s, 1.7*s, 0, 0, Math.PI*2); ctx.fill();
    // highlights
    ctx.fillStyle = 'rgba(255,200,255,0.85)';
    ctx.beginPath(); ctx.arc(-1.5*s, -11.3*s, 0.75*s, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(3.1*s,  -11.3*s, 0.75*s, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'white';
    ctx.beginPath(); ctx.arc(-1.4*s, -11.6*s, 0.38*s, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(3.2*s,  -11.6*s, 0.38*s, 0, Math.PI*2); ctx.fill();

    ctx.restore(); // head group

    // ── shield ring ──
    if (shield > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, -8*s, 17*s, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(191,0,255,${0.5 + 0.3 * Math.sin(t * 5)})`;
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 14;
      ctx.shadowColor = '#bf00ff';
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ════════════════════════════════════════════════════════
//  6. ENEMY TIERS & CLASS
// ════════════════════════════════════════════════════════
const TIERS = [
  { name:'スライム',       rMul:1.0, hpMul:1,   sMul:1.0,  dmg:10, xp:1,  col:'#9922cc', glow:'#9922cc' },
  { name:'シャドウフード', rMul:0.8, hpMul:0.6, sMul:1.9,  dmg:8,  xp:1,  col:'#5500aa', glow:'#8855ff' },
  { name:'ゴーレム',       rMul:1.7, hpMul:5,   sMul:0.5,  dmg:22, xp:4,  col:'#7700cc', glow:'#bb00ff' },
  { name:'ダークメイジ',   rMul:1.2, hpMul:3,   sMul:1.25, dmg:16, xp:3,  col:'#cc00ff', glow:'#ff44ff' },
];

// ── enemy draw helpers ──

// Tier 0: ダークスライム — 紫の丸に怒り顔
function _drawSlime(ctx, x, y, r, flash) {
  ctx.save();
  ctx.shadowBlur = 12; ctx.shadowColor = '#8800cc';
  ctx.fillStyle = flash ? '#ffffff' : '#3a0a6a';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  if (flash) { ctx.restore(); return; }

  // 怒り眉（逆ハの字）
  ctx.strokeStyle = '#dd55ff'; ctx.lineWidth = r*0.2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x-r*0.5, y-r*0.22); ctx.lineTo(x-r*0.18, y-r*0.38); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.5, y-r*0.22); ctx.lineTo(x+r*0.18, y-r*0.38); ctx.stroke();
  // 目
  ctx.fillStyle = '#ff44ff'; ctx.shadowBlur = 5; ctx.shadowColor = '#ff44ff';
  ctx.beginPath(); ctx.arc(x-r*0.28, y-r*0.1, r*0.16, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x+r*0.28, y-r*0.1, r*0.16, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  // ギザギザの口
  ctx.strokeStyle = '#dd55ff'; ctx.lineWidth = r*0.15; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x-r*0.42, y+r*0.22);
  ctx.lineTo(x-r*0.22, y+r*0.40);
  ctx.lineTo(x,        y+r*0.24);
  ctx.lineTo(x+r*0.22, y+r*0.40);
  ctx.lineTo(x+r*0.42, y+r*0.22);
  ctx.stroke();
  ctx.restore();
}

// Tier 1: ゴースト — 白いゴースト形に邪悪な顔
function _drawShadowHood(ctx, x, y, r, angle, flash) {
  ctx.save();
  ctx.shadowBlur = 14; ctx.shadowColor = '#aaaaff';
  ctx.fillStyle = flash ? '#ffffff' : 'rgba(200,190,255,0.88)';
  // ゴースト形（上半円 + ヒラヒラ下部）
  ctx.beginPath();
  ctx.arc(x, y - r*0.2, r, Math.PI, 0);
  // 下のヒラヒラ3波
  const segments = 3;
  const bx = x + r, by = y - r*0.2;
  for (let i = 0; i < segments; i++) {
    const x1 = bx - (2*r / segments) * (i + 0.5);
    const x2 = bx - (2*r / segments) * (i + 1);
    const dir = i % 2 === 0 ? 1 : -1;
    ctx.quadraticCurveTo(x1, by + r*(0.55 + 0.15*dir), x2, by + r*0.2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  if (flash) { ctx.restore(); return; }
  // 邪悪な目（下げた三角形）
  ctx.fillStyle = '#220040';
  ctx.beginPath(); ctx.arc(x-r*0.3, y-r*0.28, r*0.18, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x+r*0.3, y-r*0.28, r*0.18, 0, Math.PI*2); ctx.fill();
  // にやり笑い
  ctx.strokeStyle = '#220040'; ctx.lineWidth = r*0.16; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(x, y+r*0.05, r*0.32, 0.2, Math.PI-0.2);
  ctx.stroke();
  ctx.restore();
}

// Tier 2: ゴーレム — 大きな暗い丸に怒りの顔と牙
function _drawGolem(ctx, x, y, r, flash) {
  ctx.save();
  ctx.shadowBlur = 16; ctx.shadowColor = '#7700cc';
  ctx.fillStyle = flash ? '#ffffff' : '#1e1830';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  if (flash) { ctx.restore(); return; }
  // ひび割れ模様
  ctx.strokeStyle = 'rgba(100,60,180,0.5)'; ctx.lineWidth = r*0.1;
  ctx.beginPath(); ctx.moveTo(x-r*0.5,y-r*0.7); ctx.lineTo(x-r*0.1,y+r*0.1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.3,y-r*0.5); ctx.lineTo(x+r*0.6,y+r*0.5); ctx.stroke();
  // 怒り眉
  ctx.strokeStyle = '#ff3366'; ctx.lineWidth = r*0.22; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x-r*0.55,y-r*0.28); ctx.lineTo(x-r*0.18,y-r*0.45); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.55,y-r*0.28); ctx.lineTo(x+r*0.18,y-r*0.45); ctx.stroke();
  // 赤く光る目
  ctx.fillStyle = '#ff2255'; ctx.shadowBlur = 10; ctx.shadowColor = '#ff2255';
  ctx.beginPath(); ctx.arc(x-r*0.3, y-r*0.15, r*0.18, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x+r*0.3, y-r*0.15, r*0.18, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  // 牙口
  ctx.strokeStyle = '#cc88ff'; ctx.lineWidth = r*0.14; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x-r*0.45,y+r*0.22); ctx.lineTo(x+r*0.45,y+r*0.22); ctx.stroke();
  ctx.fillStyle = '#ddaaff';
  ctx.beginPath(); ctx.moveTo(x-r*0.25,y+r*0.22); ctx.lineTo(x-r*0.18,y+r*0.44); ctx.lineTo(x-r*0.10,y+r*0.22); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x+r*0.10,y+r*0.22); ctx.lineTo(x+r*0.18,y+r*0.44); ctx.lineTo(x+r*0.25,y+r*0.22); ctx.fill();
  ctx.restore();
}

// Tier 3: ダークメイジ — 炎をまとう紫の丸、狂った笑い顔
function _drawDarkMage(ctx, x, y, r, flash) {
  const t = Date.now() * 0.003;
  ctx.save();
  // 紫炎オーラ
  if (!flash) {
    ctx.shadowBlur = 20; ctx.shadowColor = '#aa00ff';
    for (let i = 0; i < 6; i++) {
      const a = (i/6)*Math.PI*2 + t;
      const flk = 0.65 + 0.35*Math.sin(t*4+i);
      ctx.fillStyle = `rgba(130,0,220,${0.45*flk})`;
      ctx.beginPath();
      ctx.ellipse(x+Math.cos(a)*r*0.88, y+Math.sin(a)*r*0.78, r*0.22, r*0.14, a, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  // 本体
  ctx.fillStyle = flash ? '#ffffff' : '#1a0530';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  if (flash) { ctx.restore(); return; }
  // 怪しい細目
  ctx.fillStyle = '#ee00ff'; ctx.shadowBlur = 8; ctx.shadowColor = '#ff44ff';
  ctx.beginPath(); ctx.ellipse(x-r*0.28, y-r*0.18, r*0.22, r*0.1, -0.3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x+r*0.28, y-r*0.18, r*0.22, r*0.1,  0.3, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  // 狂ったにやり笑い（曲がった口）
  ctx.strokeStyle = '#ee00ff'; ctx.lineWidth = r*0.16; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x-r*0.45, y+r*0.15);
  ctx.bezierCurveTo(x-r*0.2, y+r*0.48, x+r*0.2, y+r*0.48, x+r*0.45, y+r*0.15);
  ctx.stroke();
  // 口の端がつり上がった感じ
  ctx.beginPath(); ctx.moveTo(x-r*0.45,y+r*0.15); ctx.lineTo(x-r*0.45,y+r*0.32); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.45,y+r*0.15); ctx.lineTo(x+r*0.45,y+r*0.32); ctx.stroke();
  ctx.restore();
}

class Enemy {
  constructor(x, y, tier) {
    const t    = TIERS[tier];
    this.x     = x;
    this.y     = y;
    this.tier  = tier;
    this.radius= Math.round(C.ENEMY_RADIUS * t.rMul);
    this.maxHp = C.ENEMY_BASE_HP * t.hpMul * (1 + gs.diffLevel * 0.12);
    this.hp    = this.maxHp;
    this.speed = C.ENEMY_BASE_SPEED * t.sMul * (1 + gs.diffLevel * 0.06);
    this.damage= t.dmg;
    this.xpVal = t.xp;
    this.color = t.col;
    this.glow  = t.glow;
    this.alive       = true;
    this.flashT      = 0;
    this.angle       = 0;
    this.contactCool = 0;
  }

  update(dt, player) {
    const dx = player.x - this.x;
    const dy = player.y - this.y;
    const d  = Math.sqrt(dx*dx + dy*dy) || 1;
    this.angle = Math.atan2(dy, dx);
    this.x += (dx/d) * this.speed * dt;
    this.y += (dy/d) * this.speed * dt;
    if (this.flashT > 0)      this.flashT      -= dt;
    if (this.contactCool > 0) this.contactCool -= dt;

    // damage player on contact (flat damage, per-enemy cooldown)
    if (d < this.radius + player.radius && this.contactCool <= 0) {
      player.takeDamage(this.damage);
      this.contactCool = 0.9;
    }
  }

  takeDamage(amount) {
    this.hp -= amount;
    this.flashT = 0.12;
    if (this.hp <= 0) this.alive = false;
  }

  draw(ctx) {
    const { x, y, radius, flashT, hp, maxHp, color, tier, angle } = this;
    const flash = flashT > 0;

    switch (tier) {
      case 0: _drawSlime(ctx, x, y, radius, flash); break;
      case 1: _drawShadowHood(ctx, x, y, radius, angle, flash); break;
      case 2: _drawGolem(ctx, x, y, radius, flash); break;
      case 3: _drawDarkMage(ctx, x, y, radius, flash); break;
    }

    // HP bar for tank & elite
    if (tier >= 2 && hp < maxHp) {
      ctx.save();
      const bw = radius * 2.8, bh = 4;
      const bx = x - bw/2, by = y - radius - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, bw * (hp/maxHp), bh);
      ctx.restore();
    }
  }
}

// ════════════════════════════════════════════════════════
//  7. BULLETS
// ════════════════════════════════════════════════════════
function makeBullet() {
  return { x:0, y:0, vx:0, vy:0, radius:0, damage:0, pierce:0, alive:false, hitSet: new Set() };
}

function updateBullets(dt, grid, bulletPool, canvas) {
  const hw = canvas.width  * 3;
  const hh = canvas.height * 3;
  const cx = gs.player.x;
  const cy = gs.player.y;

  for (const b of bulletPool.active) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // cull far bullets
    if (Math.abs(b.x - cx) > hw || Math.abs(b.y - cy) > hh) {
      b.alive = false; continue;
    }

    // collision
    const candidates = grid.query(b.x, b.y, b.radius + 40);
    for (const e of candidates) {
      if (!e.alive || b.hitSet.has(e)) continue;
      const sum = b.radius + e.radius;
      if (distSq(b.x, b.y, e.x, e.y) < sum * sum) {
        e.takeDamage(b.damage);
        b.hitSet.add(e);
        spawnHitParticle(b.x, b.y);
        if (!e.alive) {
          spawnDeathParticles(e.x, e.y, e.color);
          spawnOrb(e.x, e.y, e.xpVal);
          gs.kills++;
          AudioManager.playKill();
          gs.enemies.splice(gs.enemies.indexOf(e), 1);
        }
        if (b.pierce <= 0) { b.alive = false; break; }
        b.pierce--;
      }
    }
  }
  bulletPool.releaseIf(b => !b.alive);
}

function drawBullet(ctx, b) {
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
  ctx.fillStyle = '#cc55ff';
  ctx.shadowBlur  = 18;
  ctx.shadowColor = '#bf00ff';
  ctx.fill();
  ctx.shadowBlur = 0;
}

// ════════════════════════════════════════════════════════
//  8. PARTICLES
// ════════════════════════════════════════════════════════
function makeParticle() {
  return { x:0, y:0, vx:0, vy:0, radius:0, color:'', alpha:1, life:0, maxLife:1 };
}

function spawnDeathParticles(x, y, color) {
  for (let i = 0; i < C.PARTICLE_COUNT; i++) {
    if (gs.particles.active.length >= C.MAX_PARTICLES) break;
    const a = randAngle();
    const s = randRange(55, 190);
    const p = gs.particles.acquire();
    p.x = x; p.y = y;
    p.vx = Math.cos(a)*s; p.vy = Math.sin(a)*s;
    p.radius = randRange(2.5, 5);
    p.color  = color;
    p.life   = randRange(0.28, 0.65);
    p.maxLife = p.life;
    p.alpha  = 1;
  }
}

function spawnHitParticle(x, y) {
  if (gs.particles.active.length >= C.MAX_PARTICLES) return;
  const p = gs.particles.acquire();
  p.x = x; p.y = y;
  p.vx = randRange(-60, 60); p.vy = randRange(-60, 60);
  p.radius = randRange(1.5, 3);
  p.color  = '#cc55ff';
  p.life   = 0.18;
  p.maxLife = 0.18;
  p.alpha  = 1;
}

function spawnLevelUpBurst(x, y) {
  for (let i = 0; i < 24; i++) {
    if (gs.particles.active.length >= C.MAX_PARTICLES) break;
    const a = (i / 24) * Math.PI * 2;
    const s = randRange(120, 280);
    const p = gs.particles.acquire();
    p.x = x; p.y = y;
    p.vx = Math.cos(a)*s; p.vy = Math.sin(a)*s;
    p.radius = randRange(3, 6);
    p.color  = '#ffd700';
    p.life   = randRange(0.5, 1.0);
    p.maxLife = p.life;
    p.alpha  = 1;
  }
}

function updateParticles(dt) {
  for (const p of gs.particles.active) {
    p.x   += p.vx * dt;
    p.y   += p.vy * dt;
    p.vx  *= 0.90;
    p.vy  *= 0.90;
    p.life -= dt;
    p.alpha = Math.max(0, p.life / p.maxLife);
  }
  gs.particles.releaseIf(p => p.life <= 0);
}

function drawParticle(ctx, p) {
  ctx.globalAlpha = p.alpha;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
  ctx.fillStyle = p.color;
  ctx.fill();
}

// ════════════════════════════════════════════════════════
//  9. XP ORBS
// ════════════════════════════════════════════════════════
function makeOrb() {
  return { x:0, y:0, value:0, radius:C.ORB_RADIUS, alive:true };
}

function spawnOrb(x, y, value) {
  if (gs.orbs.active.length >= C.MAX_ORBS) return;
  const o = gs.orbs.acquire();
  o.x = x + randRange(-8,8); o.y = y + randRange(-8,8);
  o.value = value; o.alive = true;
}

function updateOrbs(dt) {
  const player = gs.player;
  for (const o of gs.orbs.active) {
    const d = dist(o.x, o.y, player.x, player.y);
    if (d < C.ORB_ATTRACT_RANGE) {
      const nx = (player.x - o.x) / (d||1);
      const ny = (player.y - o.y) / (d||1);
      o.x += nx * C.ORB_ATTRACT_SPEED * dt;
      o.y += ny * C.ORB_ATTRACT_SPEED * dt;
    }
    const sumR = o.radius + player.radius;
    if (distSq(o.x, o.y, player.x, player.y) < sumR * sumR) {
      player.gainXP(o.value);
      o.alive = false;
      spawnOrbCollectEffect(o.x, o.y);
    }
  }
  gs.orbs.releaseIf(o => !o.alive);
}

function spawnOrbCollectEffect(x, y) {
  for (let i = 0; i < 4; i++) {
    if (gs.particles.active.length >= C.MAX_PARTICLES) break;
    const a = randAngle();
    const p = gs.particles.acquire();
    p.x = x; p.y = y;
    p.vx = Math.cos(a)*60; p.vy = Math.sin(a)*60;
    p.radius = 2.5;
    p.color  = '#ffd700';
    p.life   = 0.22;
    p.maxLife = 0.22;
    p.alpha  = 1;
  }
}

function drawOrb(ctx, o) {
  const pulse = 0.65 + 0.35 * Math.sin(gs.elapsed * 4 + o.x * 0.05);
  ctx.globalAlpha = pulse;
  ctx.beginPath();
  ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd700';
  ctx.shadowBlur  = 10;
  ctx.shadowColor = '#ffd700';
  ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;
}

// ════════════════════════════════════════════════════════
//  10. INPUT MANAGER
// ════════════════════════════════════════════════════════
const InputManager = {
  keys: new Set(),
  joystickDir: { x: 0, y: 0 },

  getDir() {
    let x = 0, y = 0;
    if (this.keys.has('ArrowLeft')  || this.keys.has('a') || this.keys.has('A')) x -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('d') || this.keys.has('D')) x += 1;
    if (this.keys.has('ArrowUp')    || this.keys.has('w') || this.keys.has('W')) y -= 1;
    if (this.keys.has('ArrowDown')  || this.keys.has('s') || this.keys.has('S')) y += 1;
    if (x !== 0 || y !== 0) {
      const len = Math.sqrt(x*x + y*y);
      return { x: x/len, y: y/len };
    }
    return { x: this.joystickDir.x, y: this.joystickDir.y };
  },

  init() {
    window.addEventListener('keydown', e => {
      this.keys.add(e.key);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key));
  }
};

// ════════════════════════════════════════════════════════
//  11. VIRTUAL JOYSTICK
// ════════════════════════════════════════════════════════
const VirtualJoystick = {
  touchId: null,
  baseX: 0, baseY: 0,
  maxR: 48,

  init() {
    const zone = document.getElementById('joystick-zone');
    const base = document.getElementById('joystick-base');
    const knob = document.getElementById('joystick-knob');

    zone.addEventListener('touchstart', e => {
      e.preventDefault();
      if (this.touchId !== null) return;
      const t = e.changedTouches[0];
      this.touchId = t.identifier;
      const rect = zone.getBoundingClientRect();
      this.baseX = t.clientX - rect.left;
      this.baseY = t.clientY - rect.top;
      base.style.left    = (this.baseX - 45) + 'px';
      base.style.top     = (this.baseY - 45) + 'px';
      base.style.opacity = '0.85';
    }, { passive: false });

    zone.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this.touchId) continue;
        const rect = zone.getBoundingClientRect();
        let dx = (t.clientX - rect.left) - this.baseX;
        let dy = (t.clientY - rect.top)  - this.baseY;
        const len = Math.sqrt(dx*dx + dy*dy);
        if (len > this.maxR) { dx = dx/len*this.maxR; dy = dy/len*this.maxR; }
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        InputManager.joystickDir.x = dx / this.maxR;
        InputManager.joystickDir.y = dy / this.maxR;
      }
    }, { passive: false });

    const end = e => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.touchId) continue;
        this.touchId = null;
        knob.style.transform = 'translate(0,0)';
        base.style.opacity   = '0.4';
        InputManager.joystickDir.x = 0;
        InputManager.joystickDir.y = 0;
      }
    };
    zone.addEventListener('touchend',    end, { passive: false });
    zone.addEventListener('touchcancel', end, { passive: false });
  }
};

// ════════════════════════════════════════════════════════
//  12. UPGRADES
// ════════════════════════════════════════════════════════
const UPGRADES = [
  { id:'fire_rate',     name:'Rapid Fire',     desc:'Fire rate +25%',          icon:'⚡',
    apply: p => { p.fireRate *= 1.25; } },
  { id:'damage',        name:'Power Surge',    desc:'Damage +25%',             icon:'💥',
    apply: p => { p.damage  *= 1.25; } },
  { id:'bullet_size',   name:'Big Shot',       desc:'Bullet area +35%',        icon:'🔵',
    apply: p => { p.bulletRadius *= 1.35; } },
  { id:'bullet_count',  name:'Multishot',      desc:'+1 extra bullet',         icon:'🔱',
    apply: p => { p.bulletCount += 1; } },
  { id:'speed',         name:'Swift Boots',    desc:'Move speed +20%',         icon:'👟',
    apply: p => { p.speed   *= 1.20; } },
  { id:'max_hp',        name:'Fortify',        desc:'Max HP +35, restore HP',  icon:'❤️',
    apply: p => { p.maxHp  += 35; p.hp = Math.min(p.hp + 35, p.maxHp); } },
  { id:'shield',        name:'Energy Shield',  desc:'Block 6 dmg per hit',     icon:'🛡️',
    apply: p => { p.shield += 6; } },
  { id:'pierce',        name:'Penetrator',     desc:'Bullets pierce +1 enemy', icon:'🗡️',
    apply: p => { p.pierceCount += 1; } },
];

const UpgradeSystem = {
  show(player) {
    spawnLevelUpBurst(player.x, player.y);
    AudioManager.playLevelUp();
    gs.paused = true;

    const overlay = document.getElementById('levelup-overlay');
    const cards   = document.getElementById('upgrade-cards');
    cards.innerHTML = '';

    const choices = [...UPGRADES].sort(() => Math.random() - 0.5).slice(0, 3);
    choices.forEach(upg => {
      const card = document.createElement('div');
      card.className = 'upgrade-card';
      card.innerHTML = `
        <div class="upgrade-icon">${upg.icon}</div>
        <div>
          <div class="upgrade-name">${upg.name}</div>
          <div class="upgrade-desc">${upg.desc}</div>
        </div>`;
      const select = () => {
        upg.apply(player);
        overlay.classList.add('hidden');
        gs.paused = false;
      };
      card.addEventListener('click',    select);
      card.addEventListener('touchend', e => { e.preventDefault(); select(); }, { passive: false });
      cards.appendChild(card);
    });

    overlay.classList.remove('hidden');
  }
};

// ════════════════════════════════════════════════════════
//  13. SPAWN MANAGER
// ════════════════════════════════════════════════════════
const Spawner = {
  waveT: 0,
  diffT: 0,

  update(dt) {
    this.diffT += dt;
    if (this.diffT >= C.DIFF_INTERVAL) {
      gs.diffLevel++;
      this.diffT = 0;
    }

    this.waveT += dt;
    if (this.waveT >= C.WAVE_INTERVAL) {
      this.waveT = 0;
      this._wave();
    }
  },

  _wave() {
    const d = gs.diffLevel;
    const count = Math.min(8 + d * 5, C.MAX_ENEMIES - gs.enemies.length);
    if (count <= 0) return;

    // tier probability weights
    const w = [
      Math.max(0.15, 0.70 - d * 0.05),
      Math.min(0.35, 0.10 + d * 0.04),
      d > 2 ? Math.min(0.30, (d-2)*0.07) : 0,
      d > 4 ? Math.min(0.20, (d-4)*0.04) : 0,
    ];

    for (let i = 0; i < count; i++) {
      const tier = this._pick(w);
      const pos  = this._offscreen();
      gs.enemies.push(new Enemy(pos.x, pos.y, tier));
    }
  },

  _pick(w) {
    const sum = w.reduce((a,b)=>a+b,0);
    let r = Math.random() * sum;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return 0;
  },

  _offscreen() {
    const px = gs.player.x, py = gs.player.y;
    const cw = gs.canvas.width, ch = gs.canvas.height;
    const m  = 90;
    const edge = randInt(0, 3);
    switch (edge) {
      case 0: return { x: px - cw/2 - m + randRange(0, cw + m*2), y: py - ch/2 - m };
      case 1: return { x: px + cw/2 + m, y: py - ch/2 - m + randRange(0, ch + m*2) };
      case 2: return { x: px - cw/2 - m + randRange(0, cw + m*2), y: py + ch/2 + m };
      case 3: return { x: px - cw/2 - m, y: py - ch/2 - m + randRange(0, ch + m*2) };
    }
  },
};

// ════════════════════════════════════════════════════════
//  14. AUDIO MANAGER (Web Audio API — 完全無料・外部依存ゼロ)
// ════════════════════════════════════════════════════════
const AudioManager = {
  ctx: null,
  master: null,
  bgmGain: null,
  sfxGain: null,
  muted: false,
  _bgmTimer: null,
  _events: null,   // BGMイベントリスト
  _loopLen: 0,     // ループ長（秒）
  _lastKill: 0,    // 連続撃破SFX抑制用

  // AudioContext初期化（初回タップ後に呼ぶ）
  resume() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // マスター → BGM/SFXバス構成
      this.master  = this.ctx.createGain(); this.master.gain.value  = 0.5;
      this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = 0.30;
      this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.65;
      this.bgmGain.connect(this.master);
      this.sfxGain.connect(this.master);
      this.master.connect(this.ctx.destination);
      this._buildBGM();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  // ── BGMシーケンス構築 ──
  // Aマイナーペンタトニック、150BPM、4小節ループ（6.4秒）
  _buildBGM() {
    const BPM = 150;
    const Q = 60 / BPM;   // 4分音符 = 0.400s
    const E = Q / 2;      // 8分音符 = 0.200s
    const S = Q / 4;      // 16分音符 = 0.100s
    const evs = [];
    const add = (t, f, dur, vol, type) => evs.push({ t, f, dur, vol, type });

    // === メロディ（square波）4小節 ===
    // 各小節 = 4Q = 1.6s、計 6.4s
    const mel = [
      // 小節1: Aマイナー上昇フレーズ
      [440,E],[523.25,E],[659.25,E],[587.33,E],
      [523.25,E],[440,E],[392,E],[329.63,E],
      // 小節2: 答えフレーズ
      [440,E],[392,E],[329.63,E],[293.66,E],
      [329.63,Q],[440,Q],
      // 小節3: テンション上昇
      [523.25,E],[587.33,E],[659.25,E],[587.33,E],
      [523.25,E],[440,E],[392,Q],
      // 小節4: 解決・着地
      [329.63,E],[392,E],[440,E],[523.25,E],
      [440,Q],[220,Q],
    ];
    let mt = 0;
    for (const [f, d] of mel) { add(mt, f, d * 0.80, 0.18, 'mel'); mt += d; }
    this._loopLen = mt; // = 6.4s

    // === ベース（sawtooth波）Aマイナーコード進行 ===
    const bas = [
      [110,Q],[164.81,Q],[110,Q],[98,Q],       // Am: A E A G
      [110,Q],[164.81,Q],[130.81,Q],[110,Q],   // Am: A E C A
      [130.81,Q],[98,Q],[130.81,Q],[110,Q],    // C:  C G C A
      [164.81,Q],[110,Q],[146.83,Q],[110,Q],   // Em: E A D A
    ];
    let bt = 0;
    for (const [f, d] of bas) { add(bt, f, d * 0.62, 0.12, 'bas'); bt += d; }

    // === アルペジオ（triangle波）16分音符 ===
    // 各コードを上昇→部分下降パターンで8ステップ × 2 = 1小節
    const chords = [
      [220, 261.63, 329.63, 440],      // Am
      [196, 246.94, 293.66, 392],      // G
      [174.61, 220, 261.63, 349.23],   // F
      [164.81, 196, 246.94, 329.63],   // Em
    ];
    let at = 0;
    for (const ch of chords) {
      const pat = [ch[0],ch[1],ch[2],ch[3],ch[2],ch[1],ch[0],ch[1]];
      for (let rep = 0; rep < 2; rep++) {
        for (const f of pat) { add(at, f, S * 0.52, 0.065, 'arp'); at += S; }
      }
    }

    this._events = evs;
  },

  // 1ループ分のノートをスケジュール登録し、終端で再帰呼び出し
  _scheduleLoop(startTime) {
    if (!this.ctx || !this._events) return;
    for (const ev of this._events) {
      const osc  = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = ev.type === 'mel' ? 'square'
               : ev.type === 'bas' ? 'sawtooth'
               : 'triangle';
      osc.frequency.value = ev.f;
      const at = startTime + ev.t;
      gain.gain.setValueAtTime(0.001, at);
      gain.gain.linearRampToValueAtTime(ev.vol, at + 0.012);
      gain.gain.setValueAtTime(ev.vol, at + ev.dur - 0.02);
      gain.gain.linearRampToValueAtTime(0.001, at + ev.dur);
      osc.connect(gain);
      gain.connect(this.bgmGain);
      osc.start(at);
      osc.stop(at + ev.dur + 0.02);
    }
    // 次ループを 0.5秒前に予約
    const next    = startTime + this._loopLen;
    const waitMs  = Math.max(0, (next - this.ctx.currentTime - 0.5) * 1000);
    this._bgmTimer = setTimeout(() => this._scheduleLoop(next), waitMs);
  },

  startBGM() {
    if (!this.ctx) return;
    if (this._bgmTimer) clearTimeout(this._bgmTimer);
    this._scheduleLoop(this.ctx.currentTime + 0.15);
  },

  stopBGM() {
    if (this._bgmTimer) { clearTimeout(this._bgmTimer); this._bgmTimer = null; }
  },

  // ── SFX: レベルアップ（上昇キラキラ） ──
  playLevelUp() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = now + i * 0.075;
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.30, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g); g.connect(this.sfxGain);
      o.start(t); o.stop(t + 0.5);
    });
    // 高音シマー
    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(1046.5, now + 0.35);
    o2.frequency.exponentialRampToValueAtTime(2093, now + 0.85);
    g2.gain.setValueAtTime(0.18, now + 0.35);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    o2.connect(g2); g2.connect(this.sfxGain);
    o2.start(now + 0.35); o2.stop(now + 0.95);
  },

  // ── SFX: 敵撃破（短くドスン） ──
  playKill() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this._lastKill < 0.06) return; // 連打抑制
    this._lastKill = now;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(380, now);
    o.frequency.exponentialRampToValueAtTime(85, now + 0.13);
    g.gain.setValueAtTime(0.22, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    o.connect(g); g.connect(this.sfxGain);
    o.start(now); o.stop(now + 0.18);
  },

  // ── ミュート切り替え ──
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : 0.5, this.ctx.currentTime, 0.08
      );
    }
    const btn = document.getElementById('mute-btn');
    if (btn) btn.textContent = this.muted ? '🔇' : '🔊';
  },
};

// ════════════════════════════════════════════════════════
//  15. SCREEN SHAKE
// ════════════════════════════════════════════════════════
const shake = { x:0, y:0, timer:0, intensity:0 };

function screenShake(intensity, duration) {
  shake.intensity = Math.max(shake.intensity, intensity);
  shake.timer     = Math.max(shake.timer, duration);
}

function updateShake(dt) {
  if (shake.timer > 0) {
    shake.timer -= dt;
    const mag = shake.intensity * Math.max(0, shake.timer / 0.28);
    shake.x = (Math.random() - 0.5) * 2 * mag;
    shake.y = (Math.random() - 0.5) * 2 * mag;
  } else {
    shake.x = shake.y = shake.intensity = 0;
  }
}

// ════════════════════════════════════════════════════════
//  15. GAME STATE
// ════════════════════════════════════════════════════════
const gs = {
  canvas:       null,
  ctx:          null,
  running:      false,
  paused:       false,
  pendingLevelUp: false,
  lastTime:     0,
  elapsed:      0,
  player:       null,
  enemies:      [],
  bullets:      null,
  particles:    null,
  orbs:         null,
  grid:         null,
  kills:        0,
  diffLevel:    0,
};

// ════════════════════════════════════════════════════════
//  16. GAME LOOP
// ════════════════════════════════════════════════════════
function gameLoop(ts) {
  if (!gs.running) return;
  const dt = Math.min((ts - gs.lastTime) / 1000, 0.05);
  gs.lastTime = ts;

  if (!gs.paused) update(dt);
  render();
  requestAnimationFrame(gameLoop);
}

function update(dt) {
  gs.elapsed += dt;

  const dir = InputManager.getDir();
  gs.player.update(dt, dir, gs.enemies, gs.bullets);

  // rebuild spatial grid
  gs.grid.clear();
  for (const e of gs.enemies) gs.grid.insert(e);

  // update enemies (iterate copy to allow splice inside updateBullets)
  for (let i = gs.enemies.length - 1; i >= 0; i--) {
    gs.enemies[i].update(dt, gs.player);
  }

  // bullets + collision (may splice enemies)
  updateBullets(dt, gs.grid, gs.bullets, gs.canvas);

  // particles / orbs
  updateParticles(dt);
  updateOrbs(dt);

  // spawning
  Spawner.update(dt);

  // shake
  updateShake(dt);

  // level up queue
  if (gs.pendingLevelUp && gs.player.alive) {
    gs.pendingLevelUp = false;
    UpgradeSystem.show(gs.player);
  }

  // game over
  if (!gs.player.alive) triggerGameOver();

  updateHUD();
}

// ════════════════════════════════════════════════════════
//  17. RENDER
// ════════════════════════════════════════════════════════
function render() {
  const { ctx, canvas, player } = gs;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = C.BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  const ox = canvas.width  / 2 - player.x + shake.x;
  const oy = canvas.height / 2 - player.y + shake.y;
  ctx.translate(ox, oy);

  // background grid
  drawGrid(ctx);

  // orbs
  for (const o of gs.orbs.active) drawOrb(ctx, o);

  // enemies
  for (const e of gs.enemies) e.draw(ctx);

  // bullets
  ctx.save();
  for (const b of gs.bullets.active) drawBullet(ctx, b);
  ctx.restore();

  // particles (batched by alpha)
  ctx.save();
  for (const p of gs.particles.active) drawParticle(ctx, p);
  ctx.globalAlpha = 1;
  ctx.restore();

  // player
  gs.player.draw(ctx);

  ctx.restore();
}

function drawGrid(ctx) {
  const spacing = 65;
  const px = gs.player.x, py = gs.player.y;
  const hw = gs.canvas.width  / 2 + spacing;
  const hh = gs.canvas.height / 2 + spacing;
  const sx = Math.floor((px - hw) / spacing) * spacing;
  const sy = Math.floor((py - hh) / spacing) * spacing;

  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let x = sx; x < px + hw; x += spacing) {
    for (let y = sy; y < py + hh; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ════════════════════════════════════════════════════════
//  18. HUD
// ════════════════════════════════════════════════════════
function updateHUD() {
  const p = gs.player;
  document.getElementById('hud-timer').textContent = formatTime(gs.elapsed);
  document.getElementById('hud-level').textContent = `Lv ${p.level}`;
  document.getElementById('hud-kills').textContent = `${gs.kills} kills`;
  document.getElementById('xp-bar').style.width  = (p.xp / p.xpToNext * 100) + '%';
  const hpPct = p.hp / p.maxHp * 100;
  const hpEl  = document.getElementById('hp-bar');
  hpEl.style.width      = hpPct + '%';
  hpEl.style.background = hpPct > 50 ? 'var(--neon-green)' : hpPct > 25 ? '#ffaa00' : 'var(--neon-red)';
  hpEl.style.boxShadow  = `0 0 6px ${hpPct > 50 ? 'var(--neon-green)' : hpPct > 25 ? '#ffaa00' : 'var(--neon-red)'}`;
}

// ════════════════════════════════════════════════════════
//  19. GAME OVER
// ════════════════════════════════════════════════════════
function triggerGameOver() {
  gs.running = false;
  AudioManager.stopBGM();
  document.getElementById('hud').classList.add('hidden');
  const overlay = document.getElementById('gameover-overlay');
  document.getElementById('stats-display').innerHTML = `
    <div class="stat-row"><span class="stat-label">Survived</span><span class="stat-value">${formatTime(gs.elapsed)}</span></div>
    <div class="stat-row"><span class="stat-label">Level</span><span class="stat-value">${gs.player.level}</span></div>
    <div class="stat-row"><span class="stat-label">Kills</span><span class="stat-value">${gs.kills}</span></div>
  `;
  overlay.classList.remove('hidden');
}

// ════════════════════════════════════════════════════════
//  20. INIT
// ════════════════════════════════════════════════════════
function initGame() {
  const canvas = document.getElementById('gameCanvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');

  gs.canvas  = canvas;
  gs.ctx     = ctx;
  gs.player  = new Player(0, 0);
  gs.enemies = [];
  gs.elapsed = 0;
  gs.kills   = 0;
  gs.paused  = false;
  gs.pendingLevelUp = false;
  gs.running = true;
  gs.lastTime = performance.now();
  gs.diffLevel = 0;

  gs.bullets   = new ObjectPool(makeBullet,   C.MAX_BULLETS);
  gs.particles = new ObjectPool(makeParticle, C.MAX_PARTICLES);
  gs.orbs      = new ObjectPool(makeOrb,      C.MAX_ORBS);
  gs.grid      = new SpatialHashGrid(C.CELL_SIZE);

  Spawner.waveT = 2;   // first wave at 2s
  Spawner.diffT = 0;

  // reset shake
  shake.x = shake.y = shake.timer = shake.intensity = 0;

  document.getElementById('gameover-overlay').classList.add('hidden');
  document.getElementById('levelup-overlay').classList.add('hidden');
  document.getElementById('start-overlay').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');

  AudioManager.stopBGM();
  AudioManager.startBGM();

  requestAnimationFrame(ts => { gs.lastTime = ts; requestAnimationFrame(gameLoop); });
}

// ════════════════════════════════════════════════════════
//  21. EVENT LISTENERS & BOOT
// ════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  InputManager.init();
  VirtualJoystick.init();

  document.getElementById('start-btn').addEventListener('click', () => {
    AudioManager.resume(); // 初タップでAudioContext起動（モバイル対応）
    initGame();
  });
  document.getElementById('restart-btn').addEventListener('click', () => {
    AudioManager.resume();
    initGame();
  });
  document.getElementById('mute-btn').addEventListener('click', () => {
    AudioManager.resume();
    AudioManager.toggleMute();
  });

  // resize
  window.addEventListener('resize', () => {
    if (gs.canvas) {
      gs.canvas.width  = window.innerWidth;
      gs.canvas.height = window.innerHeight;
    }
  });

  // prevent context menu on long press (mobile)
  document.addEventListener('contextmenu', e => e.preventDefault());
});
