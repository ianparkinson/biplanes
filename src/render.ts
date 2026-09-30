// Draws a Game onto the canvas. Reads state only.
import { W, H, GY, HANGAR, MAX_DEATHS, PLANE_COLORS } from "./config";
import { GameView, PlaneView } from "./sim";
import { Particle } from "./effects";

export interface RenderOptions {
  touch: boolean;
  labels: [string, string]; // HUD names for the two planes
  me?: number;              // the local player's plane, if only one of them is local
}

export function render(ctx: CanvasRenderingContext2D, g: GameView, particles: Particle[], opts: RenderOptions) {
  const rect = (c: string, x: number, y: number, w: number, h: number) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

  function drawPlane(p: PlaneView) {
    if (p.state === "dead") return;
    const color = PLANE_COLORS[p.id];
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y));
    ctx.rotate(p.a);
    if (Math.cos(p.a) < 0) ctx.scale(1, -1); // keep the plane the right way up when heading left
    rect(color, -12, -3, 24, 6);         // fuselage
    rect(color, -14, -8, 4, 6);          // tail fin
    rect("#fff", -6, -10, 14, 2);        // upper wing
    rect("#fff", -6, 4, 14, 2);          // lower wing
    rect("#333", -2, -8, 2, 12);         // strut
    rect("#333", 12, -5, 2, 10);         // propeller
    rect("#333", -3, 6, 6, 3);           // wheel
    ctx.restore();
  }

  function text(t: string, y: number, size: number, color: string) {
    ctx.font = `bold ${size}px monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#000"; ctx.fillText(t, W / 2 + 3, y + 3);
    ctx.fillStyle = color; ctx.fillText(t, W / 2, y);
  }

  // Menu buttons are HTML, laid over the lower part of the canvas; this draws the text above them.
  function drawOverlay() {
    ctx.fillStyle = "rgba(0,0,40,0.45)"; ctx.fillRect(0, 0, W, GY);
    if (g.mode === "title") {
      text("BIPLANES", 100, 72, "#f5d020");
      if (opts.touch) {
        text("↺ ↻  turn     FIRE  shoot", 180, 20, PLANE_COLORS[0]);
      } else {
        text("P1  A / D rotate,  S fire", 180, 20, PLANE_COLORS[0]);
        text("P2  ← / → rotate,  ↓ fire", 212, 20, PLANE_COLORS[1]);
      }
      text("Shoot down your rival " + MAX_DEATHS + " times to win", 250, 18, "#fff");
    } else {
      const [a, b] = g.planes;
      const winner = a.deaths === b.deaths ? -1 : a.deaths < b.deaths ? 0 : 1;
      const msg = winner < 0 ? "DRAW!"
        : opts.me !== undefined ? (winner === opts.me ? "YOU WIN!" : "YOU LOSE!")
        : `PLAYER ${winner + 1} WINS!`;
      text("GAME OVER", 110, 56, "#e8402a");
      text(msg, 190, 40, winner < 0 ? "#fff" : PLANE_COLORS[winner]);
    }
  }

  rect("#4aa8ff", 0, 0, W, GY);
  rect("#6dbcff", 0, GY - 90, W, 90);
  rect("#3a9a3a", 0, GY, W, H - GY);
  rect("#7a5230", 0, GY + 12, W, H - GY - 12);
  rect("#888", HANGAR.x, HANGAR.y, HANGAR.w, HANGAR.h);          // hangar
  rect("#666", HANGAR.x - 4, HANGAR.y - 6, HANGAR.w + 8, 8);
  rect("#333", HANGAR.x + 20, HANGAR.y + 12, 40, HANGAR.h - 12);
  for (const b of g.bullets) rect("#fff", Math.round(b.x) - 1, Math.round(b.y) - 1, 3, 3);
  g.planes.forEach(drawPlane);
  for (const pt of particles) rect(pt.color, Math.round(pt.x), Math.round(pt.y), 3, 3);
  if (g.mode !== "title") {
    const [a, b] = g.planes;
    ctx.font = "bold 20px monospace"; ctx.textBaseline = "top";
    ctx.fillStyle = PLANE_COLORS[0]; ctx.textAlign = "left";
    ctx.fillText(opts.labels[0] + " " + "■".repeat(MAX_DEATHS - a.deaths), 12, 10);
    ctx.fillStyle = PLANE_COLORS[1]; ctx.textAlign = "right";
    ctx.fillText("■".repeat(MAX_DEATHS - b.deaths) + " " + opts.labels[1], W - 12, 10);
  }
  if (g.mode !== "playing") drawOverlay();
}
