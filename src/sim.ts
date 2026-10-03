// Game simulation. Pure data and logic: no DOM, audio or input access, so the
// state can be run on one device and sent to others.
import {
  ACCEL,
  BULLET_SPEED,
  GY,
  HANGAR,
  LIFT_SPEED,
  MAX_DEATHS,
  MAX_SPEED,
  TURN,
  W,
} from "./config"

export type PlaneState = "ground" | "air" | "crashing" | "dead"
export type Mode = "title" | "playing" | "over"

export interface Plane {
  id: number
  base: number
  state: PlaneState
  x: number
  y: number
  a: number
  speed: number
  fall: number
  vx: number
  vy: number
  cooldown: number
  respawn: number
  deaths: number
}
export interface Bullet {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  owner: number
}
export interface Input {
  rot: number
  fire: boolean
} // rot: -1 anticlockwise, 1 clockwise
export type GameEvent =
  | { type: "shoot" | "whistle" | "explode"; x: number; y: number }
  | { type: "start" | "gameOver" }

// What a renderer needs; a Game satisfies it, and so does a snapshot received over the network.
export type PlaneView = Pick<
  Plane,
  "id" | "x" | "y" | "a" | "state" | "deaths" | "speed"
>
export interface GameView {
  mode: Mode
  planes: PlaneView[]
  bullets: { x: number; y: number }[]
}

export interface Game {
  mode: Mode
  vsCpu: boolean // true = player 2 is computer controlled
  time: number
  planes: Plane[]
  bullets: Bullet[]
  events: GameEvent[] // sounds, explosions etc. raised since the caller last drained them
}

export const NO_INPUT: Input = { rot: 0, fire: false }
const SPAWNS = [
  { x: 40, base: 0 },
  { x: W - 40, base: Math.PI },
]

function resetPlane(p: Plane) {
  const s = SPAWNS[p.id]
  p.x = s.x
  p.y = GY - 5
  p.base = s.base
  p.a = s.base
  p.speed = 0
  p.fall = 0
  p.state = "ground"
  p.cooldown = 0
}

function newPlane(id: number): Plane {
  const p: Plane = {
    id,
    base: 0,
    state: "ground",
    x: 0,
    y: 0,
    a: 0,
    speed: 0,
    fall: 0,
    vx: 0,
    vy: 0,
    cooldown: 0,
    respawn: 0,
    deaths: 0,
  }
  resetPlane(p)
  return p
}

export function createGame(): Game {
  return {
    mode: "title",
    vsCpu: false,
    time: 0,
    planes: SPAWNS.map((_, id) => newPlane(id)),
    bullets: [],
    events: [],
  }
}

export const isAlive = (p: Plane) => p.state === "ground" || p.state === "air"

export function startGame(g: Game, vsCpu: boolean) {
  g.vsCpu = vsCpu
  g.planes.forEach((p) => {
    p.deaths = 0
    resetPlane(p)
  })
  g.bullets = []
  g.mode = "playing"
  g.events.push({ type: "start" })
}

function crash(g: Game, p: Plane) {
  if (!isAlive(p)) return
  p.deaths++
  if (p.state === "ground") return explode(g, p)
  p.vx = p.speed * Math.cos(p.a)
  p.vy = p.speed * Math.sin(p.a) + p.fall
  p.state = "crashing"
  g.events.push({ type: "whistle", x: p.x, y: p.y })
}

function explode(g: Game, p: Plane) {
  g.events.push({ type: "explode", x: p.x, y: p.y })
  p.state = "dead"
  p.respawn = 2
}

export function hitsHangar(x: number, y: number, r: number) {
  return x + r > HANGAR.x && x - r < HANGAR.x + HANGAR.w && y + r > HANGAR.y
}

