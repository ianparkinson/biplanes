// A phone used as a controller for a game running on a TV.
import "./style.css";
import "./pad.css";
import { MAX_DEATHS, PLANE_COLORS } from "./config";
import { TouchControls } from "./input";
import { codeFromUrl, GuestLink, TIMEOUT } from "./net";
import { PadHello, PadMsg, TvMsg } from "./couch";

const $ = (id: string) => document.getElementById(id)!;
const now = () => performance.now() / 1000;
const touch = new TouchControls($("controls"));

// A per-phone id, so reconnecting gets the same plane back.
function clientId() {
  try {
    let id = localStorage.getItem("biplanes-pad-id");
    if (!id) { id = Math.random().toString(36).slice(2); localStorage.setItem("biplanes-pad-id", id); }
    return id;
  } catch { return Math.random().toString(36).slice(2); }
}

// Keep the screen on while holding the phone as a controller.
let wakeLock: any = null;
async function keepAwake() {
  try { if (!wakeLock && document.visibilityState === "visible") wakeLock = await (navigator as any).wakeLock?.request("screen"); }
  catch { /* not supported, or refused */ }
  wakeLock?.addEventListener?.("release", () => { wakeLock = null; });
}
document.addEventListener("visibilitychange", keepAwake);

function goFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: "hide" })
    .then(() => (screen.orientation as any)?.lock?.("landscape"))
    .catch(() => {});
}
addEventListener("pointerdown", () => { goFullscreen(); void keepAwake(); });
addEventListener("contextmenu", e => e.preventDefault());

// ---- Connection ----------------------------------------------------------------

let status: Extract<TvMsg, { t: "pad" }> | null = null;
let lastN = 0, seq = 0, lastRetry = 0, full = false, error = "";

const code = codeFromUrl("code");
const link = code ? new GuestLink<TvMsg, PadMsg>(code, {
  onOpen: () => {},
  onClose: () => {},
  onError: message => { error = message; },
  onMessage: msg => {
    if (msg.t === "full") { full = true; return; }
    if (msg.n <= lastN) return; // stale: the channel is unordered
    lastN = msg.n;
    const hit = status && status.slot === msg.slot && msg.deaths[msg.slot] > status.deaths[msg.slot];
    if (hit) navigator.vibrate?.(250);
    status = msg;
  },
}, { kind: "pad", id: clientId() } satisfies PadHello) : null;

$("start").addEventListener("click", () => link?.send({ t: "start" }));
$("leave").addEventListener("click", () => { link?.close(); location.href = "./"; });

// ---- Display -------------------------------------------------------------------

let shown = "";
function show(badge: string, color: string, lives: string, text: string, canStart: boolean) {
  const sig = [badge, color, lives, text, canStart].join("|");
  if (sig === shown) return;
  shown = sig;
  $("badge").textContent = badge;
  $("badge").style.color = color;
  $("lives").textContent = lives;
  $("lives").style.color = color;
  $("status").textContent = text;
  $("start").hidden = !canStart;
  $("start").textContent = status?.mode === "over" ? "PLAY AGAIN" : "START";
}

function update(t: number) {
  const connected = !!link?.open && t - link.lastHeard < TIMEOUT && !!status;
  if (!code) return show("BIPLANES", "#f5d020", "", "This link is missing its game code. Scan the code on the TV again.", false);
  if (full) return show("GAME FULL", "#fff", "", "Two phones are already playing on this TV.", false);
  if (error && !connected) return show("CAN'T CONNECT", "#e8402a", "", error, false);
  if (!connected) {
    if (link && !link.open && t - lastRetry > 5) { lastRetry = t; link.connect(); }
    return show("BIPLANES", "#f5d020", "", status ? "Lost the TV. Reconnecting…" : "Connecting to the TV…", false);
  }
  const s = status!, me = s.slot, other = 1 - me;
  const color = PLANE_COLORS[me];
  const lives = "■".repeat(Math.max(0, MAX_DEATHS - s.deaths[me]));
  const vs = s.players[other] ? `P${other + 1}` : "the CPU";
  if (s.mode === "playing") {
    return show(`PLAYER ${me + 1}`, color, lives, s.paused ? "Paused: waiting for the other player to reconnect…" : `Dogfight ${vs}!`, false);
  }
  if (s.mode === "over") {
    const [a, b] = s.deaths;
    const result = a === b ? "It's a draw!" : (a < b) === (me === 0) ? "You win!" : "You lose!";
    return show(`PLAYER ${me + 1}`, color, lives, `${result} Press PLAY AGAIN for a rematch.`, true);
  }
  const plane = `You're the ${me ? "yellow" : "red"} plane.`;
  return show(`PLAYER ${me + 1}`, color, "", s.players[other]
    ? `${plane} Press START when you're both ready.`
    : `${plane} Press START to play the CPU, or get a friend to scan the code on the TV.`, true);
}

function tick() {
  if (link?.open) {
    const inp = touch.input();
    link.send({ t: "input", seq: ++seq, rot: inp.rot, fire: inp.fire });
  }
  update(now());
}
// Send every frame for responsiveness, plus a timer that keeps the TV hearing
// from us when the browser throttles animation frames.
function frame() { tick(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
setInterval(tick, 250);
