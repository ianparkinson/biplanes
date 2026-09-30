// Simple CPU pilot: take off, avoid ground/hangar/stalls, then chase and lead the target.
import { W, GY, HANGAR, BULLET_SPEED } from "./config";
import { Game, Input, isAlive } from "./sim";

export const wrapAngle = (d: number) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

export function cpuInput(g: Game, id: number): Input {
  const p = g.planes[id], foe = g.planes[1 - id];
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
    else if (isAlive(foe)) {
      if (dist < 50) desired = Math.atan2(-dy, -dx);                          // avoid ramming
      else {
        const t = (dist / BULLET_SPEED) * 0.8;
        const ax = dx + Math.cos(foe.a) * foe.speed * t, ay = dy + Math.sin(foe.a) * foe.speed * t;
        desired = Math.atan2(ay, ax) + Math.sin(g.time / 0.7) * 0.08;        // slightly imperfect aim
        fire = Math.abs(wrapAngle(desired - p.a)) < 0.1 && dist < 350;
      }
    } else desired = p.y > 220 ? pitch(0.3) : pitch(0);
  }
  const d = wrapAngle(desired - p.a);
  return { rot: d > 0.06 ? 1 : d < -0.06 ? -1 : 0, fire };
}
