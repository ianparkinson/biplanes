// Biplanes: a two-player 8-bit style dogfight. Plain TypeScript + Canvas.
const W = 800, H = 450, GY = 410; // canvas size, ground top
const HANGAR = { x: 360, y: GY - 40, w: 80, h: 40 };
const MAX_DEATHS = 5;
const MAX_SPEED = 200, LIFT_SPEED = 90, ACCEL = 60, TURN = 3, BULLET_SPEED = 400;

type State = "ground" | "air" | "crashing" | "dead";
interface Bullet { x: number; y: number; vx: number; vy: number; life: number; owner: number }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string }
interface Keys { ccw: string; cw: string; fire: string }

class Plane {
  x = 0; y = 0; a = 0; speed = 0; fall = 0; vx = 0; vy = 0;
  state: State = "ground"; cooldown = 0; respawn = 0; deaths = 0;
  constructor(public id: number, public startX: number, public base: number,
              public color: string, public keys: Keys) { this.reset(); }
  reset() {
    this.x = this.startX; this.y = GY - 5; this.a = this.base;
    this.speed = 0; this.fall = 0; this.state = "ground"; this.cooldown = 0;
  }
  get alive() { return this.state === "ground" || this.state === "air"; }
}

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
canvas.width = W; canvas.height = H;

const planes = [
  new Plane(0, 40, 0, "#e8402a", { ccw: "KeyA", cw: "KeyD", fire: "KeyS" }),
  new Plane(1, W - 40, Math.PI, "#f5d020", { ccw: "ArrowLeft", cw: "ArrowRight", fire: "ArrowDown" }),
];
// Synthesized sound effects (Web Audio). No audio files needed.
class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private eng: { osc: OscillatorNode; gain: GainNode; pan: StereoPannerNode }[] = [];
  private muted = false;

  init() { // must be called from a user gesture
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const c = (this.ctx = new AC());
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.5; this.master.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (const base of [55, 65]) { // one buzzing, chopping engine per plane
      const osc = c.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = base;
      const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 500;
      const trem = c.createGain(); trem.gain.value = 0.7;
      const lfo = c.createOscillator(); lfo.frequency.value = 16 + base / 10;
      const depth = c.createGain(); depth.gain.value = 0.3; lfo.connect(depth); depth.connect(trem.gain);
      const gain = c.createGain(); gain.gain.value = 0;
      const pan = c.createStereoPanner();
      osc.connect(lp); lp.connect(trem); trem.connect(gain); gain.connect(pan); pan.connect(this.master);
      osc.start(); lfo.start();
      this.eng.push({ osc, gain, pan });
    }
  }
  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.value = this.muted ? 0 : 0.5;
  }
  private pan(x: number) { return Math.max(-1, Math.min(1, (x / W) * 2 - 1)) * 0.7; }
  engine(i: number, on: boolean, speed: number, x: number) {
    if (!this.ctx) return;
    const e = this.eng[i], t = this.ctx.currentTime;
    e.gain.gain.setTargetAtTime(on ? 0.06 : 0, t, 0.08);
    e.osc.frequency.setTargetAtTime((i ? 65 : 55) + speed * 0.3, t, 0.1);
    e.pan.pan.setTargetAtTime(this.pan(x), t, 0.05);
  }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0, pan = 0) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    p.pan.value = pan; o.connect(g); g.connect(p); p.connect(this.master); o.start(t); o.stop(t + dur);
  }
  private burst(dur: number, vol: number, f0: number, f1: number, type: BiquadFilterType, pan = 0) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const p = c.createStereoPanner(); p.pan.value = pan;
    src.connect(f); f.connect(g); g.connect(p); p.connect(this.master); src.start(t); src.stop(t + dur);
  }
  shoot(x: number) { this.tone("square", 1200, 180, 0.09, 0.1, 0, this.pan(x)); this.burst(0.06, 0.15, 4000, 1500, "bandpass", this.pan(x)); }
  whistle(x: number) { this.tone("triangle", 1100, 250, 1.0, 0.08, 0, this.pan(x)); }
  explode(x: number) { this.burst(1.0, 0.7, 2000, 80, "lowpass", this.pan(x)); this.tone("sine", 110, 25, 0.6, 0.5, 0, this.pan(x)); }
  start() { [392, 523, 659, 784].forEach((f, i) => this.tone("square", f, f, 0.12, 0.08, i * 0.1)); }
  gameOver() { [523, 440, 349, 262].forEach((f, i) => this.tone("sawtooth", f, f, 0.25, 0.1, i * 0.18)); }
}
const sfx = new Sfx();