function updatePlane(g: Game, p: Plane, inp: Input, dt: number) {
  if (p.state === "dead") {
    if ((p.respawn -= dt) <= 0 && p.deaths < MAX_DEATHS) resetPlane(p)
    return
  }
  if (p.state === "crashing") {
    p.vy += 400 * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.a += 5 * dt
    if (p.y >= GY - 5 || hitsHangar(p.x, p.y, 8)) explode(g, p)
    return
  }
  p.cooldown -= dt
  p.a += inp.rot * TURN * dt

  if (inp.fire && p.cooldown <= 0) {
    p.cooldown = 0.25
    g.events.push({ type: "shoot", x: p.x, y: p.y })
    g.bullets.push({
      x: p.x + Math.cos(p.a) * 16,
      y: p.y + Math.sin(p.a) * 16,
      vx: Math.cos(p.a) * BULLET_SPEED,
      vy: Math.sin(p.a) * BULLET_SPEED,
      life: 1,
      owner: p.id,
    })
  }

  if (p.state === "ground") {
    p.speed = Math.min(MAX_SPEED, p.speed + ACCEL * dt)
    if (Math.sin(p.a) > 0) p.a = p.base // can't point the nose into the ground
    p.a = Math.max(p.base - 0.8, Math.min(p.base + 0.8, p.a))
    p.x += Math.cos(p.a) * p.speed * dt
    if (hitsHangar(p.x, p.y, 10)) return crash(g, p)
    if (p.speed >= LIFT_SPEED && Math.sin(p.a) < -0.15) p.state = "air"
  } else {
    // Climbing bleeds speed, diving gains it; stalling makes the plane sink.
    p.speed += Math.sin(p.a) * 120 * dt + (MAX_SPEED - p.speed) * 0.5 * dt
    p.speed = Math.max(0, Math.min(MAX_SPEED + 60, p.speed))
    p.fall = Math.max(
      0,
      Math.min(300, p.fall + (p.speed < 100 ? 250 : -400) * dt),
    )
    p.x += Math.cos(p.a) * p.speed * dt
    p.y += (Math.sin(p.a) * p.speed + p.fall) * dt
    if (p.y < 8) p.y = 8
    if (hitsHangar(p.x, p.y, 10)) return crash(g, p)
    if (p.y >= GY - 5) {
      // Land gently and level, otherwise crash.
      if (Math.abs(Math.sin(p.a)) < 0.25 && p.fall < 60) {
        p.y = GY - 5
        p.state = "ground"
        p.base = Math.cos(p.a) >= 0 ? 0 : Math.PI
        p.a = p.base
      } else {
        p.y = GY - 5
        crash(g, p)
      }
    }
  }
  p.x = (p.x + W) % W
}

function stepPlaying(g: Game, inputs: Input[], dt: number) {
  g.planes.forEach((p, i) => updatePlane(g, p, inputs[i] ?? NO_INPUT, dt))
  const [a, b] = g.planes
  if (isAlive(a) && isAlive(b) && Math.hypot(a.x - b.x, a.y - b.y) < 16) {
    crash(g, a)
    crash(g, b)
  }

  for (const bl of g.bullets) {
    bl.x = (bl.x + bl.vx * dt + W) % W
    bl.y += bl.vy * dt
    bl.life -= dt
    if (bl.y >= GY || bl.y < 0 || hitsHangar(bl.x, bl.y, 1)) bl.life = 0
    for (const p of g.planes) {
      if (
        isAlive(p) &&
        p.id !== bl.owner &&
        Math.hypot(p.x - bl.x, p.y - bl.y) < 12
      ) {
        crash(g, p)
        bl.life = 0
      }
    }
  }
  g.bullets = g.bullets.filter((b) => b.life > 0)
}

export function step(g: Game, inputs: Input[], dt: number) {
  g.time += dt
  if (g.mode === "playing") stepPlaying(g, inputs, dt)
  // Game ends once a player has used up all their planes and no wreck is still falling.
  if (
    g.mode === "playing" &&
    g.planes.some((p) => p.deaths >= MAX_DEATHS) &&
    g.planes.every((p) => p.state !== "crashing")
  ) {
    g.mode = "over"
    g.events.push({ type: "gameOver" })
  }
}
