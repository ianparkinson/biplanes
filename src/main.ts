// Biplanes: a two-player 8-bit style dogfight. Wires the simulation to the page:
// input, a fixed-step game loop, rendering, sound, menus and online play.
//
// Three roles:
//   local  - this device runs the game (vs CPU, or two players on one keyboard)
//   host   - this device runs the game for an online match and streams it to the guest
//   guest  - this device sends its inputs to the host and draws what the host sends back
import "./style.css";
import { SIM_DT } from "./config";
import { createGame, GameEvent, GameView, Input, NO_INPUT, startGame, step } from "./sim";
import { cpuInput } from "./cpu";
import { render, RenderOptions } from "./render";
import { Effects } from "./effects";
import { Sfx } from "./audio";
import { KEYS, Keyboard, TouchControls, combine } from "./input";
import { hidePanel, MenuItem, setMenu, showPanel } from "./ui";
import { clearJoinFromUrl, codeFromUrl, GuestLink, HostLink, joinUrl, padUrl, Snapshot, SnapshotBuffer, encodeSnapshot, TIMEOUT } from "./net";
import { castToTv, loadCastSender } from "./cast";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let game = createGame();
const effects = new Effects();
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

// Phones: go fullscreen and landscape where the browser allows it (Android Chrome; not iPhone Safari).
function goFullscreen() {
  const el = document.documentElement;
  if (!touchMode || document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: "hide" })
    .then(() => (screen.orientation as any)?.lock?.("landscape"))
    .catch(() => {});
}

const now = () => performance.now() / 1000;

// ---- Roles ---------------------------------------------------------------------

type Phase = "starting" | "waiting" | "connected" | "lost" | "error";
let role: "local" | "host" | "guest" = "local";
let phase: Phase = "connected";

// Host state
let hostLink: HostLink | null = null;
let remoteInput: Input = NO_INPUT, remoteSeq = -1;
let recentEvents: Snapshot["events"] = [];
let eventId = 0, lastSnapshotAt = 0;

// Guest state
let guestLink: GuestLink | null = null;
const snapshots = new SnapshotBuffer();
let inputSeq = 0, phaseSince = 0, lastRetry = 0;

function setPhase(p: Phase) { phase = p; phaseSince = now(); }

function teardown() {
  hostLink?.close(); guestLink?.close();
  hostLink = guestLink = null;
  role = "local"; setPhase("connected");
  game = createGame(); snapshots.reset(); effects.clear();
}

function leaveOnline() { teardown(); hidePanel(); clearJoinFromUrl(); }

function failed(message: string) {
  setPhase("error");
  showPanel({ title: "CONNECTION PROBLEM", text: message, buttons: [{ label: "BACK TO MENU", action: leaveOnline, primary: true }] });
}

function hostOnline() {
  teardown(); clearJoinFromUrl();
  role = "host"; setPhase("starting");
  game = createGame();
  remoteInput = NO_INPUT; remoteSeq = -1; recentEvents = [];
  showPanel({ title: "PLAY A FRIEND", text: "Setting up a game…", buttons: [{ label: "CANCEL", action: leaveOnline }] });
  hostLink = new HostLink({
    onReady: () => { setPhase("waiting"); showInvite(); },
    onOpen: () => {},
    onClose: () => {},
    onError: failed,
    onMessage: msg => {
      if (msg.t === "input") {
        if (msg.seq > remoteSeq) { remoteSeq = msg.seq; remoteInput = { rot: msg.rot, fire: msg.fire }; }
      } else if (msg.t === "start" && game.mode !== "playing") {
        startGame(game, false);
      }
    },
  });
}

function showInvite() {
  const lost = phase === "lost";
  showPanel({
    title: lost ? "CONNECTION LOST" : "PLAY A FRIEND",
    text: lost ? "Your friend dropped out. The game will carry on if they reopen the link."
               : "Get your friend to scan this code, or send them the link. The game starts once they join.",
    url: joinUrl(hostLink!.code),
    buttons: [{ label: lost ? "QUIT GAME" : "CANCEL", action: leaveOnline }],
  });
}