let mode: "title" | "playing" | "over" = "title";
let cpu = false; // true = player 2 is computer controlled
let bullets: Bullet[] = [];
let particles: Particle[] = [];
const down = new Set<string>();
addEventListener("keydown", e => {
  if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  sfx.init();
  if (e.code === "KeyM") sfx.toggleMute();
  if (mode !== "playing") { // title and game-over screens both offer the mode choice
    if (e.code === "Digit1" || e.code === "Numpad1") startGame(true);
    if (e.code === "Digit2" || e.code === "Numpad2") startGame(false);
  }
  down.add(e.code);
});
addEventListener("keyup", e => down.delete(e.code));

function burst(x: number, y: number, n: number, colors: string[]) {
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2, s = 30 + Math.random() * 150;
    particles.push({ x, y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s - 40,
      life: 0.5 + Math.random() * 0.8, color: colors[i % colors.length] });
  }
}

function crash(p: Plane) {
  if (!p.alive) return;
  p.deaths++;
  if (p.state === "ground") return explode(p);
  p.vx = p.speed * Math.cos(p.a); p.vy = p.speed * Math.sin(p.a) + p.fall;
  p.state = "crashing"; sfx.whistle(p.x);
}

function explode(p: Plane) {
  burst(p.x, p.y, 40, ["#fff", "#f5d020", "#e8402a", "#444"]);
  sfx.explode(p.x);
  p.state = "dead"; p.respawn = 2;
}

function hitsHangar(x: number, y: number, r: number) {
  return x + r > HANGAR.x && x - r < HANGAR.x + HANGAR.w && y + r > HANGAR.y;
}

const wrapAngle = (d: number) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

function readInput(p: Plane) {
  if (cpu && p.id === 1) return cpuInput(p);
  return { rot: (down.has(p.keys.cw) ? 1 : 0) - (down.has(p.keys.ccw) ? 1 : 0), fire: down.has(p.keys.fire) };
}

// Simple CPU pilot: take off, avoid ground/hangar/stalls, then chase and lead the target.
function cpuInput(p: Plane) {
  const foe = planes[0];
  const facing = Math.cos(p.a) >= 0 ? 1 : -1;
  const pitch = (k: number) => (facing > 0 ? 0 : Math.PI) - facing * k; // k > 0 points the nose up
  let desired = p.a, fire = false;

  if (p.state === "ground") {
    desired = p.speed >= 150 ? pitch(0.5) : p.base;
  } else {
    let dx = foe.x - p.x; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
    const dy = foe.y - p.y, dist = Math.hypot(dx, dy);
    const nearHangar = Math.abs(p.x - (HANGAR.x + HANGAR.w / 2)) < 110 && p.y > HANGAR.y - 60;
    if (p.speed < 125) desired = p.y > GY - 60 ? pitch(0.1) : pitch(-0.5);   // recover from a stall
    else if (nearHangar) desired = pitch(0.9);
    else if (p.y > GY - 70) desired = pitch(0.4);
    else if (p.y < 50) desired = pitch(-0.5);
    else if (foe.alive) {
      if (dist < 50) desired = Math.atan2(-dy, -dx);                          // avoid ramming
      else {
        const t = (dist / BULLET_SPEED) * 0.8;
        const ax = dx + Math.cos(foe.a) * foe.speed * t, ay = dy + Math.sin(foe.a) * foe.speed * t;
        desired = Math.atan2(ay, ax) + Math.sin(performance.now() / 700) * 0.08; // slightly imperfect aim
        fire = Math.abs(wrapAngle(desired - p.a)) < 0.1 && dist < 350;
      }
    } else desired = p.y > 220 ? pitch(0.3) : pitch(0);
  }
  const d = wrapAngle(desired - p.a);
  return { rot: d > 0.06 ? 1 : d < -0.06 ? -1 : 0, fire };
}

