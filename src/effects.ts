// Cosmetic particles (explosions, smoke from falling wrecks). Each device runs its
// own from the game events and plane states, so they never go over the network.
import { GameEvent, GameView } from "./sim";

export interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string }

const SMOKE_RATE = 36; // puffs per second from a crashing plane

export class Effects {
  particles: Particle[] = [];
  private smoke = [0, 0];

  event(e: GameEvent) {
    if (e.type !== "explode") return;
    const colors = ["#fff", "#f5d020", "#e8402a", "#444"];
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2, s = 30 + Math.random() * 150;
      this.particles.push({ x: e.x, y: e.y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s - 40,
        life: 0.5 + Math.random() * 0.8, color: colors[i % colors.length] });
    }
  }

  update(view: GameView, dt: number) {
    for (const p of view.planes) {
      if (p.state !== "crashing") { this.smoke[p.id] = 0; continue; }
      for (this.smoke[p.id] += SMOKE_RATE * dt; this.smoke[p.id] >= 1; this.smoke[p.id]--) {
        this.particles.push({ x: p.x, y: p.y, vx: 0, vy: -20, life: 0.6, color: "#555" });
      }
    }
    for (const pt of this.particles) { pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 120 * dt; pt.life -= dt; }
    this.particles = this.particles.filter(p => p.life > 0);
  }

  clear() { this.particles = []; }
}
