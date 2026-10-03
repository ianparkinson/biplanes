// Draws a game onto a canvas, in world coordinates (WORLD_WIDTH x WORLD_HEIGHT).
// Reads state only. Callers can scale the canvas transform to draw larger.
import {
  GROUND_Y,
  HANGAR,
  MAX_DEATHS,
  PLANE_COLORS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./config"
import { Particle } from "./effects"
import { GameView, PlaneView } from "./sim"

export interface RenderOptions {
  controls: "keys" | "touch" | "tv" // which how-to-play hints the title screen shows
  labels: [string, string] // HUD names for the two planes
  me?: number // the local player's plane, if only one of them is local
}

export function render(
  ctx: CanvasRenderingContext2D,
  game: GameView,
  particles: Particle[],
  options: RenderOptions,
) {
  function rect(color: string, x: number, y: number, w: number, h: number) {
    ctx.fillStyle = color
    ctx.fillRect(x, y, w, h)
  }

  // A plane is a handful of rectangles drawn around its centre, facing right,
  // then rotated to its heading.
  function drawPlane(plane: PlaneView) {
    if (plane.state === "dead") return
    const color = PLANE_COLORS[plane.id]
    ctx.save()
    ctx.translate(Math.round(plane.x), Math.round(plane.y))
    ctx.rotate(plane.angle)
    if (Math.cos(plane.angle) < 0) ctx.scale(1, -1) // keep it the right way up when heading left
    rect(color, -12, -3, 24, 6) // fuselage
    rect(color, -14, -8, 4, 6) // tail fin
    rect("#fff", -6, -10, 14, 2) // upper wing
    rect("#fff", -6, 4, 14, 2) // lower wing
    rect("#333", -2, -8, 2, 12) // strut
    rect("#333", 12, -5, 2, 10) // propeller
    rect("#333", -3, 6, 6, 3) // wheel
    ctx.restore()
  }

  // Centred text with a drop shadow.
  function text(message: string, y: number, size: number, color: string) {
    ctx.font = `bold ${size}px monospace`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = "#000"
    ctx.fillText(message, WORLD_WIDTH / 2 + 3, y + 3)
    ctx.fillStyle = color
    ctx.fillText(message, WORLD_WIDTH / 2, y)
  }

  // Title and game-over screens. Menu buttons are HTML laid over the lower part
  // of the canvas; this draws the text above them.
  function drawOverlay() {
    ctx.fillStyle = "rgba(0,0,40,0.45)"
    ctx.fillRect(0, 0, WORLD_WIDTH, GROUND_Y)
    if (game.mode === "title") {
      text("BIPLANES", 100, 72, "#f5d020")
      if (options.controls === "tv") {
        text("Scan the code with your phone to play", 180, 20, "#fff")
      } else if (options.controls === "touch") {
        text("↺ ↻  turn     FIRE  shoot", 180, 20, PLANE_COLORS[0])
      } else {
        text("P1  A / D rotate,  S fire", 180, 20, PLANE_COLORS[0])
        text("P2  ← / → rotate,  ↓ fire", 212, 20, PLANE_COLORS[1])
      }
      text(
        "Shoot down your rival " + MAX_DEATHS + " times to win",
        250,
        18,
        "#fff",
      )
    } else {
      const [red, yellow] = game.planes
      const winner =
        red.deaths === yellow.deaths ? -1 : red.deaths < yellow.deaths ? 0 : 1
      let message: string
      if (winner < 0) message = "DRAW!"
      else if (options.me !== undefined)
        message = winner === options.me ? "YOU WIN!" : "YOU LOSE!"
      else message = `PLAYER ${winner + 1} WINS!`
      text("GAME OVER", 110, 56, "#e8402a")
      text(message, 190, 40, winner < 0 ? "#fff" : PLANE_COLORS[winner])
    }
  }

  // Lives left for each player, along the top.
  function drawHud() {
    const [red, yellow] = game.planes
    ctx.font = "bold 20px monospace"
    ctx.textBaseline = "top"
    ctx.fillStyle = PLANE_COLORS[0]
    ctx.textAlign = "left"
    ctx.fillText(
      options.labels[0] + " " + "■".repeat(MAX_DEATHS - red.deaths),
      12,
      10,
    )
    ctx.fillStyle = PLANE_COLORS[1]
    ctx.textAlign = "right"
    ctx.fillText(
      "■".repeat(MAX_DEATHS - yellow.deaths) + " " + options.labels[1],
      WORLD_WIDTH - 12,
      10,
    )
  }

  // Scenery: sky, a lighter haze near the horizon, grass, earth, and the hangar.
  rect("#4aa8ff", 0, 0, WORLD_WIDTH, GROUND_Y)
  rect("#6dbcff", 0, GROUND_Y - 90, WORLD_WIDTH, 90)
  rect("#3a9a3a", 0, GROUND_Y, WORLD_WIDTH, WORLD_HEIGHT - GROUND_Y)
  rect("#7a5230", 0, GROUND_Y + 12, WORLD_WIDTH, WORLD_HEIGHT - GROUND_Y - 12)
  rect("#888", HANGAR.x, HANGAR.y, HANGAR.w, HANGAR.h) // walls
  rect("#666", HANGAR.x - 4, HANGAR.y - 6, HANGAR.w + 8, 8) // roof
  rect("#333", HANGAR.x + 20, HANGAR.y + 12, 40, HANGAR.h - 12) // doorway

  for (const bullet of game.bullets)
    rect("#fff", Math.round(bullet.x) - 1, Math.round(bullet.y) - 1, 3, 3)
  game.planes.forEach(drawPlane)
  for (const particle of particles)
    rect(particle.color, Math.round(particle.x), Math.round(particle.y), 3, 3)
  if (game.mode !== "title") drawHud()
  if (game.mode !== "playing") drawOverlay()
}
