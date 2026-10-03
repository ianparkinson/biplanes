// A phone used as a controller for a game running on a TV.
import "./style.css"
import "./pad.css"

import { MAX_DEATHS, PLANE_COLORS } from "./config"
import { PadHello, PadMsg, TvMsg } from "./couch"
import { TouchControls } from "./input"
import { GuestLink, TIMEOUT, codeFromUrl } from "./net"

type Status = Extract<TvMsg, { type: "pad" }>

const RETRY_INTERVAL = 5 // seconds between reconnection attempts
const HEARTBEAT_INTERVAL = 250 // ms; see the bottom of the file
const HIT_VIBRATION = 250 // ms

function element(id: string) {
  return document.getElementById(id)!
}
function now() {
  return performance.now() / 1000
}

const touch = new TouchControls(element("controls"))

// A per-phone id, so reconnecting gets the same plane back.
function phoneId() {
  const randomId = () => Math.random().toString(36).slice(2)
  try {
    let id = localStorage.getItem("biplanes-pad-id")
    if (!id) {
      id = randomId()
      localStorage.setItem("biplanes-pad-id", id)
    }
    return id
  } catch {
    return randomId() // storage blocked: still works, just without reclaiming a plane
  }
}

// Keep the screen on while holding the phone as a controller. The lock is
// released whenever the page is hidden, so it's re-requested on return.
let wakeLock: any = null
async function keepAwake() {
  try {
    if (!wakeLock && document.visibilityState === "visible")
      wakeLock = await (navigator as any).wakeLock?.request("screen")
  } catch {
    /* not supported, or refused */
  }
  wakeLock?.addEventListener?.("release", () => {
    wakeLock = null
  })
}
document.addEventListener("visibilitychange", keepAwake)

function goFullscreen() {
  const page = document.documentElement
  if (document.fullscreenElement || !page.requestFullscreen) return
  page
    .requestFullscreen({ navigationUI: "hide" })
    .then(() => (screen.orientation as any)?.lock?.("landscape"))
    .catch(() => {})
}
// Both need a user gesture, so try on every touch.
addEventListener("pointerdown", () => {
  goFullscreen()
  void keepAwake()
})
addEventListener("contextmenu", (event) => event.preventDefault())

// ---- Connection ----------------------------------------------------------------

let status: Status | null = null // latest status from the TV
let lastStatusSeq = 0
let inputSeq = 0
let lastRetry = 0
let gameFull = false
let connectionError = ""

// Vibrate when this phone's plane has just been shot down.
function vibrateIfHit(previous: Status | null, latest: Status) {
  const slot = latest.slot
  if (
    previous &&
    previous.slot === slot &&
    latest.deaths[slot] > previous.deaths[slot]
  )
    navigator.vibrate?.(HIT_VIBRATION)
}

const roomCode = codeFromUrl("code")
const link = roomCode
  ? new GuestLink<TvMsg, PadMsg>(
      roomCode,
      {
        onOpen: () => {},
        onClose: () => {},
        onError: (message) => {
          connectionError = message
        },
        onMessage: (msg) => {
          if (msg.type === "full") {
            gameFull = true
            return
          }
          if (msg.seq <= lastStatusSeq) return // stale: the channel is unordered
          lastStatusSeq = msg.seq
          vibrateIfHit(status, msg)
          status = msg
        },
      },
      { kind: "pad", id: phoneId() } satisfies PadHello,
    )
  : null

element("start").addEventListener("click", () => link?.send({ type: "start" }))
element("leave").addEventListener("click", () => {
  link?.close()
  location.href = "./"
})

// ---- Display -------------------------------------------------------------------

interface Screen {
  badge: string // big heading: "PLAYER 1", "GAME FULL"...
  color: string
  lives: string
  text: string
  canStart: boolean
}

// Updates the page, but only when something changed (this runs every frame).
let shownSignature = ""
function show(screen: Screen) {
  const signature = JSON.stringify(screen)
  if (signature === shownSignature) return
  shownSignature = signature
  element("badge").textContent = screen.badge
  element("badge").style.color = screen.color
  element("lives").textContent = screen.lives
  element("lives").style.color = screen.color
  element("status").textContent = screen.text
  element("start").hidden = !screen.canStart
  element("start").textContent =
    status?.mode === "over" ? "PLAY AGAIN" : "START"
}

function message(badge: string, color: string, text: string): Screen {
  return { badge, color, lives: "", text, canStart: false }
}

// What the screen should say, given the connection and the match.
function currentScreen(time: number): Screen {
  if (!roomCode)
    return message(
      "BIPLANES",
      "#f5d020",
      "This link is missing its game code. Scan the code on the TV again.",
    )
  if (gameFull)
    return message(
      "GAME FULL",
      "#fff",
      "Two phones are already playing on this TV.",
    )

  const connected = !!link?.open && time - link.lastHeard < TIMEOUT && !!status
  if (connectionError && !connected)
    return message("CAN'T CONNECT", "#e8402a", connectionError)
  if (!connected)
    return message(
      "BIPLANES",
      "#f5d020",
      status ? "Lost the TV. Reconnecting…" : "Connecting to the TV…",
    )

  const { slot: me, mode, paused, deaths, players } = status!
  const other = 1 - me
  const player = {
    badge: `PLAYER ${me + 1}`,
    color: PLANE_COLORS[me],
    lives: "■".repeat(Math.max(0, MAX_DEATHS - deaths[me])),
  }
  const opponent = players[other] ? `P${other + 1}` : "the CPU"

  if (mode === "playing")
    return {
      ...player,
      text: paused
        ? "Paused: waiting for the other player to reconnect…"
        : `Dogfight ${opponent}!`,
      canStart: false,
    }
  if (mode === "over") {
    const won = deaths[me] < deaths[other]
    const result =
      deaths[0] === deaths[1] ? "It's a draw!" : won ? "You win!" : "You lose!"
    return {
      ...player,
      text: `${result} Press PLAY AGAIN for a rematch.`,
      canStart: true,
    }
  }
  const plane = `You're the ${me ? "yellow" : "red"} plane.`
  return {
    ...player,
    lives: "",
    text: players[other]
      ? `${plane} Press START when you're both ready.`
      : `${plane} Press START to play the CPU, or get a friend to scan the code on the TV.`,
    canStart: true,
  }
}

// ---- Main loop -----------------------------------------------------------------

function tick() {
  const time = now()
  if (link?.open) {
    const input = touch.input()
    link.send({
      type: "input",
      seq: ++inputSeq,
      turn: input.turn,
      fire: input.fire,
    })
  } else if (
    link &&
    !gameFull &&
    !connectionError &&
    time - lastRetry > RETRY_INTERVAL
  ) {
    // Not connected (yet, or any more): try again every few seconds.
    lastRetry = time
    link.connect()
  }
  show(currentScreen(time))
}

// Send every frame for responsiveness, plus a timer that keeps the TV hearing
// from us when the browser throttles animation frames.
function frame() {
  tick()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
setInterval(tick, HEARTBEAT_INTERVAL)
