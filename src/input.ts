// Local input sources. Each produces a sim Input for one plane.
import { Input } from "./sim"

interface KeyBindings {
  anticlockwise: string
  clockwise: string
  fire: string
}

// Indexed by player: P1 on the left of the keyboard, P2 on the arrow keys.
export const KEYS: KeyBindings[] = [
  { anticlockwise: "KeyA", clockwise: "KeyD", fire: "KeyS" },
  { anticlockwise: "ArrowLeft", clockwise: "ArrowRight", fire: "ArrowDown" },
]

export class Keyboard {
  private held = new Set<string>()

  constructor() {
    addEventListener("keydown", (event) => {
      // Stop the arrow keys and space scrolling the page.
      if (event.code.startsWith("Arrow") || event.code === "Space")
        event.preventDefault()
      this.held.add(event.code)
    })
    addEventListener("keyup", (event) => this.held.delete(event.code))
    // Keys released while the window is unfocused never send keyup.
    addEventListener("blur", () => this.held.clear())
  }

  input(keys: KeyBindings): Input {
    return {
      turn:
        (this.held.has(keys.clockwise) ? 1 : 0) -
        (this.held.has(keys.anticlockwise) ? 1 : 0),
      fire: this.held.has(keys.fire),
    }
  }
}

// On-screen buttons marked with data-control="ccw" | "cw" | "fire". Each finger is
// tracked separately and can slide between buttons without lifting.
export class TouchControls {
  private controlByPointer = new Map<number, string | null>()
  private buttons: HTMLElement[]

  constructor(root: HTMLElement) {
    this.buttons = [...root.querySelectorAll<HTMLElement>("[data-control]")]
    // Which control (if any) is under a pointer right now.
    function controlAt(event: PointerEvent) {
      return (
        document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-control]")?.dataset.control ?? null
      )
    }
    root.addEventListener("pointerdown", (event) => {
      const control = controlAt(event)
      if (!control) return
      event.preventDefault()
      this.controlByPointer.set(event.pointerId, control)
      this.showPressed()
    })
    // Moves are watched on the whole window so a finger can slide off a button.
    addEventListener("pointermove", (event) => {
      if (!this.controlByPointer.has(event.pointerId)) return
      this.controlByPointer.set(event.pointerId, controlAt(event))
      this.showPressed()
    })
    const release = (event: PointerEvent) => {
      if (this.controlByPointer.delete(event.pointerId)) this.showPressed()
    }
    addEventListener("pointerup", release)
    addEventListener("pointercancel", release)
    addEventListener("blur", () => {
      this.controlByPointer.clear()
      this.showPressed()
    })
  }

  // Highlights the buttons that are currently held.
  private showPressed() {
    const held = new Set(this.controlByPointer.values())
    for (const button of this.buttons)
      button.classList.toggle("pressed", held.has(button.dataset.control!))
  }

  input(): Input {
    const held = new Set(this.controlByPointer.values())
    return {
      turn: (held.has("cw") ? 1 : 0) - (held.has("ccw") ? 1 : 0),
      fire: held.has("fire"),
    }
  }
}

// Merges two input sources (e.g. keyboard and touch) for the same plane.
export function combine(a: Input, b: Input): Input {
  return {
    turn: Math.max(-1, Math.min(1, a.turn + b.turn)),
    fire: a.fire || b.fire,
  }
}
