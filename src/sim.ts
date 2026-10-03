// Game simulation. Pure data and logic: no DOM, audio or input access, so the
// state can be run on one device and sent to others. Fully deterministic: the
// same inputs always produce the same game.
import {
  BULLET_SPEED,
  GROUND_Y,
  HANGAR,
  LIFT_SPEED,
  MAX_DEATHS,
  MAX_SPEED,
  TAKEOFF_ACCEL,
  TURN_RATE,
  WORLD_WIDTH,
} from "./config"
import { wrapX } from "./geometry"

export type PlaneState = "ground" | "air" | "crashing" | "dead"
export type Mode = "title" | "playing" | "over"

export interface Plane {
  id: number // 0 = player 1 (red), 1 = player 2 (yellow)
  state: PlaneState
  x: number
  y: number
  angle: number // heading in radians; see config.ts for the convention
  speed: number // airspeed along the heading
  sinkSpeed: number // extra downward speed while stalling
  runwayHeading: number // 0 or PI: which way the plane faces when on the ground
  vx: number // velocity while crashing (falls ballistically, ignoring controls)
  vy: number
  cooldown: number // seconds until the gun can fire again
  respawn: number // seconds until a dead plane reappears
  deaths: number
}

export interface Bullet {
  x: number
  y: number
  vx: number
  vy: number
  life: number // seconds left before it vanishes
  owner: number // id of the plane that fired it
}

// One plane's controls for a single step.
export interface Input {
  turn: number // -1 anticlockwise (nose up when flying right), 0 none, 1 clockwise
  fire: boolean
}

export type GameEvent =
  | { type: "shoot" | "whistle" | "explode"; x: number; y: number }
  | { type: "start" | "gameOver" }

// What a renderer needs; a Game satisfies it, and so does a snapshot received over the network.
export type PlaneView = Pick<
  Plane,
  "id" | "x" | "y" | "angle" | "state" | "deaths" | "speed"
>
export interface GameView {
  mode: Mode
  planes: PlaneView[]
  bullets: { x: number; y: number }[]
}

export interface Game {
  mode: Mode
  vsCpu: boolean // true = player 2 is computer controlled
  time: number // seconds of simulation since the page loaded
  planes: Plane[]
  bullets: Bullet[]
  events: GameEvent[] // sounds, explosions etc. raised since the caller last drained them
}

export const NO_INPUT: Input = { turn: 0, fire: false }

// Each plane starts at its own end of the runway, facing the other.
const SPAWNS = [
  { x: 40, runwayHeading: 0 },
  { x: WORLD_WIDTH - 40, runwayHeading: Math.PI },
]

const RUNWAY_Y = GROUND_Y - 5 // a plane's centre when its wheels are on the ground
const CEILING_Y = 8 // planes can't fly higher (smaller y) than this
const PLANE_RADIUS = 10 // for hitting the hangar
const WRECK_RADIUS = 8 // a falling wreck clips the hangar slightly later
const COLLISION_DISTANCE = 16 // planes closer than this collide
const BULLET_HIT_DISTANCE = 12
const GUN_OFFSET = 16 // bullets appear this far in front of the plane's centre
const FIRE_INTERVAL = 0.25 // seconds between shots
const BULLET_LIFE = 1 // seconds
const RESPAWN_DELAY = 2 // seconds

// Ground handling.
const MAX_TAXI_PITCH = 0.8 // radians the nose can lift while still on the ground
const TAKEOFF_PITCH = 0.15 // sin(angle) must be below -this (nose up) to lift off

// Flight physics.
const GRAVITY_EFFECT = 120 // speed lost per second when climbing vertically (gained diving)
const SPEED_RECOVERY = 0.5 // fraction of the gap to MAX_SPEED recovered per second
const MAX_DIVE_BONUS = 60 // how far above MAX_SPEED a dive can take the plane
const STALL_SPEED = 100 // below this the plane starts sinking
const STALL_SINK_ACCEL = 250 // sink speed builds up this fast while stalled
const STALL_RECOVERY = 400 // and drains this fast once flying properly again
const MAX_SINK_SPEED = 300
const WRECK_GRAVITY = 400
const WRECK_SPIN = 5 // radians per second

// Landing: touch down nearly level and not sinking fast, or crash.
const MAX_LANDING_SLOPE = 0.25 // |sin(angle)|
const MAX_LANDING_SINK = 60