function inviteFromUrl(code: string) {
  showPanel({
    title: "JOIN GAME",
    text: "You've been invited to a Biplanes dogfight.",
    buttons: [
      { label: "JOIN", primary: true, action: () => { sfx.init(); goFullscreen(); joinOnline(code); } },
      { label: "NO THANKS", action: leaveOnline },
    ],
  });
}

function joinOnline(code: string) {
  teardown();
  role = "guest"; setPhase("starting");
  lastRetry = now();
  showPanel({ title: "JOINING…", text: `Connecting to game ${code}.`, buttons: [{ label: "CANCEL", action: leaveOnline }] });
  guestLink = new GuestLink(code, {
    onOpen: () => {},
    onClose: () => {},
    onError: failed,
    onMessage: msg => { if (msg.t === "state") snapshots.push(msg, now()); },
  });
}

// Checks link health once a frame and moves between phases.
function watchLink(t: number) {
  if (role === "host" && hostLink && phase !== "starting" && phase !== "error") {
    const present = hostLink.open && t - hostLink.lastHeard < TIMEOUT;
    if (present && phase !== "connected") { setPhase("connected"); hidePanel(); }
    else if (!present && phase === "connected") { setPhase("lost"); remoteInput = NO_INPUT; showInvite(); }
  }
  if (role === "guest" && guestLink && phase !== "error") {
    const present = guestLink.open && t - guestLink.lastHeard < TIMEOUT && !snapshots.empty;
    if (present && phase !== "connected") { setPhase("connected"); hidePanel(); }
    else if (!present && phase === "connected") {
      setPhase("lost");
      showPanel({ title: "CONNECTION LOST", text: "Lost touch with the host. Trying to reconnect…",
        buttons: [{ label: "QUIT GAME", action: leaveOnline }] });
    } else if (phase === "starting" && t - phaseSince > 20) {
      failed("Couldn't connect to that game. Your networks may be blocking a direct connection; try again, or both use Wi-Fi.");
    } else if (phase === "lost" && !guestLink.open && t - lastRetry > 5) {
      lastRetry = t; guestLink.connect();
    }
  }
}

// ---- Menus and keys ------------------------------------------------------------

function startLocal(vsCpu: boolean) { goFullscreen(); startGame(game, vsCpu); }

function startOnline() {
  goFullscreen();
  if (role === "host") startGame(game, false);
  else guestLink?.send({ t: "start" });
}

function toggleMute() { sfx.toggleMute(); }

// Couch play: start the TV app on a Chromecast, then turn this phone into a controller.
let canCast = false;
void loadCastSender().then(ok => { canCast = ok; });

function playOnTv() {
  showPanel({ title: "PLAY ON TV", text: "Pick your Chromecast, then wait for the game to start on the TV…",
    buttons: [{ label: "CANCEL", action: hidePanel }] });
  castToTv()
    .then(code => { location.href = padUrl(code); })
    .catch((e: Error) => {
      if (e.message === "cancelled") hidePanel();
      else showPanel({ title: "PLAY ON TV", text: e.message, buttons: [{ label: "OK", action: hidePanel, primary: true }] });
    });
}

function menuItems(mode: GameView["mode"]): MenuItem[] | null {
  if (mode === "playing") return null;
  const sound: MenuItem = { label: sfx.muted ? "SOUND OFF" : "SOUND ON", key: "M", action: toggleMute, small: true };
  if (role === "local") return [
    { label: "ONE PLAYER (VS CPU)", key: "1", action: () => startLocal(true) },
    { label: "TWO PLAYERS", key: "2", action: () => startLocal(false), keyboardOnly: true },
    { label: "PLAY A FRIEND ONLINE", key: "3", action: hostOnline },
    ...(canCast ? [{ label: "PLAY ON TV", key: "4", action: playOnTv }] : []),
    sound,
  ];
  return [
    { label: mode === "over" ? "PLAY AGAIN" : "START GAME", key: "1", action: startOnline },
    { label: "LEAVE", action: leaveOnline, small: true },
    sound,
  ];
}

