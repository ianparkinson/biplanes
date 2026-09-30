// Local input sources. Each produces a sim Input for one plane.
import { Input } from "./sim";

interface Keys { ccw: string; cw: string; fire: string }
export const KEYS: Keys[] = [
  { ccw: "KeyA", cw: "KeyD", fire: "KeyS" },
  { ccw: "ArrowLeft", cw: "ArrowRight", fire: "ArrowDown" },
];

export class Keyboard {
  private down = new Set<string>();
  constructor() {
    addEventListener("keydown", e => {
      if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
      this.down.add(e.code);
    });
    addEventListener("keyup", e => this.down.delete(e.code));
    addEventListener("blur", () => this.down.clear());
  }
  input(k: Keys): Input {
    return { rot: (this.down.has(k.cw) ? 1 : 0) - (this.down.has(k.ccw) ? 1 : 0), fire: this.down.has(k.fire) };
  }
}

// On-screen buttons marked with data-control="ccw" | "cw" | "fire". Each finger is
// tracked separately and can slide between buttons without lifting.
export class TouchControls {
  private pointers = new Map<number, string | null>();
  private buttons: HTMLElement[];

  constructor(root: HTMLElement) {
    this.buttons = [...root.querySelectorAll<HTMLElement>("[data-control]")];
    const controlAt = (e: PointerEvent) =>
      document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-control]")?.dataset.control ?? null;
    root.addEventListener("pointerdown", e => {
      const c = controlAt(e);
      if (!c) return;
      e.preventDefault();
      this.pointers.set(e.pointerId, c);
      this.sync();
    });
    addEventListener("pointermove", e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, controlAt(e));
      this.sync();
    });
    const end = (e: PointerEvent) => { if (this.pointers.delete(e.pointerId)) this.sync(); };
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    addEventListener("blur", () => { this.pointers.clear(); this.sync(); });
  }

  private sync() {
    const held = new Set(this.pointers.values());
    for (const b of this.buttons) b.classList.toggle("pressed", held.has(b.dataset.control!));
  }

  input(): Input {
    const held = new Set(this.pointers.values());
    return { rot: (held.has("cw") ? 1 : 0) - (held.has("ccw") ? 1 : 0), fire: held.has("fire") };
  }
}

export const combine = (a: Input, b: Input): Input =>
  ({ rot: Math.max(-1, Math.min(1, a.rot + b.rot)), fire: a.fire || b.fire });
