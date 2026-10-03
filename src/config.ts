// Shared constants.
//
// Coordinates: the world is WORLD_WIDTH x WORLD_HEIGHT units with the origin at
// the top-left and y pointing down (canvas convention). It wraps horizontally:
// fly off one side and you reappear on the other.
//
// Angles are in radians, measured clockwise because y points down: 0 faces
// right, PI faces left, and a positive sin(angle) means the nose points down.

export const WORLD_WIDTH = 800
export const WORLD_HEIGHT = 450
export const GROUND_Y = 410 // top of the grass
export const HANGAR = { x: 360, y: GROUND_Y - 40, w: 80, h: 40 }

export const MAX_DEATHS = 5 // planes each player has per match

// Plane handling. Speeds are world units per second.
export const MAX_SPEED = 200 // level-flight cruising speed (diving can exceed it)
export const LIFT_SPEED = 90 // minimum ground speed for take-off
export const TAKEOFF_ACCEL = 60 // ground acceleration, units/s²
export const TURN_RATE = 3 // radians per second
export const BULLET_SPEED = 400

export const SIM_DT = 1 / 60 // fixed simulation step, seconds

export const PLANE_COLORS = ["#e8402a", "#f5d020"] // red P1, yellow P2
