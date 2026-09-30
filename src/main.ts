// Biplanes: a two-player 8-bit style dogfight. Wires the simulation to the page:
// input, a fixed-step game loop, rendering, sound and the menus.
import "./style.css";
import { SIM_DT } from "./config";
import { createGame, isAlive, startGame, step } from "./sim";
import { cpuInput } from "./cpu";
import { render } from "./render";
import { Sfx } from "./audio";
import { KEYS, Keyboard, TouchControls, combine } from "./input";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const menu = document.getElementById("menu")!;
const muteLabel = document.getElementById("mute-label")!;

const game = createGame();
const sfx = new Sfx();
const keyboard = new Keyboard();
const touch = new TouchControls(document.getElementById("controls")!);

// Show the touch layout on phones and tablets, or as soon as the screen is touched.
let touchMode = false;
function setTouchMode(on: boolean) {
  touchMode = on;
  document.documentElement.classList.toggle("touch", on);
}
setTouchMode(matchMedia("(pointer: coarse)").matches);

function toggleMute() {
  sfx.toggleMute();
  muteLabel.textContent = sfx.muted ? "SOUND OFF" : "SOUND ON";
}

// Phones: go fullscreen and landscape where the browser allows it (Android Chrome; not iPhone Safari).
function goFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: "hide" })
    .then(() => (screen.orientation as any)?.lock?.("landscape"))
    .catch(() => {});
}

function begin(vsCpu: boolean) {
  if (touchMode) goFullscreen();
  startGame(game, vsCpu);
}

// Audio can only start from a user gesture; iOS wants it on the end of a touch.
addEventListener("pointerdown", e => {
  sfx.init();
  if (e.pointerType === "touch" && !touchMode) setTouchMode(true);
});
addEventListener("pointerup", () => sfx.init());
addEventListener("contextmenu", e => { if (touchMode) e.preventDefault(); });
addEventListener("keydown", e => {
  sfx.init();
  if (e.code === "KeyM") toggleMute();
  if (game.mode !== "playing") { // title and game-over screens both offer the mode choice
    if (e.code === "Digit1" || e.code === "Numpad1") begin(true);
    if (e.code === "Digit2" || e.code === "Numpad2") begin(false);
  }
});
for (const b of menu.querySelectorAll<HTMLElement>("[data-start]")) {
  b.addEventListener("click", () => { sfx.init(); begin(b.dataset.start === "cpu"); });
}
document.getElementById("mute")!.addEventListener("click", () => { sfx.init(); toggleMute(); });

let last = performance.now(), acc = 0;
function frame(now: number) {
  acc += Math.min(0.25, (now - last) / 1000); last = now;
  while (acc >= SIM_DT) {
    const p1 = combine(keyboard.input(KEYS[0]), touch.input());
    const p2 = game.vsCpu ? cpuInput(game, 1) : keyboard.input(KEYS[1]);
    step(game, [p1, p2], SIM_DT);
    acc -= SIM_DT;
  }
  for (const e of game.events) sfx.play(e);
  game.events.length = 0;

  render(ctx, game, { touch: touchMode });
  game.planes.forEach((p, i) => sfx.engine(i, game.mode === "playing" && isAlive(p), p.speed, p.x));
  menu.hidden = game.mode === "playing";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
