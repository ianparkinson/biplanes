// Cosmetic particles (explosions, smoke from falling wrecks). Each device runs its
// own from the game events and plane states, so they never go over the network.
import { GameEvent, GameView } from "./sim"

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number // seconds left
  color: string
}

const EXPLOSION_PARTICLES = 40
const EXPLOSION_COLORS = ["#fff", "#f5d020", "#e8402a", "#444"]
const SMOKE_RATE = 36 // puffs per second from a crashing plane
const PARTICLE_GRAVITY = 120

export class Effects {
  particles: Particle[] = []
  // Per plane: fractional smoke puffs owed, so the rate is right at any frame rate.
  private smokeOwed = [0, 0]

  event(event: GameEvent) {
    if (event.type !== "explode") return
    for (let i = 0; i < EXPLOSION_PARTICLES; i++) {
      // Fly out in a random direction at a random speed, biased upwards.
      const direction = Math.random() * Math.PI * 2
      const speed = 30 + Math.random() * 150
      this.particles.push({
        x: event.x,
        y: event.y,
        vx: Math.cos(direction) * speed,
        vy: Math.sin(direction) * speed - 40,
        life: 0.5 + Math.random() * 0.8,
        color: EXPLOSION_COLORS[i % EXPLOSION_COLORS.length],
      })
    }
  }

  update(view: GameView, dt: number) {
    for (const plane of view.planes) {
      if (plane.state !== "crashing") {
        this.smokeOwed[plane.id] = 0
        continue
      }
      this.smokeOwed[plane.id] += SMOKE_RATE * dt
      for (; this.smokeOwed[plane.id] >= 1; this.smokeOwed[plane.id]--) {
        this.particles.push({
          x: plane.x,
          y: plane.y,
          vx: 0,
          vy: -20,
          life: 0.6,
          color: "#555",
        })
      }
    }
    for (const particle of this.particles) {
      particle.x += particle.vx * dt
      particle.y += particle.vy * dt
      particle.vy += PARTICLE_GRAVITY * dt
      particle.life -= dt
    }
    this.particles = this.particles.filter((particle) => particle.life > 0)
  }

  clear() {
    this.particles = []
  }
}