function updatePlane(p: Plane, dt: number) {
  if (p.state === "dead") {
    if ((p.respawn -= dt) <= 0 && p.deaths < MAX_DEATHS) p.reset();
    return;
  }
  if (p.state === "crashing") {
    p.vy += 400 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.a += 5 * dt;
    if (Math.random() < 0.6) particles.push({ x: p.x, y: p.y, vx: 0, vy: -20, life: 0.6, color: "#555" });
    if (p.y >= GY - 5 || hitsHangar(p.x, p.y, 8)) explode(p);
    return;
  }
  p.cooldown -= dt;
  const inp = readInput(p);
  p.a += inp.rot * TURN * dt;

  if (inp.fire && p.cooldown <= 0) {
    p.cooldown = 0.25; sfx.shoot(p.x);
    bullets.push({ x: p.x + Math.cos(p.a) * 16, y: p.y + Math.sin(p.a) * 16,
      vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED, life: 1, owner: p.id });
  }

  if (p.state === "ground") {
    p.speed = Math.min(MAX_SPEED, p.speed + ACCEL * dt);
    if (Math.sin(p.a) > 0) p.a = p.base; // can't point the nose into the ground
    p.a = Math.max(p.base - 0.8, Math.min(p.base + 0.8, p.a));
    p.x += Math.cos(p.a) * p.speed * dt;
    if (hitsHangar(p.x, p.y, 10)) return crash(p);
    if (p.speed >= LIFT_SPEED && Math.sin(p.a) < -0.15) p.state = "air";
  } else {
    // Climbing bleeds speed, diving gains it; stalling makes the plane sink.
    p.speed += Math.sin(p.a) * 120 * dt + (MAX_SPEED - p.speed) * 0.5 * dt;
    p.speed = Math.max(0, Math.min(MAX_SPEED + 60, p.speed));
    p.fall = Math.max(0, Math.min(300, p.fall + (p.speed < 100 ? 250 : -400) * dt));
    p.x += Math.cos(p.a) * p.speed * dt;
    p.y += (Math.sin(p.a) * p.speed + p.fall) * dt;
    if (p.y < 8) p.y = 8;
    if (hitsHangar(p.x, p.y, 10)) return crash(p);
    if (p.y >= GY - 5) {
      // Land gently and level, otherwise crash.
      if (Math.abs(Math.sin(p.a)) < 0.25 && p.fall < 60) {
        p.y = GY - 5; p.state = "ground"; p.base = Math.cos(p.a) >= 0 ? 0 : Math.PI; p.a = p.base;
      } else { p.y = GY - 5; crash(p); }
    }
  }
  p.x = (p.x + W) % W;
}

function step(dt: number) {
  planes.forEach(p => updatePlane(p, dt));
  const [a, b] = planes;
  if (a.alive && b.alive && Math.hypot(a.x - b.x, a.y - b.y) < 16) { crash(a); crash(b); }

  for (const bl of bullets) {
    bl.x = (bl.x + bl.vx * dt + W) % W; bl.y += bl.vy * dt; bl.life -= dt;
    if (bl.y >= GY || bl.y < 0 || hitsHangar(bl.x, bl.y, 1)) bl.life = 0;
    for (const p of planes) {
      if (p.alive && p.id !== bl.owner && Math.hypot(p.x - bl.x, p.y - bl.y) < 12) { crash(p); bl.life = 0; }
    }
  }
  bullets = bullets.filter(b => b.life > 0);
  for (const pt of particles) { pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 120 * dt; pt.life -= dt; }
  particles = particles.filter(p => p.life > 0);
  // Game ends once a player has used up all their planes and no wreck is still falling.
  if (planes.some(p => p.deaths >= MAX_DEATHS) && planes.every(p => p.state !== "crashing")) { mode = "over"; sfx.gameOver(); }
}

function update(dt: number) {
  if (mode === "playing") return step(dt);
  for (const pt of particles) { pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 120 * dt; pt.life -= dt; }
  particles = particles.filter(p => p.life > 0);
}

function startGame(vsCpu: boolean) {
  cpu = vsCpu; sfx.start();
  planes.forEach(p => { p.deaths = 0; p.reset(); });
  bullets = []; particles = []; mode = "playing";
}

function rect(c: string, x: number, y: number, w: number, h: number) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

