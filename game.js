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
//  6b. BOSS
// ════════════════════════════════════════════════════════

function _drawBoss(ctx, x, y, r, flash) {
  const t = Date.now() * 0.002;
  ctx.save();

  // 禍々しいオーラ
  if (!flash) {
    ctx.shadowBlur = 32; ctx.shadowColor = '#cc0022';
    for (let i = 0; i < 8; i++) {
      const a  = (i/8)*Math.PI*2 + t*0.6;
      const fl = 0.5 + 0.5*Math.sin(t*3 + i*1.3);
      ctx.fillStyle = `rgba(200,0,30,${0.16*fl})`;
      ctx.beginPath();
      ctx.ellipse(x+Math.cos(a)*r*0.92, y+Math.sin(a)*r*0.82, r*0.28, r*0.18, a, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // 本体
  ctx.fillStyle = flash ? '#ffffff' : '#1a0008';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  if (flash) { ctx.restore(); return; }

  // 大きな湾曲ツノ（左右）
  ctx.strokeStyle = '#cc2244'; ctx.lineWidth = r*0.18; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x-r*0.45, y-r*0.62);
  ctx.bezierCurveTo(x-r*1.2, y-r*1.1, x-r*1.5, y-r*1.8, x-r*0.85, y-r*2.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.45, y-r*0.62);
  ctx.bezierCurveTo(x+r*1.2, y-r*1.1, x+r*1.5, y-r*1.8, x+r*0.85, y-r*2.2); ctx.stroke();
  ctx.fillStyle = '#ff3355';
  ctx.beginPath(); ctx.arc(x-r*0.85, y-r*2.2, r*0.1, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x+r*0.85, y-r*2.2, r*0.1, 0, Math.PI*2); ctx.fill();

  // ひび割れ模様
  ctx.strokeStyle = 'rgba(200,20,40,0.38)'; ctx.lineWidth = r*0.07;
  ctx.beginPath(); ctx.moveTo(x-r*0.6,y-r*0.5); ctx.lineTo(x-r*0.1,y+r*0.1); ctx.lineTo(x+r*0.3,y-r*0.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.5,y-r*0.4); ctx.lineTo(x+r*0.7,y+r*0.3); ctx.stroke();

  // 3つの目（中央+左右）
  ctx.shadowBlur = 14; ctx.shadowColor = '#ff0000';
  ctx.fillStyle = '#ff1133';
  ctx.beginPath(); ctx.ellipse(x, y-r*0.28, r*0.13, r*0.09, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x-r*0.38, y-r*0.08, r*0.20, r*0.14, -0.2, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x+r*0.38, y-r*0.08, r*0.20, r*0.14,  0.2, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.ellipse(x-r*0.38, y-r*0.08, r*0.05, r*0.13, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x+r*0.38, y-r*0.08, r*0.05, r*0.13, 0, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;

  // 怒り眉
  ctx.strokeStyle = '#cc0022'; ctx.lineWidth = r*0.18; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x-r*0.62, y-r*0.32); ctx.lineTo(x-r*0.20, y-r*0.42); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+r*0.62, y-r*0.32); ctx.lineTo(x+r*0.20, y-r*0.42); ctx.stroke();

  // 牙をむいた口
  ctx.strokeStyle = '#cc0022'; ctx.lineWidth = r*0.12;
  ctx.beginPath();
  ctx.moveTo(x-r*0.55, y+r*0.28);
  ctx.bezierCurveTo(x-r*0.2, y+r*0.56, x+r*0.2, y+r*0.56, x+r*0.55, y+r*0.28);
  ctx.stroke();
  ctx.fillStyle = '#ffdddd';
  [[x-r*0.38,y+r*0.30],[x-r*0.18,y+r*0.34],[x+r*0.18,y+r*0.34],[x+r*0.38,y+r*0.30]].forEach(([fx,fy]) => {
    ctx.beginPath(); ctx.moveTo(fx-r*0.06,fy); ctx.lineTo(fx,fy+r*0.18); ctx.lineTo(fx+r*0.06,fy); ctx.fill();
  });

  // 名前タグ（ボス頭上）
  ctx.shadowBlur = 8; ctx.shadowColor = '#ff0022';
  ctx.fillStyle = '#ff4455';
  ctx.font = `bold ${Math.round(r*0.44)}px 'Courier New'`;
  ctx.textAlign = 'center';
  ctx.fillText('DARK LORD', x, y - r*2.55);
  ctx.shadowBlur = 0;
  ctx.restore();
}

class Boss {
  constructor(x, y, hpMult = 1) {
    this.x           = x;
    this.y           = y;
    this.isBoss      = true;
    this.tier        = -1;
    this.radius      = 34;
    this.maxHp       = (320 + gs.diffLevel * 90) * hpMult;
    this.hp          = this.maxHp;
    this.speed       = 50 + gs.diffLevel * 3;
    this.damage      = 25;
    this.xpVal       = 20;
    this.color       = '#ff2244';
    this.glow        = '#ff0000';
    this.alive       = true;
    this.flashT      = 0;
    this.angle       = 0;
    this.contactCool = 0;
    // 遠距離攻撃（槍）
    this.spearTimer    = 1.8;  // 最初の発射まで少し待つ
    this.spearInterval = 2.4;
    this.spears        = [];
  }

  _fireSpear(player) {
    const dx = player.x - this.x, dy = player.y - this.y;
    const d  = Math.sqrt(dx*dx + dy*dy) || 1;
    const spd = 230;
    this.spears.push({
      x: this.x, y: this.y,
      vx: dx/d * spd, vy: dy/d * spd,
      angle: Math.atan2(dy, dx),
      damage: 14,
      hit: false,
      life: 3.5,
    });
  }

  update(dt, player) {
    const dx = player.x - this.x;
    const dy = player.y - this.y;
    const d  = Math.sqrt(dx*dx + dy*dy) || 1;
    this.angle = Math.atan2(dy, dx);
    this.x += (dx/d) * this.speed * dt;
    this.y += (dy/d) * this.speed * dt;
    if (this.flashT      > 0) this.flashT      -= dt;
    if (this.contactCool > 0) this.contactCool -= dt;

    // 接触ダメージ
    if (d < this.radius + player.radius && this.contactCool <= 0) {
      player.takeDamage(this.damage);
      this.contactCool = 0.9;
    }

    // 遠距離攻撃
    this.spearTimer -= dt;
    if (this.spearTimer <= 0) {
      this.spearTimer = this.spearInterval;
      this._fireSpear(player);
    }

    // 槍の移動と命中判定
    for (let i = this.spears.length - 1; i >= 0; i--) {
      const s = this.spears[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      if (!s.hit && distSq(s.x, s.y, player.x, player.y) < (9 + player.radius) ** 2) {
        player.takeDamage(s.damage);
        s.hit  = true;
        s.life = 0;
        spawnHitParticle(s.x, s.y);
      }
      if (s.life <= 0) this.spears.splice(i, 1);
    }
  }

  takeDamage(amount) {
    this.hp -= amount;
    this.flashT = 0.1;
    if (this.hp <= 0) this.alive = false;
  }

  draw(ctx) {
    // 槍を先に描画（プレイヤーの下に来ないよう）
    for (const s of this.spears) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.angle);
      ctx.shadowBlur = 14; ctx.shadowColor = '#ff5500';
      // 柄（暗い赤茶）
      ctx.fillStyle = '#7a2200';
      ctx.beginPath(); ctx.roundRect(-20, -2.8, 28, 5.6, 2); ctx.fill();
      // 穂先（明るいオレンジ三角）
      ctx.fillStyle = '#ff7722';
      ctx.shadowBlur = 20; ctx.shadowColor = '#ff6600';
      ctx.beginPath();
      ctx.moveTo(8, -5); ctx.lineTo(24, 0); ctx.lineTo(8, 5);
      ctx.closePath(); ctx.fill();
      // ハイライト
      ctx.fillStyle = '#ffcc88';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(11, -2.5); ctx.lineTo(20, 0); ctx.lineTo(13, 1.5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    _drawBoss(ctx, this.x, this.y, this.radius, this.flashT > 0);

    // 頭上のHPバー（常時表示）
    const bw = this.radius * 3.8, bh = 7;
    const bx = this.x - bw/2, by = this.y - this.radius - 18;
    const pct = this.hp / this.maxHp;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx-1, by-1, bw+2, bh+2);
    ctx.fillStyle = pct > 0.5 ? '#ff3344' : pct > 0.25 ? '#ff8800' : '#ffee00';
    ctx.fillRect(bx, by, bw*pct, bh);
    ctx.strokeStyle = '#ff2244'; ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.restore();
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
        if (b.pierce <= 0) { b.alive = false; break; }
        b.pierce--;
      }
    }
  }
  bulletPool.releaseIf(b => !b.alive);
}

