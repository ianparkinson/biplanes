// The TV side of couch play. Runs the game and accepts up to two phones as
// controllers over WebRTC; a plane with no phone is flown by the CPU. Works as a
// Chromecast receiver app, or in any browser on a big screen.
import "./tv.css"

import Peer, { DataConnection } from "peerjs"
import QRCode from "qrcode"

import { Sfx } from "./audio"
import { PLANE_COLORS, SIM_DT, WORLD_HEIGHT, WORLD_WIDTH } from "./config"
import { CAST_NAMESPACE, CastMsg, PadHello, PadMsg, TvMsg } from "./couch"
import { cpuInput } from "./cpu"
import { Effects } from "./effects"
import { ID_PREFIX, TIMEOUT, describeError, newRoomCode, padUrl } from "./net"
import { render } from "./render"
import { Input, NO_INPUT, createGame, startGame, step } from "./sim"

const STATUS_INTERVAL = 0.2 // seconds between status updates to the phones
const FORGET_PHONE_AFTER = 30 // seconds of silence before a phone's plane is freed
const MAX_FRAME_TIME = 0.25 // cap on catch-up after a stall

function element(id: string) {
  return document.getElementById(id)!
}
function now() {
  return performance.now() / 1000
}

const canvas = element("game") as HTMLCanvasElement
const ctx = canvas.getContext("2d")!

// ---- On-screen diagnostics -----------------------------------------------------

// There's no console on a TV, so show any failure on screen.
function fatal(message: string) {
  element("fatal").textContent = message
  element("fatal").hidden = false
}
addEventListener("error", (event) =>
  fatal(`Something went wrong:\n${event.message}`),
)
addEventListener("unhandledrejection", (event) =>
  fatal(`Something went wrong:\n${event.reason}`),
)

// The status line in the corner: "Key: value" pairs, updated as things change.
const diagnostics: Record<string, string> = {}
function setDiagnostic(key: string, value: string) {
  diagnostics[key] = value
  element("diag").textContent = Object.entries(diagnostics)
    .map(([name, text]) => `${name}: ${text}`)
    .join("  ·  ")
}

// The graphics chip, which helps explain device-specific drawing problems.
function gpuName() {
  try {
    const gl = document.createElement("canvas").getContext("webgl")
    const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info")
    const name: string =
      (debugInfo && gl!.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) ||
      (gl ? "unknown" : "no WebGL")
    return name.length > 48 ? name.slice(0, 47) + "…" : name
  } catch {
    return "unknown"
  }
}

setDiagnostic(
  "WebRTC",
  typeof RTCPeerConnection === "function" ? "available" : "NOT AVAILABLE",
)
// Cast devices put e.g. "DeviceType/AndroidTV" in their user agent.
setDiagnostic(
  "Device",
  (/DeviceType\/(\w+)/.exec(navigator.userAgent)?.[1] ?? "browser") +
    ` ${innerWidth}x${innerHeight}@${devicePixelRatio}`,
)
setDiagnostic("GPU", gpuName())

// Size the canvas to the screen's real pixels and scale the game to fit, rather
// than having the browser upscale a small canvas.
function fitCanvas() {
  const width = Math.round(canvas.clientWidth * devicePixelRatio)
  if (!width || width === canvas.width) return
  canvas.width = width
  canvas.height = Math.round((width * WORLD_HEIGHT) / WORLD_WIDTH)
  setDiagnostic("Canvas", `${canvas.width}x${canvas.height}`)
}

// Self-check after the first frame: can the page read back what it drew? If the
// screen stays blank but this says "ok", the device isn't displaying the canvas.
function checkCanvas() {
  const size = `${canvas.width}x${canvas.height}`
  try {
    // The brown earth along the bottom edge is never covered by menus or tint.
    const [red, green, blue] = ctx.getImageData(
      Math.floor(canvas.width / 2),
      canvas.height - 2,
      1,
      1,
    ).data
    const isEarth =
      Math.abs(red - 0x7a) < 24 &&
      Math.abs(green - 0x52) < 24 &&
      Math.abs(blue - 0x30) < 24
    setDiagnostic(
      "Canvas",
      isEarth ? `${size} draws ok` : `${size} READBACK ${red},${green},${blue}`,
    )
  } catch (error) {
    setDiagnostic("Canvas", `readback failed (${error})`)
  }
}

// ---- Chromecast receiver -------------------------------------------------------

declare const cast: any
let castContext: any = null
let roomCode = ""

// Sends a message to one Cast sender (the phone that launched us), or all of them.
function castSend(msg: CastMsg, senderId?: string) {
  try {
    castContext?.sendCustomMessage(CAST_NAMESPACE, senderId, msg)
  } catch {
    /* no senders connected */
  }
}

