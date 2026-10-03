import { WORLD_WIDTH } from "./config"

// Wraps an x coordinate around the left and right edges of the world.
export function wrapX(x: number) {
  return (x + WORLD_WIDTH) % WORLD_WIDTH
}

// Normalises an angle difference to the range -PI..PI, i.e. the shortest turn.
export function wrapAngle(angle: number) {
  while (angle > Math.PI) angle -= 2 * Math.PI
  while (angle < -Math.PI) angle += 2 * Math.PI
  return angle
}

// Horizontal distance from one x to another, taking the shorter way round the
// wrapping world (so the result is between -WORLD_WIDTH/2 and WORLD_WIDTH/2).
export function wrappedDx(fromX: number, toX: number) {
  let dx = toX - fromX
  if (dx > WORLD_WIDTH / 2) dx -= WORLD_WIDTH
  if (dx < -WORLD_WIDTH / 2) dx += WORLD_WIDTH
  return dx
}