// 毎フレーム末に1回だけ呼ぶ — 複数武器による二重処理を防ぐ
function cleanDeadEnemies() {
  for (let i = gs.enemies.length - 1; i >= 0; i--) {
    if (!gs.enemies[i].alive) {
      const e = gs.enemies[i];
      spawnDeathParticles(e.x, e.y, e.color);
      spawnOrb(e.x, e.y, e.xpVal);
      gs.kills++;
      AudioManager.playKill();
      if (e.isBoss) BossSystem.onBossDied(e.x, e.y);
      gs.enemies.splice(i, 1);
    }
  }
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
  { id:'fire_rate',     name:'速射',         desc:'連射速度 +25%',           icon:'⚡',
    apply: p => { p.fireRate *= 1.25; } },
  { id:'damage',        name:'攻撃強化',     desc:'攻撃力 +25%',             icon:'💥',
    apply: p => { p.damage  *= 1.25; } },
  { id:'bullet_size',   name:'大弾',         desc:'弾の大きさ +35%',         icon:'🔵',
    apply: p => { p.bulletRadius *= 1.35; } },
  { id:'bullet_count',  name:'多重射撃',     desc:'弾数 +1',                 icon:'🔱',
    apply: p => { p.bulletCount += 1; } },
  { id:'speed',         name:'俊足',         desc:'移動速度 +20%',           icon:'👟',
    apply: p => { p.speed   *= 1.20; } },
  { id:'max_hp',        name:'体力強化',     desc:'最大HP +35・HP回復',      icon:'❤️',
    apply: p => { p.maxHp  += 35; p.hp = Math.min(p.hp + 35, p.maxHp); } },
  { id:'shield',        name:'魔法の盾',     desc:'被ダメージ -6/hit',       icon:'🛡️',
    apply: p => { p.shield += 6; } },
  { id:'pierce',        name:'貫通弾',       desc:'弾が敵を +1 貫通する',    icon:'🗡️',
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
    // ボス出現後10秒は通常敵を最大2体に抑える
    const bossQuiet = gs.elapsed < BossSystem.quietUntil;
    if (bossQuiet) return; // ボス出現直後はスポーンしない
    const base  = gs.elapsed < 30 ? 4 : 8 + d * 5; // 最初の30秒は半分
    const count = Math.min(base, C.MAX_ENEMIES - gs.enemies.length);
    if (count <= 0) return;

    // 1分ごとにフェーズが進み、dominant tierが切り替わる
    // 列: [スライム, シャドウフード, ゴーレム, ダークメイジ]
    const PHASE_WEIGHTS = [
      [0.85, 0.15, 0.00, 0.00],  // 0–1分
      [0.45, 0.48, 0.07, 0.00],  // 1–2分
      [0.10, 0.50, 0.33, 0.07],  // 2–3分
      [0.00, 0.22, 0.50, 0.28],  // 3–4分
      [0.00, 0.08, 0.40, 0.52],  // 4分以降
    ];
    const mins    = gs.elapsed / 60;
    const phase   = Math.floor(mins);
    const progress = mins - phase;
    const cur  = PHASE_WEIGHTS[Math.min(phase,   PHASE_WEIGHTS.length - 1)];
    const next = PHASE_WEIGHTS[Math.min(phase+1, PHASE_WEIGHTS.length - 1)];
    // フェーズ間をなめらかに補間
    const w = cur.map((v, i) => v + (next[i] - v) * progress);

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
//  14. WEAPON SYSTEM
// ════════════════════════════════════════════════════════

// ── 武器①: オーブ（プレイヤーを周回する光球）──
class WeaponOrbit {
  constructor() {
    this.type    = 'orbit';
    this.level   = 1;
    this.count   = 2;
    this.orbitR  = 90;
    this.damage  = 14;
    this.speed   = 2.2;   // rad/s
    this.angle   = 0;
    this.cools   = new Map(); // 敵ごとのダメージクールダウン
  }

  levelUp() {
    this.level++;
    this.count++;
    this.damage  = Math.round(this.damage * 1.2);
    this.orbitR += 12;
  }

  update(dt, player, enemies) {
    this.angle += this.speed * dt;
    // クールダウン更新
    for (const [k, v] of this.cools) {
      if (v <= 0) this.cools.delete(k); else this.cools.set(k, v - dt);
    }
    for (let i = 0; i < this.count; i++) {
      const a  = this.angle + (i / this.count) * Math.PI * 2;
      const ox = player.x + Math.cos(a) * this.orbitR;
      const oy = player.y + Math.sin(a) * this.orbitR;
      for (const e of enemies) {
        if (!e.alive || this.cools.has(e)) continue;
        if (distSq(ox, oy, e.x, e.y) < (9 + e.radius) ** 2) {
          e.takeDamage(this.damage);
          this.cools.set(e, 0.45);
          spawnHitParticle(ox, oy);
        }
      }
    }
  }

  draw(ctx, player) {
    const t = Date.now() * 0.001;
    for (let i = 0; i < this.count; i++) {
      const a  = this.angle + (i / this.count) * Math.PI * 2;
      const ox = player.x + Math.cos(a) * this.orbitR;
      const oy = player.y + Math.sin(a) * this.orbitR;
      // 軌道リング（薄く）
      if (i === 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(player.x, player.y, this.orbitR, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,200,50,0.12)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
      // オーブ本体
      ctx.save();
      ctx.shadowBlur = 16; ctx.shadowColor = '#ffcc00';
      ctx.fillStyle = '#ffe040';
      ctx.beginPath(); ctx.arc(ox, oy, 9, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#fff8b0';
      ctx.beginPath(); ctx.arc(ox - 2.5, oy - 2.5, 4, 0, Math.PI*2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }
}

// ── 武器②: 衝撃波（定期的な全周爆発）──
class WeaponShockwave {
  constructor() {
    this.type     = 'shockwave';
    this.level    = 1;
    this.interval = 4.2;
    this.timer    = 3.0;
    this.blastR   = 85;
    this.damage   = 32;
    this.waves    = [];  // [{r, alpha}] 視覚エフェクト用
  }

  levelUp() {
    this.level++;
    this.interval = Math.max(2.0, this.interval * 0.82);
    this.blastR  += 22;
    this.damage   = Math.round(this.damage * 1.25);
  }

  update(dt, player, enemies) {
    this.timer -= dt;
    for (const w of this.waves) { w.r += dt * 220; w.alpha -= dt * 2.2; }
    this.waves = this.waves.filter(w => w.alpha > 0);

    if (this.timer <= 0) {
      this.timer = this.interval;
      this.waves.push({ r: 8, alpha: 1.0 });
      screenShake(6, 0.22);
      for (const e of enemies) {
        if (!e.alive) continue;
        if (distSq(player.x, player.y, e.x, e.y) < this.blastR ** 2) {
          e.takeDamage(this.damage);
          spawnHitParticle(e.x, e.y);
        }
      }
    }
  }

  draw(ctx, player) {
    for (const w of this.waves) {
      ctx.save();
      ctx.globalAlpha = w.alpha * 0.75;
      ctx.strokeStyle = '#bb55ff';
      ctx.lineWidth   = 3.5;
      ctx.shadowBlur  = 18; ctx.shadowColor = '#aa00ff';
      ctx.beginPath(); ctx.arc(player.x, player.y, w.r, 0, Math.PI*2); ctx.stroke();
      // 外側の細いリング
      ctx.globalAlpha = w.alpha * 0.35;
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.arc(player.x, player.y, w.r + 5, 0, Math.PI*2); ctx.stroke();
      ctx.restore();
    }
  }
}

// ── 武器③: ブーメラン（敵を追跡して戻ってくる）──
class WeaponBoomerang {
  constructor() {
    this.type     = 'boomerang';
    this.level    = 1;
    this.interval = 2.8;
    this.timer    = 1.5;
    this.damage   = 38;
    this.speed    = 310;
    this.active   = [];
  }

  levelUp() {
    this.level++;
    this.interval = Math.max(1.2, this.interval * 0.82);
    this.damage   = Math.round(this.damage * 1.25);
  }

  _nearest(player, enemies) {
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      const d = distSq(player.x, player.y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  update(dt, player, enemies) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.interval;
      const tgt = this._nearest(player, enemies);
      if (tgt) {
        const dx = tgt.x - player.x, dy = tgt.y - player.y;
        const d  = Math.sqrt(dx*dx + dy*dy) || 1;
        this.active.push({
          x: player.x, y: player.y,
          vx: dx/d * this.speed, vy: dy/d * this.speed,
          phase: 'out',
          maxD: Math.min(d + 40, 260),
          dist: 0,
          spin: 0,
          hitSet: new Set(),
        });
      }
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.spin += dt * 8;
      if (b.phase === 'out') {
        b.x += b.vx * dt; b.y += b.vy * dt;
        b.dist += this.speed * dt;
        if (b.dist >= b.maxD) b.phase = 'return';
      } else {
        const dx = player.x - b.x, dy = player.y - b.y;
        const d  = Math.sqrt(dx*dx + dy*dy) || 1;
        b.x += dx/d * this.speed * 1.2 * dt;
        b.y += dy/d * this.speed * 1.2 * dt;
        if (d < 18) { this.active.splice(i, 1); continue; }
      }
      // 衝突判定
      for (const e of enemies) {
        if (!e.alive || b.hitSet.has(e)) continue;
        if (distSq(b.x, b.y, e.x, e.y) < (11 + e.radius) ** 2) {
          e.takeDamage(this.damage);
          b.hitSet.add(e);
          spawnHitParticle(b.x, b.y);
        }
      }
    }
  }

  draw(ctx) {
    for (const b of this.active) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.spin);
      ctx.shadowBlur  = 16; ctx.shadowColor = b.phase === 'out' ? '#44ffcc' : '#ff9944';
      // 三日月形
      ctx.fillStyle = b.phase === 'out' ? '#44ffcc' : '#ffaa44';
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0.3, Math.PI - 0.3);
      ctx.arc(0, 0, 5, Math.PI - 0.3, 0.3, true);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }
}

// ── WeaponManager ──
const WeaponManager = {
  weapons: [],

  has(type)  { return this.weapons.some(w => w.type === type); },
  get(type)  { return this.weapons.find(w => w.type === type); },

  add(type) {
    if (this.has(type)) {
      this.get(type).levelUp();
    } else {
      switch(type) {
        case 'orbit':     this.weapons.push(new WeaponOrbit());     break;
        case 'shockwave': this.weapons.push(new WeaponShockwave()); break;
        case 'boomerang': this.weapons.push(new WeaponBoomerang()); break;
      }
    }
  },

  update(dt, player, enemies) {
    for (const w of this.weapons) w.update(dt, player, enemies);
  },

  draw(ctx, player) {
    for (const w of this.weapons) w.draw(ctx, player);
  },

  reset() { this.weapons = []; },
};

// ════════════════════════════════════════════════════════
//  15. TREASURE CHEST SYSTEM
// ════════════════════════════════════════════════════════

function drawChest(ctx, x, y) {
  const t = Date.now() * 0.003;
  ctx.save();
  ctx.shadowBlur = 18 + 6 * Math.sin(t); ctx.shadowColor = '#ffd700';
  // 胴体
  ctx.fillStyle = '#6b3a1f';
  ctx.beginPath(); ctx.roundRect(x - 15, y - 7, 30, 18, 3); ctx.fill();
  // 蓋
  ctx.fillStyle = '#8b4a2b';
  ctx.beginPath(); ctx.roundRect(x - 15, y - 16, 30, 10, [3,3,0,0]); ctx.fill();
  // 金の縁取り
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1.8;
  ctx.strokeRect(x - 15, y - 16, 30, 28);
  ctx.beginPath(); ctx.moveTo(x - 15, y - 7); ctx.lineTo(x + 15, y - 7); ctx.stroke();
  // 鍵穴
  ctx.fillStyle = '#ffd700';
  ctx.beginPath(); ctx.arc(x, y + 2, 4, 0, Math.PI*2); ctx.fill();
  ctx.fillRect(x - 2, y + 2, 4, 5);
  // キラキラ
  const sparkles = [[x+18, y-18], [x-20, y-14], [x+14, y+14]];
  for (const [sx, sy] of sparkles) {
    const p = 0.5 + 0.5 * Math.sin(t * 2 + sx);
    ctx.globalAlpha = p;
    ctx.fillStyle = '#fffaaa';
    ctx.beginPath();
    ctx.moveTo(sx, sy-4); ctx.lineTo(sx+1, sy-1); ctx.lineTo(sx+4, sy);
    ctx.lineTo(sx+1, sy+1); ctx.lineTo(sx, sy+4); ctx.lineTo(sx-1, sy+1);
    ctx.lineTo(sx-4, sy); ctx.lineTo(sx-1, sy-1);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  ctx.restore();
}

const CHEST_REWARDS = [
  { id:'orbit',     name:'オーブ召喚',    desc:'回転する光球が敵を攻撃する\n（取得済みの場合はレベルアップ）', icon:'🌟',
    apply: () => WeaponManager.add('orbit') },
  { id:'shockwave', name:'衝撃波',        desc:'一定時間ごとに全周爆発\n（取得済みの場合はレベルアップ）', icon:'💫',
    apply: () => WeaponManager.add('shockwave') },
  { id:'boomerang', name:'ブーメラン',    desc:'敵を追跡して戻ってくる弾\n（取得済みの場合はレベルアップ）', icon:'🌀',
    apply: () => WeaponManager.add('boomerang') },
  { id:'full_heal', name:'聖なる癒し',    desc:'HPを全回復する',              icon:'💖',
    apply: p => { p.hp = p.maxHp; } },
  { id:'big_dmg',   name:'魔力覚醒',      desc:'全攻撃力 +60%',              icon:'⚡',
    apply: p => { p.damage *= 1.6; } },
  { id:'storm',     name:'弾丸嵐',        desc:'弾数 +2・連射速度 +20%',     icon:'🔱',
    apply: p => { p.bulletCount += 2; p.fireRate *= 1.2; } },
];

function showChestOverlay(player) {
  const overlay = document.getElementById('chest-overlay');
  const cards   = document.getElementById('chest-cards');
  cards.innerHTML = '';

  // 未取得の武器を優先して3択に並べる
  const weapons = CHEST_REWARDS.slice(0, 3);
  const others  = CHEST_REWARDS.slice(3);
  const pool    = [...weapons, ...others].sort(() => Math.random() - 0.5).slice(0, 3);

  pool.forEach(reward => {
    const owned = (reward.id === 'orbit' || reward.id === 'shockwave' || reward.id === 'boomerang')
                  && WeaponManager.has(reward.id);
    const card = document.createElement('div');
    card.className = 'upgrade-card chest-card';
    card.innerHTML = `
      <div class="upgrade-icon">${reward.icon}</div>
      <div>
        <div class="upgrade-name">${reward.name}${owned ? ' <span class="lv-badge">Lv UP</span>' : ''}</div>
        <div class="upgrade-desc">${reward.desc}</div>
      </div>`;
    const select = () => {
      reward.apply(player);
      overlay.classList.add('hidden');
      gs.paused = false;
    };
    card.addEventListener('click', select);
    card.addEventListener('touchend', e => { e.preventDefault(); select(); }, { passive: false });
    cards.appendChild(card);
  });

  overlay.classList.remove('hidden');
}

const ChestSystem = {
  chests:   [],
  timer:    18,     // 最初の宝箱
  interval: 22,     // 以降の間隔

  update(dt, player) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.interval;
      const a = randAngle();
      const d = 180 + randRange(0, 120);
      this.chests.push({ x: player.x + Math.cos(a)*d, y: player.y + Math.sin(a)*d });
    }
    for (let i = this.chests.length - 1; i >= 0; i--) {
      const c = this.chests[i];
      if (distSq(player.x, player.y, c.x, c.y) < (22 + player.radius) ** 2) {
        this.chests.splice(i, 1);
        // 金色パーティクルバースト
        for (let j = 0; j < 22; j++) {
          if (gs.particles.active.length >= C.MAX_PARTICLES) break;
          const a2 = randAngle(), sp = randRange(90, 240);
          const p = gs.particles.acquire();
          p.x=c.x; p.y=c.y; p.vx=Math.cos(a2)*sp; p.vy=Math.sin(a2)*sp;
          p.radius=randRange(3,6); p.color='#ffd700';
          p.life=randRange(0.4,0.9); p.maxLife=p.life; p.alpha=1;
        }
        screenShake(9, 0.32);
        gs.pendingChest = true;
        gs.paused = true;
        showChestOverlay(player);
      }
    }
  },

  draw(ctx) {
    const t = Date.now() * 0.003;
    for (const c of this.chests) {
      drawChest(ctx, c.x, c.y + Math.sin(t + c.x * 0.01) * 3.5);
    }
  },

  reset() { this.chests = []; this.timer = 18; },
};

// ════════════════════════════════════════════════════════
//  15b. BOSS SYSTEM
// ════════════════════════════════════════════════════════
const BossSystem = {
  nextBossAt:   30,   // 最初は30秒後
  interval:     60,   // 以降1分おき
  announcement: 0,    // 演出の残り秒数
  bossCount:    0,    // 何体目か（2体目以降はHP強化）

  update(dt) {
    if (!gs.running || gs.paused) return;
    if (gs.elapsed >= this.nextBossAt && !gs.enemies.some(e => e.isBoss)) {
      this._spawn();
    }
    if (this.announcement > 0) this.announcement -= dt;
  },

  _spawn() {
    // 通常の敵を全消去（パーティクルだけ残す）
    for (let i = gs.enemies.length - 1; i >= 0; i--) {
      const e = gs.enemies[i];
      if (!e.isBoss) {
        spawnDeathParticles(e.x, e.y, e.color);
        gs.enemies.splice(i, 1);
      }
    }
    // ボスをプレイヤーから320px離れた場所にスポーン
    this.bossCount++;
    const hpMult = Math.pow(3, this.bossCount - 1); // 1体目×1, 2体目×3, 3体目×9...
    const a = randAngle();
    gs.enemies.push(new Boss(
      gs.player.x + Math.cos(a) * 320,
      gs.player.y + Math.sin(a) * 320,
      hpMult
    ));
    this.announcement = 2.8;
    this.quietUntil   = gs.elapsed + 3; // ボス出現後3秒は通常敵をスポーンしない
    screenShake(18, 0.7);
    AudioManager.playBossAlert();
    this.nextBossAt = Infinity; // 倒したあとに再設定
  },

  onBossDied(bx, by) {
    // 大量XPオーブドロップ
    for (let i = 0; i < 10; i++) {
      spawnOrb(bx + randRange(-40,40), by + randRange(-40,40), 2);
    }
    screenShake(14, 0.55);
    this.nextBossAt = gs.elapsed + this.interval;
  },

  // 画面固定のボスHPバー（ワールド変換の外で描く）
  drawHUD(canvas, ctx) {
    const boss = gs.enemies.find(e => e.isBoss);
    if (!boss) return;
    const bw = Math.min(canvas.width * 0.52, 380);
    const bh = 13;
    const bx = (canvas.width - bw) / 2;
    const by = 56;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(bx-2, by-18, bw+4, bh+22);
    ctx.shadowBlur = 8; ctx.shadowColor = '#ff0022';
    ctx.fillStyle = '#ff4455';
    ctx.font = 'bold 11px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('⚠  DARK LORD  ⚠', canvas.width/2, by-5);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(60,0,10,0.9)';
    ctx.fillRect(bx, by, bw, bh);
    const pct = boss.hp / boss.maxHp;
    ctx.fillStyle = pct > 0.5 ? '#ff3344' : pct > 0.25 ? '#ff8800' : '#ffee00';
    ctx.shadowBlur = 5; ctx.shadowColor = ctx.fillStyle;
    ctx.fillRect(bx, by, bw*pct, bh);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ff2244'; ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.restore();
  },

  // ボス出現テロップ
  drawAnnouncement(canvas, ctx) {
    if (this.announcement <= 0) return;
    const fade  = this.announcement < 0.5 ? this.announcement / 0.5 : 1;
    const scale = 1 + (1 - Math.min(1, this.announcement/2.8)) * 0.10;
    ctx.save();
    ctx.fillStyle = `rgba(160,0,20,${fade*0.22})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = fade;
    ctx.translate(canvas.width/2, canvas.height/2);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.shadowBlur  = 40; ctx.shadowColor = '#ff0022';
    ctx.fillStyle   = '#ff1133';
    ctx.font = `bold ${Math.round(Math.min(canvas.width*0.09, 60))}px 'Courier New'`;
    ctx.fillText('⚠ BOSS APPEARS ⚠', 0, -28);
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = 'rgba(255,190,190,0.88)';
    ctx.font = `${Math.round(Math.min(canvas.width*0.040, 20))}px 'Courier New'`;
    ctx.fillText('敵が全滅した… ボスが現れた！', 0, 24);
    ctx.restore();
  },

  reset() {
    this.nextBossAt   = 30;
    this.announcement = 0;
    this.quietUntil   = 0;
    this.bossCount    = 0;
  },
};

// ════════════════════════════════════════════════════════
//  16. AUDIO MANAGER (Web Audio API — 完全無料・外部依存ゼロ)
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
    // 旧 bgmGain を master から切り離し、新しいノードを作る
    // （旧ノードに接続済みの oscillator は無音になる）
    if (this.bgmGain) this.bgmGain.disconnect();
    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = this.muted ? 0 : 0.30;
    this.bgmGain.connect(this.master);
    this._scheduleLoop(this.ctx.currentTime + 0.15);
  },

  stopBGM() {
    if (this._bgmTimer) { clearTimeout(this._bgmTimer); this._bgmTimer = null; }
    // master から切り離して即座に無音化��null にしない）
    if (this.bgmGain) this.bgmGain.disconnect();
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

  // ── SFX: ボス出現（重低音 + 上昇警報 + 余韻） ──
  playBossAlert() {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    // 重低音ドスン
    const o1 = ctx.createOscillator(), g1 = ctx.createGain();
    o1.type = 'sawtooth'; o1.frequency.value = 50;
    g1.gain.setValueAtTime(0.45, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now+1.4);
    o1.connect(g1); g1.connect(this.sfxGain);
    o1.start(now); o1.stop(now+1.5);
    // 上昇警報音
    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o2.type = 'square';
    o2.frequency.setValueAtTime(100, now+0.15);
    o2.frequency.exponentialRampToValueAtTime(440, now+0.7);
    g2.gain.setValueAtTime(0.001, now+0.15);
    g2.gain.linearRampToValueAtTime(0.28, now+0.35);
    g2.gain.exponentialRampToValueAtTime(0.001, now+0.9);
    o2.connect(g2); g2.connect(this.sfxGain);
    o2.start(now+0.15); o2.stop(now+1.0);
    // 余韻・高音キーン
    const o3 = ctx.createOscillator(), g3 = ctx.createGain();
    o3.type = 'sine'; o3.frequency.value = 880;
    g3.gain.setValueAtTime(0.12, now+0.6);
    g3.gain.exponentialRampToValueAtTime(0.001, now+1.6);
    o3.connect(g3); g3.connect(this.sfxGain);
    o3.start(now+0.6); o3.stop(now+1.7);
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
  pendingChest: false,
  playerName:   '',
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

  // bullets + collision (may mark enemies dead)
  updateBullets(dt, gs.grid, gs.bullets, gs.canvas);

  // extra weapons
  WeaponManager.update(dt, gs.player, gs.enemies);

  // remove dead enemies (centralized, after all weapons)
  cleanDeadEnemies();

  // boss system
  BossSystem.update(dt);

  // chest system
  ChestSystem.update(dt, gs.player);

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

  // world decorations（移動実感用の背景オブジェクト）
  drawDecorations(ctx);

  // orbs
  for (const o of gs.orbs.active) drawOrb(ctx, o);

  // chests (behind enemies)
  ChestSystem.draw(ctx);

  // enemies
  for (const e of gs.enemies) e.draw(ctx);

  // bullets
  ctx.save();
  for (const b of gs.bullets.active) drawBullet(ctx, b);
  ctx.restore();

  // extra weapons (orbit orbs, shockwave rings, boomerangs)
  WeaponManager.draw(ctx, gs.player);

  // particles (batched by alpha)
  ctx.save();
  for (const p of gs.particles.active) drawParticle(ctx, p);
  ctx.globalAlpha = 1;
  ctx.restore();

  // player
  gs.player.draw(ctx);

  ctx.restore();

  // ── 画面固定のHUD・演出（ワールド変換の外）──
  BossSystem.drawHUD(canvas, ctx);
  BossSystem.drawAnnouncement(canvas, ctx);
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

function drawDecorations(ctx) {
  const CELL = 210;
  const px = gs.player.x, py = gs.player.y;
  const hw = gs.canvas.width  / 2 + CELL * 1.5;
  const hh = gs.canvas.height / 2 + CELL * 1.5;
  const cx0 = Math.floor((px - hw) / CELL);
  const cx1 = Math.ceil ((px + hw) / CELL);
  const cy0 = Math.floor((py - hh) / CELL);
  const cy1 = Math.ceil ((py + hh) / CELL);

  ctx.save();

  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      // セル座標から決定論的な乱数列を生成
      let s = (Math.imul(cx, 0x9e3779) ^ Math.imul(cy, 0x85ebca)) >>> 0;
      const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };

      if (rng() < 0.28) continue; // ~28% のセルはスキップ

      const wx   = cx * CELL + rng() * CELL;
      const wy   = cy * CELL + rng() * CELL;
      const type = Math.floor(rng() * 3);
      const a    = 0.07 + rng() * 0.07;
      const r    = 7   + rng() * 11;

      ctx.globalAlpha = a;

      if (type === 0) {
        // ルーン円：外輪 + 十字
        ctx.strokeStyle = '#6633aa'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(wx, wy, r * 0.45, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(wx - r, wy); ctx.lineTo(wx + r, wy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(wx, wy - r); ctx.lineTo(wx, wy + r); ctx.stroke();
      } else if (type === 1) {
        // クリスタル：菱形シルエット
        ctx.fillStyle = '#334466';
        ctx.beginPath();
        ctx.moveTo(wx,           wy - r);
        ctx.lineTo(wx + r * 0.4, wy);
        ctx.lineTo(wx,           wy + r * 0.65);
        ctx.lineTo(wx - r * 0.4, wy);
        ctx.closePath(); ctx.fill();
      } else {
        // 地面のひび：折れ線
        ctx.strokeStyle = '#3a1a44'; ctx.lineWidth = 1; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(wx - r,           wy + r * 0.2);
        ctx.lineTo(wx - r * 0.2,     wy - r * 0.3);
        ctx.lineTo(wx + r * 0.5,     wy + r * 0.1);
        ctx.lineTo(wx + r,           wy - r * 0.2);
        ctx.stroke();
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
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
  document.getElementById('hud-name').textContent = gs.playerName;
  document.getElementById('hud-hp-text').textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
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
  document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
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

  WeaponManager.reset();
  ChestSystem.reset();
  BossSystem.reset();
  gs.pendingChest = false;

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
    AudioManager.resume();
    gs.playerName = document.getElementById('player-name-input').value.trim() || 'SURVIVOR';
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

  // --app-height を JS で強制セット（LINE等の独自ブラウザ対策）
  function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    document.documentElement.style.setProperty('--app-height', h + 'px');
    if (gs.canvas) {
      gs.canvas.width  = w;
      gs.canvas.height = h;
    }
  }
  resizeCanvas(); // 初回即実行
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 150));

  // prevent context menu on long press (mobile)
  document.addEventListener('contextmenu', e => e.preventDefault());
});