// Audio can only start from a user gesture; iOS wants it on the end of a touch.
addEventListener("pointerdown", e => {
  sfx.init();
  if (e.pointerType === "touch" && !touchMode) setTouchMode(true);
});
addEventListener("pointerup", () => sfx.init());
addEventListener("click", () => sfx.init());
addEventListener("contextmenu", e => { if (touchMode) e.preventDefault(); });
addEventListener("keydown", e => {
  sfx.init();
  if (e.code === "KeyM") toggleMute();
  const mode = role === "guest" ? snapshots.view(now())?.mode : game.mode;
  if (mode === "playing" || !document.getElementById("panel")!.hidden) return;
  const digit = e.code.replace(/^(Digit|Numpad)/, "");
  if (role === "local") {
    if (digit === "1") startLocal(true);
    if (digit === "2") startLocal(false);
    if (digit === "3") hostOnline();
    if (digit === "4" && canCast) playOnTv();
  } else if (digit === "1") startOnline();
});

// ---- Main loop -----------------------------------------------------------------

function localInput(): Input { return combine(keyboard.input(KEYS[0]), touch.input()); }

function renderOptions(): RenderOptions {
  const controls = touchMode ? "touch" : "keys";
  if (role === "host") return { controls, labels: ["YOU", "FRIEND"], me: 0 };
  if (role === "guest") return { controls, labels: ["FRIEND", "YOU"], me: 1 };
  return game.vsCpu ? { controls, labels: ["P1", "CPU"], me: 0 } : { controls, labels: ["P1", "P2"] };
}

let last = now(), acc = 0;
function frame() {
  const t = now(), dt = Math.min(0.25, t - last);
  last = t;
  watchLink(t);
  let view: GameView = game;
  const events: GameEvent[] = [];

  if (role === "guest") {
    // Either keyboard layout or the touch buttons fly the guest's plane.
    const inp = combine(combine(keyboard.input(KEYS[0]), keyboard.input(KEYS[1])), touch.input());
    guestLink?.send({ t: "input", seq: ++inputSeq, rot: inp.rot, fire: inp.fire });
    view = snapshots.view(t) ?? game;
    events.push(...snapshots.takeEvents(t));
  } else {
    // The host holds the game still while its guest is missing.
    const running = role === "local" || phase === "connected";
    acc = running ? acc + dt : 0;
    while (acc >= SIM_DT) {
      const p1 = localInput();
      const p2 = role === "host" ? remoteInput : game.vsCpu ? cpuInput(game, 1) : keyboard.input(KEYS[1]);
      step(game, [p1, p2], SIM_DT);
      acc -= SIM_DT;
      for (const e of game.events) { events.push(e); recentEvents.push([++eventId, game.time, e]); }
      game.events.length = 0;
    }
    if (role === "host" && t - lastSnapshotAt >= 1 / 30) {
      lastSnapshotAt = t;
      recentEvents = recentEvents.filter(ev => ev[1] > game.time - 1);
      hostLink?.send(encodeSnapshot(game, recentEvents));
    } else if (role === "local") recentEvents.length = 0;
  }

  for (const e of events) { sfx.play(e); effects.event(e); }
  effects.update(view, dt);
  render(ctx, view, effects.particles, renderOptions());
  view.planes.forEach((p, i) =>
    sfx.engine(i, view.mode === "playing" && (p.state === "ground" || p.state === "air"), p.speed, p.x));
  setMenu(role !== "local" && phase !== "connected" ? null : menuItems(view.mode));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const invited = codeFromUrl();
if (invited) inviteFromUrl(invited);