function resetPlane(plane: Plane) {
  const spawn = SPAWNS[plane.id]
  plane.x = spawn.x
  plane.y = RUNWAY_Y
  plane.runwayHeading = spawn.runwayHeading
  plane.angle = spawn.runwayHeading
  plane.speed = 0
  plane.sinkSpeed = 0
  plane.state = "ground"
  plane.cooldown = 0
}

function newPlane(id: number): Plane {
  const plane: Plane = {
    id,
    runwayHeading: 0,
    state: "ground",
    x: 0,
    y: 0,
    angle: 0,
    speed: 0,
    sinkSpeed: 0,
    vx: 0,
    vy: 0,
    cooldown: 0,
    respawn: 0,
    deaths: 0,
  }
  resetPlane(plane)
  return plane
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

export function isAlive(plane: Plane) {
  return plane.state === "ground" || plane.state === "air"
}

export function startGame(game: Game, vsCpu: boolean) {
  game.vsCpu = vsCpu
  for (const plane of game.planes) {
    plane.deaths = 0
    resetPlane(plane)
  }
  game.bullets = []
  game.mode = "playing"
  game.events.push({ type: "start" })
}

// Shot down or collided. A plane on the ground explodes at once; one in the air
// becomes a wreck that keeps its momentum and falls until it hits something.
function crash(game: Game, plane: Plane) {
  if (!isAlive(plane)) return
  plane.deaths++
  if (plane.state === "ground") return explode(game, plane)
  plane.vx = plane.speed * Math.cos(plane.angle)
  plane.vy = plane.speed * Math.sin(plane.angle) + plane.sinkSpeed
  plane.state = "crashing"
  game.events.push({ type: "whistle", x: plane.x, y: plane.y })
}

function explode(game: Game, plane: Plane) {
  game.events.push({ type: "explode", x: plane.x, y: plane.y })
  plane.state = "dead"
  plane.respawn = RESPAWN_DELAY
}

// Whether a circle at (x, y) touches the hangar. The hangar sits on the ground,
// so only its top edge needs checking vertically.
export function hitsHangar(x: number, y: number, radius: number) {
  return (
    x + radius > HANGAR.x &&
    x - radius < HANGAR.x + HANGAR.w &&
    y + radius > HANGAR.y
  )
}

function fire(game: Game, plane: Plane) {
  plane.cooldown = FIRE_INTERVAL
  game.events.push({ type: "shoot", x: plane.x, y: plane.y })
  game.bullets.push({
    x: plane.x + Math.cos(plane.angle) * GUN_OFFSET,
    y: plane.y + Math.sin(plane.angle) * GUN_OFFSET,
    vx: Math.cos(plane.angle) * BULLET_SPEED,
    vy: Math.sin(plane.angle) * BULLET_SPEED,
    life: BULLET_LIFE,
    owner: plane.id,
  })
}

// Taxiing: accelerate along the runway; lift the nose once fast enough to fly.
function updateOnGround(game: Game, plane: Plane, dt: number) {
  plane.speed = Math.min(MAX_SPEED, plane.speed + TAKEOFF_ACCEL * dt)
  // The nose can only point up (or level), and only so far.
  if (Math.sin(plane.angle) > 0) plane.angle = plane.runwayHeading
  plane.angle = Math.max(
    plane.runwayHeading - MAX_TAXI_PITCH,
    Math.min(plane.runwayHeading + MAX_TAXI_PITCH, plane.angle),
  )
  plane.x += Math.cos(plane.angle) * plane.speed * dt
  if (hitsHangar(plane.x, plane.y, PLANE_RADIUS)) return crash(game, plane)
  if (plane.speed >= LIFT_SPEED && Math.sin(plane.angle) < -TAKEOFF_PITCH)
    plane.state = "air"
  plane.x = wrapX(plane.x)
}

function updateInAir(game: Game, plane: Plane, dt: number) {
  // Climbing bleeds speed and diving gains it (the sin term is negative when
  // climbing), while the engine pulls speed back towards MAX_SPEED.
  plane.speed +=
    Math.sin(plane.angle) * GRAVITY_EFFECT * dt +
    (MAX_SPEED - plane.speed) * SPEED_RECOVERY * dt
  plane.speed = Math.max(0, Math.min(MAX_SPEED + MAX_DIVE_BONUS, plane.speed))

  // Too slow and the wings stall: the plane starts sinking, whichever way it points.
  plane.sinkSpeed = Math.max(
    0,
    Math.min(
      MAX_SINK_SPEED,
      plane.sinkSpeed +
        (plane.speed < STALL_SPEED ? STALL_SINK_ACCEL : -STALL_RECOVERY) * dt,
    ),
  )

  plane.x += Math.cos(plane.angle) * plane.speed * dt
  plane.y += (Math.sin(plane.angle) * plane.speed + plane.sinkSpeed) * dt
  if (plane.y < CEILING_Y) plane.y = CEILING_Y
  if (hitsHangar(plane.x, plane.y, PLANE_RADIUS)) return crash(game, plane)

  if (plane.y >= RUNWAY_Y) {
    plane.y = RUNWAY_Y
    const gentle =
      Math.abs(Math.sin(plane.angle)) < MAX_LANDING_SLOPE &&
      plane.sinkSpeed < MAX_LANDING_SINK
    if (gentle) {
      plane.state = "ground"
      plane.runwayHeading = Math.cos(plane.angle) >= 0 ? 0 : Math.PI
      plane.angle = plane.runwayHeading
    } else {
      crash(game, plane)
    }
  }
  plane.x = wrapX(plane.x)
}

function updateWreck(game: Game, plane: Plane, dt: number) {
  plane.vy += WRECK_GRAVITY * dt
  plane.x += plane.vx * dt
  plane.y += plane.vy * dt
  plane.angle += WRECK_SPIN * dt
  if (plane.y >= RUNWAY_Y || hitsHangar(plane.x, plane.y, WRECK_RADIUS))
    explode(game, plane)
}

function updatePlane(game: Game, plane: Plane, input: Input, dt: number) {
  if (plane.state === "dead") {
    plane.respawn -= dt
    if (plane.respawn <= 0 && plane.deaths < MAX_DEATHS) resetPlane(plane)
    return
  }
  if (plane.state === "crashing") return updateWreck(game, plane, dt)

  plane.cooldown -= dt
  plane.angle += input.turn * TURN_RATE * dt
  if (input.fire && plane.cooldown <= 0) fire(game, plane)

  if (plane.state === "ground") updateOnGround(game, plane, dt)
  else updateInAir(game, plane, dt)
}

function updateBullets(game: Game, dt: number) {
  for (const bullet of game.bullets) {
    bullet.x = wrapX(bullet.x + bullet.vx * dt)
    bullet.y += bullet.vy * dt
    bullet.life -= dt
    const hitScenery =
      bullet.y >= GROUND_Y || bullet.y < 0 || hitsHangar(bullet.x, bullet.y, 1)
    if (hitScenery) bullet.life = 0
    for (const plane of game.planes) {
      const hit =
        isAlive(plane) &&
        plane.id !== bullet.owner &&
        Math.hypot(plane.x - bullet.x, plane.y - bullet.y) < BULLET_HIT_DISTANCE
      if (hit) {
        crash(game, plane)
        bullet.life = 0
      }
    }
  }
  game.bullets = game.bullets.filter((bullet) => bullet.life > 0)
}

function stepPlaying(game: Game, inputs: Input[], dt: number) {
  game.planes.forEach((plane, i) =>
    updatePlane(game, plane, inputs[i] ?? NO_INPUT, dt),
  )
  const [red, yellow] = game.planes
  if (
    isAlive(red) &&
    isAlive(yellow) &&
    Math.hypot(red.x - yellow.x, red.y - yellow.y) < COLLISION_DISTANCE
  ) {
    crash(game, red)
    crash(game, yellow)
  }
  updateBullets(game, dt)
}

// Advances the game by dt seconds. inputs[i] controls plane i.
export function step(game: Game, inputs: Input[], dt: number) {
  game.time += dt
  if (game.mode !== "playing") return
  stepPlaying(game, inputs, dt)
  // The match ends once a player has used up all their planes and no wreck is still falling.
  const finished =
    game.planes.some((plane) => plane.deaths >= MAX_DEATHS) &&
    game.planes.every((plane) => plane.state !== "crashing")
  if (finished) {
    game.mode = "over"
    game.events.push({ type: "gameOver" })
  }
}