// The phone that cast us asks for the room code so it can join as a controller.
function startCastReceiver() {
  castContext = cast.framework.CastReceiverContext.getInstance()
  const options = new cast.framework.CastReceiverOptions()
  options.disableIdleTimeout = true // no media plays, so don't let the app time out
  options.skipPlayersLoad = true
  options.customNamespaces = {
    [CAST_NAMESPACE]: cast.framework.system.MessageType.JSON,
  }
  castContext.addCustomMessageListener(
    CAST_NAMESPACE,
    (event: { senderId: string }) => {
      if (roomCode) castSend({ type: "code", code: roomCode }, event.senderId)
    },
  )
  castContext.start(options)
  setDiagnostic("Cast", "ready")
}

// Only load the receiver SDK on a Cast device; elsewhere this is a plain web page.
if (
  /CrKey/.test(navigator.userAgent) ||
  new URLSearchParams(location.search).has("cast")
) {
  setDiagnostic("Cast", "loading")
  const script = document.createElement("script")
  script.src =
    "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"
  script.onload = startCastReceiver
  script.onerror = () => setDiagnostic("Cast", "SDK failed to load")
  document.head.append(script)
}

// ---- Phones --------------------------------------------------------------------

interface Pad {
  conn: DataConnection
  phoneId: string
  lastHeard: number
  input: Input
  inputSeq: number // newest input seen; the channel is unordered
}

// Indexed by plane: the phone flying it, if any.
const pads: (Pad | null)[] = [null, null]
const owners = ["", ""] // last phone to fly each plane, so it can reclaim it
let humanPlayers = [false, false] // which planes had a phone when the match started
let statusSeq = 0

// A phone counts as present only while its messages keep arriving.
function present(pad: Pad | null) {
  return !!pad && now() - pad.lastHeard < TIMEOUT
}

function registerRoom(attemptsLeft = 3) {
  roomCode = newRoomCode()
  const peer = new Peer(ID_PREFIX + roomCode, { debug: 1 })
  setDiagnostic("Room", "registering")
  peer.on("open", () => {
    setDiagnostic("Room", roomCode)
    showJoinCode()
    castSend({ type: "code", code: roomCode })
  })
  peer.on("connection", acceptPhone)
  peer.on("disconnected", () => {
    setDiagnostic("Room", `${roomCode} (reconnecting)`)
    if (!peer.destroyed) peer.reconnect()
  })
  peer.on("error", (err) => {
    if (err.type === "unavailable-id" && attemptsLeft > 1) {
      peer.destroy()
      registerRoom(attemptsLeft - 1) // room code clash: pick another
    } else if (err.type !== "peer-unavailable") fatal(describeError(err.type))
  })
}

// Which plane a newly connected phone gets: its old one if it's reconnecting,
// else a plane no phone has flown, else any free plane. -1 if both are taken.
function chooseSlot(phoneId: string) {
  const previous = owners.indexOf(phoneId)
  if (previous >= 0 && (!pads[previous] || pads[previous]!.phoneId === phoneId))
    return previous
  const neverOwned = pads.findIndex((pad, i) => !pad && !owners[i])
  if (neverOwned >= 0) return neverOwned
  return pads.findIndex((pad) => !pad)
}

function acceptPhone(conn: DataConnection) {
  conn.on("open", () => {
    const phoneId = (conn.metadata as PadHello | undefined)?.id ?? conn.peer
    const slot = chooseSlot(phoneId)
    if (slot < 0) {
      conn.send({ type: "full" } satisfies TvMsg)
      setTimeout(() => conn.close(), 1000)
      return
    }
    const existing = pads[slot]
    if (existing && existing.conn !== conn) existing.conn.close()
    pads[slot] = {
      conn,
      phoneId,
      lastHeard: now(),
      input: NO_INPUT,
      inputSeq: -1,
    }
    owners[slot] = phoneId
    sendStatus()
  })
  conn.on("data", (data) => {
    const pad = pads.find((candidate) => candidate?.conn === conn)
    if (!pad) return
    pad.lastHeard = now()
    const msg = data as PadMsg
    if (msg.type === "input" && msg.seq > pad.inputSeq) {
      pad.inputSeq = msg.seq
      pad.input = { turn: msg.turn, fire: msg.fire }
    }
    if (msg.type === "start") startMatch()
  })
  const drop = () => {
    const slot = pads.findIndex((pad) => pad?.conn === conn)
    if (slot >= 0) pads[slot] = null
  }
  conn.on("close", drop)
  conn.on("error", drop)
}

// The CPU flies any plane without a phone; at least one phone is needed.
function startMatch() {
  if (game.mode === "playing") return
  humanPlayers = pads.map(present)
  if (!humanPlayers.some(Boolean)) return
  startGame(game, !(humanPlayers[0] && humanPlayers[1]))
}

