// Biplanes: a two-player 8-bit style dogfight. Wires the simulation to the page:
// input, a fixed-step game loop, rendering, sound, menus and online play.
//
// Three roles:
//   local  - this device runs the game (vs CPU, or two players on one keyboard)
//   host   - this device runs the game for an online match and streams it to the guest
//   guest  - this device sends its inputs to the host and draws what the host sends back
import "./style.css"

import { Sfx } from "./audio"
import { castToTv, loadCastSender } from "./cast"
import { SIM_DT } from "./config"
import { cpuInput } from "./cpu"
import { Effects } from "./effects"
import { KEYS, Keyboard, TouchControls, combine } from "./input"
import {
  GuestLink,
  HostLink,
  SnapshotBuffer,
  TIMEOUT,
  TimedEvent,
  clearJoinFromUrl,
  codeFromUrl,
  encodeSnapshot,
  joinUrl,
  padUrl,
} from "./net"
import { RenderOptions, render } from "./render"
import {
  GameEvent,
  GameView,
  Input,
  NO_INPUT,
  createGame,
  startGame,
  step,
} from "./sim"
import { MenuItem, hidePanel, setMenu, showPanel } from "./ui"

const SNAPSHOT_INTERVAL = 1 / 30 // seconds between snapshots sent to the guest
const EVENT_REPEAT_WINDOW = 1 // seconds that each event is repeated in snapshots
const CONNECT_TIMEOUT = 20 // seconds for a guest's first connection
const RETRY_INTERVAL = 5 // seconds between a guest's reconnection attempts
const MAX_FRAME_TIME = 0.25 // cap on catch-up after the tab was in the background

const canvas = document.getElementById("game") as HTMLCanvasElement
const ctx = canvas.getContext("2d")!

let game = createGame()
const effects = new Effects()
const sfx = new Sfx()
const keyboard = new Keyboard()
const touch = new TouchControls(document.getElementById("controls")!)

function now() {
  return performance.now() / 1000
}

// Show the touch layout on phones and tablets, or as soon as the screen is touched.
let touchMode = false
function setTouchMode(on: boolean) {
  touchMode = on
  document.documentElement.classList.toggle("touch", on)
}
setTouchMode(matchMedia("(pointer: coarse)").matches)

// Phones: go fullscreen and landscape where the browser allows it (Android Chrome; not iPhone Safari).
function goFullscreen() {
  const page = document.documentElement
  if (!touchMode || document.fullscreenElement || !page.requestFullscreen)
    return
  page
    .requestFullscreen({ navigationUI: "hide" })
    .then(() => (screen.orientation as any)?.lock?.("landscape"))
    .catch(() => {})
}

// ---- Roles ---------------------------------------------------------------------

// Where an online game's connection is up to. Local play stays "connected".
type Phase = "starting" | "waiting" | "connected" | "lost" | "error"
let role: "local" | "host" | "guest" = "local"
let phase: Phase = "connected"
let phaseSince = 0

// Host state
let hostLink: HostLink | null = null
let guestInput: Input = NO_INPUT
let guestInputSeq = -1 // newest input seen; the channel is unordered
let recentEvents: TimedEvent[] = []
let lastEventId = 0
let lastSnapshotAt = 0

// Guest state
let guestLink: GuestLink | null = null
const snapshots = new SnapshotBuffer()
let inputSeq = 0
let lastRetry = 0

function setPhase(newPhase: Phase) {
  phase = newPhase
  phaseSince = now()
}

// Back to a fresh local game, closing any connection.
function teardown() {
  hostLink?.close()
  guestLink?.close()
  hostLink = guestLink = null
  role = "local"
  setPhase("connected")
  game = createGame()
  snapshots.reset()
  effects.clear()
}

function leaveOnline() {
  teardown()
  hidePanel()
  clearJoinFromUrl()
}

function connectionFailed(message: string) {
  setPhase("error")
  showPanel({
    title: "CONNECTION PROBLEM",
    text: message,
    buttons: [{ label: "BACK TO MENU", action: leaveOnline, primary: true }],
  })
}

function hostOnline() {
  teardown()
  clearJoinFromUrl()
  role = "host"
  setPhase("starting")
  game = createGame()
  guestInput = NO_INPUT
  guestInputSeq = -1
  recentEvents = []
  showPanel({
    title: "PLAY A FRIEND",
    text: "Setting up a game…",
    buttons: [{ label: "CANCEL", action: leaveOnline }],
  })
  hostLink = new HostLink({
    onReady: () => {
      setPhase("waiting")
      showInvite()
    },
    onOpen: () => {},
    onClose: () => {},
    onError: connectionFailed,
    onMessage: (msg) => {
      if (msg.type === "input") {
        if (msg.seq > guestInputSeq) {
          guestInputSeq = msg.seq
          guestInput = { turn: msg.turn, fire: msg.fire }
        }
      } else if (msg.type === "start" && game.mode !== "playing") {
        startGame(game, false)
      }
    },
  })
}