function drawPlane(p: Plane) {
  if (p.state === "dead") return;
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  ctx.rotate(p.a);
  if (Math.cos(p.a) < 0) ctx.scale(1, -1); // keep the plane the right way up when heading left
  rect(p.color, -12, -3, 24, 6);       // fuselage
  rect(p.color, -14, -8, 4, 6);        // tail fin
  rect("#fff", -6, -10, 14, 2);        // upper wing
  rect("#fff", -6, 4, 14, 2);          // lower wing
  rect("#333", -2, -8, 2, 12);         // strut
  rect("#333", 12, -5, 2, 10);         // propeller
  rect("#333", -3, 6, 6, 3);           // wheel
  ctx.restore();
}

function draw() {
  rect("#4aa8ff", 0, 0, W, GY);
  rect("#6dbcff", 0, GY - 90, W, 90);
  rect("#3a9a3a", 0, GY, W, H - GY);
  rect("#7a5230", 0, GY + 12, W, H - GY - 12);
  rect("#888", HANGAR.x, HANGAR.y, HANGAR.w, HANGAR.h);          // hangar
  rect("#666", HANGAR.x - 4, HANGAR.y - 6, HANGAR.w + 8, 8);
  rect("#333", HANGAR.x + 20, HANGAR.y + 12, 40, HANGAR.h - 12);
  for (const b of bullets) rect("#fff", Math.round(b.x) - 1, Math.round(b.y) - 1, 3, 3);
  planes.forEach(drawPlane);
  for (const pt of particles) rect(pt.color, Math.round(pt.x), Math.round(pt.y), 3, 3);
  if (mode !== "title") {
    ctx.font = "bold 20px monospace"; ctx.textBaseline = "top";
    ctx.fillStyle = planes[0].color; ctx.textAlign = "left";
    ctx.fillText("P1 " + "\u25A0".repeat(MAX_DEATHS - planes[0].deaths), 12, 10);
    ctx.fillStyle = planes[1].color; ctx.textAlign = "right";
    ctx.fillText("\u25A0".repeat(MAX_DEATHS - planes[1].deaths) + (cpu ? " CPU" : " P2"), W - 12, 10);
  }
  if (mode !== "playing") drawOverlay();
}

function text(t: string, y: number, size: number, color: string) {
  ctx.font = `bold ${size}px monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#000"; ctx.fillText(t, W / 2 + 3, y + 3);
  ctx.fillStyle = color; ctx.fillText(t, W / 2, y);
}

function drawOverlay() {
  ctx.fillStyle = "rgba(0,0,40,0.45)"; ctx.fillRect(0, 0, W, GY);
  const blink = Math.floor(performance.now() / 500) % 2 === 0;
  if (mode === "title") {
    text("BIPLANES", 100, 72, "#f5d020");
    text("P1  A / D rotate,  S fire", 180, 20, planes[0].color);
    text("P2  \u2190 / \u2192 rotate,  \u2193 fire", 212, 20, planes[1].color);
    text("Shoot down your rival " + MAX_DEATHS + " times to win", 256, 18, "#fff");
    if (blink) {
      text("PRESS 1 : ONE PLAYER (VS CPU)", 315, 24, "#fff");
      text("PRESS 2 : TWO PLAYERS", 350, 24, "#fff");
    }
    text("M : SOUND ON / OFF", 392, 14, "#fff");
  } else {
    const [a, b] = planes;
    const p2 = cpu ? "CPU" : "PLAYER 2";
    const msg = a.deaths === b.deaths ? "DRAW!" : a.deaths < b.deaths ? (cpu ? "YOU WIN!" : "PLAYER 1 WINS!") : p2 + " WINS!";
    text("GAME OVER", 110, 56, "#e8402a");
    text(msg, 190, 40, a.deaths === b.deaths ? "#fff" : (a.deaths < b.deaths ? a.color : b.color));
    if (blink) {
      text("PRESS 1 : ONE PLAYER (VS CPU)", 290, 24, "#fff");
      text("PRESS 2 : TWO PLAYERS", 325, 24, "#fff");
    }
  }
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  update(dt); draw();
  planes.forEach((p, i) => sfx.engine(i, mode === "playing" && p.alive, p.speed, p.x));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