// A match pauses while any of its human players is missing.
function paused() {
  return (
    game.mode === "playing" &&
    humanPlayers.some((human, i) => human && !present(pads[i]))
  )
}

// Tells each phone which plane it has and how the match is going.
function sendStatus() {
  const players = pads.map(present)
  pads.forEach((pad, slot) => {
    if (!pad?.conn.open) return
    pad.conn.send({
      type: "pad",
      seq: ++statusSeq,
      slot,
      mode: game.mode,
      paused: paused(),
      deaths: game.planes.map((plane) => plane.deaths),
      players,
    } satisfies TvMsg)
  })
}

// ---- Joining panel ------------------------------------------------------------

function showJoinCode() {
  const url = padUrl(roomCode)
  // An ordinary image rather than a canvas, so players can join even if a device
  // has trouble showing canvases. Generated at its on-screen size (26vh), to stay sharp.
  const size = Math.round(innerHeight * 0.26 * devicePixelRatio)
  QRCode.toDataURL(url, { margin: 2, width: size }).then((dataUrl) => {
    ;(element("qr") as HTMLImageElement).src = dataUrl
  })
  element("join-text").textContent = "Point your phone's camera at the code."
}

// Shows or hides the panel and refreshes its player list; called every frame,
// but only touches the page when something changed.
let joinPanelSignature = ""
function updateJoinPanel() {
  const show = !!roomCode && (game.mode !== "playing" || paused())
  element("join").hidden = !show
  if (!show) return
  const players = pads.map(present)
  const missing = paused()
    ? humanPlayers.findIndex((human, i) => human && !players[i])
    : -1
  let hint = ""
  if (missing >= 0) hint = `Waiting for P${missing + 1} to reconnect…`
  else if (players.some(Boolean))
    hint = "Press START on a phone when you're ready"

  const signature = players.join() + hint
  if (signature === joinPanelSignature) return
  joinPanelSignature = signature
  const cpuOffer =
    players.some(Boolean) && game.mode !== "playing" ? " (or CPU)" : ""
  element("players").replaceChildren(
    ...players.map((joined, i) => {
      const item = document.createElement("li")
      item.style.color = PLANE_COLORS[i]
      item.textContent = `P${i + 1}  ${joined ? "● READY" : "○ scan to join" + cpuOffer}`
      return item
    }),
  )
  element("join-hint").textContent = hint
}

// ---- Main loop -----------------------------------------------------------------

const game = createGame()
const effects = new Effects()
const sfx = new Sfx()
sfx.init() // a Cast receiver may play sound straight away; a desktop browser waits for a click
addEventListener("click", () => sfx.init())
addEventListener("keydown", () => sfx.init())

function planeInputs(): Input[] {
  return [0, 1].map((i) => {
    if (!humanPlayers[i]) return cpuInput(game, i)
    return present(pads[i]) ? pads[i]!.input : NO_INPUT
  })
}

let lastFrameAt = now()
let stepTimeOwed = 0
let lastStatusAt = 0
let canvasChecked = false
function frame() {
  const time = now()
  const frameTime = Math.min(MAX_FRAME_TIME, time - lastFrameAt)
  lastFrameAt = time

  // Fixed-step simulation, as in main.ts.
  stepTimeOwed = paused() ? 0 : stepTimeOwed + frameTime
  while (stepTimeOwed >= SIM_DT) {
    step(game, planeInputs(), SIM_DT)
    stepTimeOwed -= SIM_DT
    for (const event of game.events) {
      sfx.play(event)
      effects.event(event)
    }
    game.events.length = 0
  }

  // Forget phones that went quiet long ago, so their plane is free for someone else.
  pads.forEach((pad, slot) => {
    if (pad && time - pad.lastHeard > FORGET_PHONE_AFTER) {
      pad.conn.close()
      pads[slot] = null
    }
  })
  if (time - lastStatusAt > STATUS_INTERVAL) {
    lastStatusAt = time
    sendStatus()
  }

  effects.update(game, frameTime)
  const labels = humanPlayers.map((human, i) =>
    human || game.mode === "title" ? `P${i + 1}` : "CPU",
  ) as [string, string]
  fitCanvas()
  const scale = canvas.width / WORLD_WIDTH
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  render(ctx, game, effects.particles, { controls: "tv", labels })
  if (!canvasChecked) {
    canvasChecked = true
    checkCanvas()
  }
  game.planes.forEach((plane, i) =>
    sfx.engine(
      i,
      game.mode === "playing" &&
        (plane.state === "ground" || plane.state === "air"),
      plane.speed,
      plane.x,
    ),
  )
  updateJoinPanel()
  requestAnimationFrame(frame)
}

registerRoom()
requestAnimationFrame(frame)
