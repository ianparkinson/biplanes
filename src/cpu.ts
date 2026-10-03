// Simple CPU pilot: take off, avoid the ground, hangar and stalls, then chase
// the other plane and fire when lined up. It only decides which way to turn and
// whether to fire, like a human player.
import { BULLET_SPEED, GROUND_Y, HANGAR } from "./config"
import { wrapAngle, wrappedDx } from "./geometry"
import { Game, Input, isAlive } from "./sim"

const ROTATE_SPEED = 150 // ground speed at which to pull up for take-off
const STALL_RISK_SPEED = 125 // below this in the air, recover speed first
const HANGAR_CLEARANCE_X = 110 // horizontal distance from the hangar's centre...
const HANGAR_CLEARANCE_Y = 60 // ...and height above its roof that count as "too close"
const LOW_ALTITUDE = 70 // height above the ground that triggers a climb
const STALL_LOW_ALTITUDE = 60 // when stalling this low, only pull up gently
const HIGH_ALTITUDE_Y = 50 // y below which to nose down, away from the ceiling
const CRUISE_ALTITUDE_Y = 220 // where to loiter while the other plane respawns
const RAM_DISTANCE = 50 // closer than this, turn away rather than collide
const LEAD_FACTOR = 0.8 // how far ahead to aim, as a fraction of bullet flight time
const AIM_WOBBLE = 0.08 // radians of deliberate aiming error
const AIM_WOBBLE_PERIOD = 0.7 // seconds per radian of the wobble's sine wave
const FIRE_ANGLE = 0.1 // fire when within this many radians of the aim point
const FIRE_RANGE = 350
const TURN_DEADBAND = 0.06 // don't turn for smaller errors, to avoid jitter

export function cpuInput(game: Game, id: number): Input {
  const plane = game.planes[id]
  const foe = game.planes[1 - id]
  const facing = Math.cos(plane.angle) >= 0 ? 1 : -1 // 1 = right, -1 = left

  // The heading that points `up` radians above horizontal, keeping the current
  // left/right direction. Negative values point below horizontal.
  function pitch(up: number) {
    return (facing > 0 ? 0 : Math.PI) - facing * up
  }

  let desired = plane.angle
  let fire = false

  if (plane.state === "ground") {
    desired = plane.speed >= ROTATE_SPEED ? pitch(0.5) : plane.runwayHeading
  } else {
    const dx = wrappedDx(plane.x, foe.x)
    const dy = foe.y - plane.y
    const distance = Math.hypot(dx, dy)
    const nearHangar =
      Math.abs(plane.x - (HANGAR.x + HANGAR.w / 2)) < HANGAR_CLEARANCE_X &&
      plane.y > HANGAR.y - HANGAR_CLEARANCE_Y

    // Staying airborne comes first, in order of urgency; then hunting.
    if (plane.speed < STALL_RISK_SPEED) {
      // Recover from a stall: dive to gain speed, unless too low to risk it.
      desired =
        plane.y > GROUND_Y - STALL_LOW_ALTITUDE ? pitch(0.1) : pitch(-0.5)
    } else if (nearHangar) desired = pitch(0.9)
    else if (plane.y > GROUND_Y - LOW_ALTITUDE) desired = pitch(0.4)
    else if (plane.y < HIGH_ALTITUDE_Y) desired = pitch(-0.5)
    else if (isAlive(foe)) {
      if (distance < RAM_DISTANCE) {
        desired = Math.atan2(-dy, -dx) // turn directly away
      } else {
        // Lead the target: aim where it will be when a bullet gets there.
        const flightTime = (distance / BULLET_SPEED) * LEAD_FACTOR
        const aimX = dx + Math.cos(foe.angle) * foe.speed * flightTime
        const aimY = dy + Math.sin(foe.angle) * foe.speed * flightTime
        const wobble = Math.sin(game.time / AIM_WOBBLE_PERIOD) * AIM_WOBBLE // so it doesn't hit every shot
        desired = Math.atan2(aimY, aimX) + wobble
        fire =
          Math.abs(wrapAngle(desired - plane.angle)) < FIRE_ANGLE &&
          distance < FIRE_RANGE
      }
    } else {
      // Nothing to chase: settle at a safe altitude.
      desired = plane.y > CRUISE_ALTITUDE_Y ? pitch(0.3) : pitch(0)
    }
  }

  const error = wrapAngle(desired - plane.angle)
  const turn = error > TURN_DEADBAND ? 1 : error < -TURN_DEADBAND ? -1 : 0
  return { turn, fire }
}