function showInvite() {
  const lost = phase === "lost"
  showPanel({
    title: lost ? "CONNECTION LOST" : "PLAY A FRIEND",
    text: lost
      ? "Your friend dropped out. The game will carry on if they reopen the link."
      : "Get your friend to scan this code, or send them the link. The game starts once they join.",
    url: joinUrl(hostLink!.code),
    buttons: [{ label: lost ? "QUIT GAME" : "CANCEL", action: leaveOnline }],
  })
}

// Opened from an invite link: ask first, so joining happens on a tap (which
// browsers require before playing sound or going fullscreen).
function inviteFromUrl(code: string) {
  showPanel({
    title: "JOIN GAME",
    text: "You've been invited to a Biplanes dogfight.",
    buttons: [
      {
        label: "JOIN",
        primary: true,
        action: () => {
          sfx.init()
          goFullscreen()
          joinOnline(code)
        },
      },
      { label: "NO THANKS", action: leaveOnline },
    ],
  })
}

function joinOnline(code: string) {
  teardown()
  role = "guest"
  setPhase("starting")
  lastRetry = now()
  showPanel({
    title: "JOINING…",
    text: `Connecting to game ${code}.`,
    buttons: [{ label: "CANCEL", action: leaveOnline }],
  })
  guestLink = new GuestLink(code, {
    onOpen: () => {},
    onClose: () => {},
    onError: connectionFailed,
    onMessage: (msg) => {
      if (msg.type === "state") snapshots.push(msg, now())
    },
  })
}

// Checks the connection once a frame and moves between phases. A link counts as
// present only while messages keep arriving: a dropped phone often never closes
// its connection cleanly.
function watchLink(time: number) {
  if (
    role === "host" &&
    hostLink &&
    phase !== "starting" &&
    phase !== "error"
  ) {
    const present = hostLink.open && time - hostLink.lastHeard < TIMEOUT
    if (present && phase !== "connected") {
      setPhase("connected")
      hidePanel()
    } else if (!present && phase === "connected") {
      setPhase("lost")
      guestInput = NO_INPUT
      showInvite()
    }
  }
  if (role === "guest" && guestLink && phase !== "error") {
    const present =
      guestLink.open && time - guestLink.lastHeard < TIMEOUT && !snapshots.empty
    if (present && phase !== "connected") {
      setPhase("connected")
      hidePanel()
    } else if (!present && phase === "connected") {
      setPhase("lost")
      showPanel({
        title: "CONNECTION LOST",
        text: "Lost touch with the host. Trying to reconnect…",
        buttons: [{ label: "QUIT GAME", action: leaveOnline }],
      })
    } else if (phase === "starting" && time - phaseSince > CONNECT_TIMEOUT) {
      connectionFailed(
        "Couldn't connect to that game. Your networks may be blocking a direct connection; try again, or both use Wi-Fi.",
      )
    } else if (
      phase === "lost" &&
      !guestLink.open &&
      time - lastRetry > RETRY_INTERVAL
    ) {
      lastRetry = time
      guestLink.connect()
    }
  }
}

// ---- Menus and keys ------------------------------------------------------------

function startLocal(vsCpu: boolean) {
  goFullscreen()
  startGame(game, vsCpu)
}

function startOnline() {
  goFullscreen()
  if (role === "host") startGame(game, false)
  else guestLink?.send({ type: "start" })
}

function toggleMute() {
  sfx.toggleMute()
}

// Couch play: start the TV app on a Chromecast, then turn this phone into a controller.
let canCast = false
void loadCastSender().then((available) => {
  canCast = available
})

function playOnTv() {
  showPanel({
    title: "PLAY ON TV",
    text: "Pick your Chromecast, then wait for the game to start on the TV…",
    buttons: [{ label: "CANCEL", action: hidePanel }],
  })
  castToTv()
    .then((code) => {
      location.href = padUrl(code)
    })
    .catch((error: Error) => {
      if (error.message === "cancelled") hidePanel()
      else
        showPanel({
          title: "PLAY ON TV",
          text: error.message,
          buttons: [{ label: "OK", action: hidePanel, primary: true }],
        })
    })
}

function menuItems(mode: GameView["mode"]): MenuItem[] | null {
  if (mode === "playing") return null
  const sound: MenuItem = {
    label: sfx.muted ? "SOUND OFF" : "SOUND ON",
    key: "M",
    action: toggleMute,
    small: true,
  }
  if (role === "local")
    return [
      {
        label: "ONE PLAYER (VS CPU)",
        key: "1",
        action: () => startLocal(true),
      },
      {
        label: "TWO PLAYERS",
        key: "2",
        action: () => startLocal(false),
        keyboardOnly: true,
      },
      { label: "PLAY A FRIEND ONLINE", key: "3", action: hostOnline },
      ...(canCast ? [{ label: "PLAY ON TV", key: "4", action: playOnTv }] : []),
      sound,
    ]
  return [
    {
      label: mode === "over" ? "PLAY AGAIN" : "START GAME",
      key: "1",
      action: startOnline,
    },
    { label: "LEAVE", action: leaveOnline, small: true },
    sound,
  ]
}

// Audio can only start from a user gesture; iOS wants it on the end of a touch.
addEventListener("pointerdown", (event) => {
  sfx.init()
  if (event.pointerType === "touch" && !touchMode) setTouchMode(true)
})
addEventListener("pointerup", () => sfx.init())
addEventListener("click", () => sfx.init())
addEventListener("contextmenu", (event) => {
  if (touchMode) event.preventDefault() // no long-press menu on the buttons
})
// Menu shortcuts; the in-game keys are read by the Keyboard class.
addEventListener("keydown", (event) => {
  sfx.init()
  if (event.code === "KeyM") toggleMute()
  const mode = role === "guest" ? snapshots.view(now())?.mode : game.mode
  if (mode === "playing" || !document.getElementById("panel")!.hidden) return
  const digit = event.code.replace(/^(Digit|Numpad)/, "")
  if (role === "local") {
    if (digit === "1") startLocal(true)
    if (digit === "2") startLocal(false)
    if (digit === "3") hostOnline()
    if (digit === "4" && canCast) playOnTv()
  } else if (digit === "1") startOnline()
})

// ---- Main loop -----------------------------------------------------------------

function renderOptions(): RenderOptions {
  const controls = touchMode ? "touch" : "keys"
  if (role === "host") return { controls, labels: ["YOU", "FRIEND"], me: 0 }
  if (role === "guest") return { controls, labels: ["FRIEND", "YOU"], me: 1 }
  return game.vsCpu
    ? { controls, labels: ["P1", "CPU"], me: 0 }
    : { controls, labels: ["P1", "P2"] }
}

// Guest: send our input to the host, and work out what to draw from its snapshots.
function guestFrame(time: number): [GameView, GameEvent[]] {
  // Either keyboard layout or the touch buttons fly the guest's plane.
  const input = combine(
    combine(keyboard.input(KEYS[0]), keyboard.input(KEYS[1])),
    touch.input(),
  )
  guestLink?.send({
    type: "input",
    seq: ++inputSeq,
    turn: input.turn,
    fire: input.fire,
  })
  return [snapshots.view(time) ?? game, snapshots.takeEvents(time)]
}

// Local or host: advance the simulation in fixed steps, however long the frame
// took. The remainder carries over to the next frame.
let stepTimeOwed = 0
function simulationFrame(time: number, frameTime: number): GameEvent[] {
  const events: GameEvent[] = []
  // The host holds the game still while its guest is missing.
  const running = role === "local" || phase === "connected"
  stepTimeOwed = running ? stepTimeOwed + frameTime : 0
  while (stepTimeOwed >= SIM_DT) {
    const redInput = combine(keyboard.input(KEYS[0]), touch.input())
    const yellowInput =
      role === "host"
        ? guestInput
        : game.vsCpu
          ? cpuInput(game, 1)
          : keyboard.input(KEYS[1])
    step(game, [redInput, yellowInput], SIM_DT)
    stepTimeOwed -= SIM_DT
    for (const event of game.events) {
      events.push(event)
      recentEvents.push([++lastEventId, game.time, event])
    }
    game.events.length = 0
  }

  if (role === "host" && time - lastSnapshotAt >= SNAPSHOT_INTERVAL) {
    lastSnapshotAt = time
    recentEvents = recentEvents.filter(
      ([, eventTime]) => eventTime > game.time - EVENT_REPEAT_WINDOW,
    )
    hostLink?.send(encodeSnapshot(game, recentEvents))
  } else if (role === "local") recentEvents.length = 0
  return events
}

let lastFrameAt = now()
function frame() {
  const time = now()
  const frameTime = Math.min(MAX_FRAME_TIME, time - lastFrameAt)
  lastFrameAt = time
  watchLink(time)

  let view: GameView = game
  let events: GameEvent[]
  if (role === "guest") [view, events] = guestFrame(time)
  else events = simulationFrame(time, frameTime)

  for (const event of events) {
    sfx.play(event)
    effects.event(event)
  }
  effects.update(view, frameTime)
  render(ctx, view, effects.particles, renderOptions())
  view.planes.forEach((plane, i) =>
    sfx.engine(
      i,
      view.mode === "playing" &&
        (plane.state === "ground" || plane.state === "air"),
      plane.speed,
      plane.x,
    ),
  )
  setMenu(
    role !== "local" && phase !== "connected" ? null : menuItems(view.mode),
  )
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

const invitedCode = codeFromUrl()
if (invitedCode) inviteFromUrl(invitedCode)
