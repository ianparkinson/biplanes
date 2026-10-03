// The TV side of couch play. Runs the game and accepts up to two phones as
// controllers over WebRTC; a plane with no phone is flown by the CPU. Works as a
// Chromecast receiver app, or in any browser on a big screen.
import "./tv.css"

import Peer, { DataConnection } from "peerjs"
import QRCode from "qrcode"

import { Sfx } from "./audio"
import { H, PLANE_COLORS, SIM_DT, W } from "./config"
import { CAST_NAMESPACE, CastMsg, PadHello, PadMsg, TvMsg } from "./couch"
import { cpuInput } from "./cpu"
import { Effects } from "./effects"
import { ID_PREFIX, TIMEOUT, describe, newRoomCode, padUrl } from "./net"
import { render } from "./render"
import { Input, NO_INPUT, createGame, startGame, step } from "./sim"

const $ = (id: string) => document.getElementById(id)!
const canvas = $("game") as HTMLCanvasElement
const ctx = canvas.getContext("2d")!
const now = () => performance.now() / 1000

// There's no console on a TV, so show any failure on screen.
function fatal(message: string) {
  $("fatal").textContent = message
  $("fatal").hidden = false
}
addEventListener("error", (e) => fatal(`Something went wrong:\n${e.message}`))
addEventListener("unhandledrejection", (e) =>
  fatal(`Something went wrong:\n${e.reason}`),
)

const diag: Record<string, string> = {}
function setDiag(key: string, value: string) {
  diag[key] = value
  $("diag").textContent = Object.entries(diag)
    .map(([k, v]) => `${k}: ${v}`)
    .join("  ·  ")
}
setDiag(
  "WebRTC",
  typeof RTCPeerConnection === "function" ? "available" : "NOT AVAILABLE",
)
setDiag(
  "Device",
  (/DeviceType\/(\w+)/.exec(navigator.userAgent)?.[1] ?? "browser") +
    ` ${innerWidth}x${innerHeight}@${devicePixelRatio}`,
)
setDiag("GPU", gpuName())

// The graphics chip, which helps explain device-specific drawing problems.
function gpuName() {
  try {
    const gl = document.createElement("canvas").getContext("webgl")
    const ext = gl?.getExtension("WEBGL_debug_renderer_info")
    const name: string =
      (ext && gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) ||
      (gl ? "unknown" : "no WebGL")
    return name.length > 48 ? name.slice(0, 47) + "…" : name
  } catch {
    return "unknown"
  }
}

// Size the canvas to the screen's real pixels and scale the 800x450 game to fit,
// rather than having the browser upscale a small canvas.
function fitCanvas() {
  const w = Math.round(canvas.clientWidth * devicePixelRatio)
  if (!w || w === canvas.width) return
  canvas.width = w
  canvas.height = Math.round((w * H) / W)
  setDiag("Canvas", `${canvas.width}x${canvas.height}`)
}

// Self-check after the first frame: can the page read back what it drew? If the
// screen stays blank but this says "ok", the device isn't displaying the canvas.
function checkCanvas() {
  try {
    // The brown earth along the bottom edge is never covered by menus or tint.
    const [r, g, b] = ctx.getImageData(
      Math.floor(canvas.width / 2),
      canvas.height - 2,
      1,
      1,
    ).data
    const earth =
      Math.abs(r - 0x7a) < 24 &&
      Math.abs(g - 0x52) < 24 &&
      Math.abs(b - 0x30) < 24
    setDiag(
      "Canvas",
      `${canvas.width}x${canvas.height} ${earth ? "draws ok" : `READBACK ${r},${g},${b}`}`,
    )
  } catch (e) {
    setDiag("Canvas", `readback failed (${e})`)
  }
}

// ---- Chromecast receiver -------------------------------------------------------

declare const cast: any
let castContext: any = null
let code = ""

function castSend(msg: CastMsg, senderId?: string) {
  try {
    castContext?.sendCustomMessage(CAST_NAMESPACE, senderId, msg)
  } catch {
    /* no senders */
  }
}

// Only load the receiver SDK on a Cast device; elsewhere this is a plain web page.
if (
  /CrKey/.test(navigator.userAgent) ||
  new URLSearchParams(location.search).has("cast")
) {
  setDiag("Cast", "loading")
  const s = document.createElement("script")
  s.src =
    "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"
  s.onload = () => {
    castContext = cast.framework.CastReceiverContext.getInstance()
    const options = new cast.framework.CastReceiverOptions()
    options.disableIdleTimeout = true // no media plays, so don't let the app time out
    options.skipPlayersLoad = true
    options.customNamespaces = {
      [CAST_NAMESPACE]: cast.framework.system.MessageType.JSON,
    }
    castContext.addCustomMessageListener(
      CAST_NAMESPACE,
      (e: { senderId: string }) => {
        if (code) castSend({ t: "code", code }, e.senderId)
      },
    )
    castContext.start(options)
    setDiag("Cast", "ready")
  }
  s.onerror = () => setDiag("Cast", "SDK failed to load")
  document.head.append(s)
}

// ---- Phones --------------------------------------------------------------------

interface Pad {
  conn: DataConnection
  id: string
  lastHeard: number
  input: Input
  seq: number
}
const pads: (Pad | null)[] = [null, null]
const owners = ["", ""] // last phone to fly each plane, so it can reclaim it
let inGame = [false, false] // which planes had a phone when the match started
let statusSeq = 0

const present = (p: Pad | null) => !!p && now() - p.lastHeard < TIMEOUT

function register(tries = 3) {
  code = newRoomCode()
  const peer = new Peer(ID_PREFIX + code, { debug: 1 })
  setDiag("Room", "registering")
  peer.on("open", () => {
    setDiag("Room", code)
    showJoin()
    castSend({ t: "code", code })
  })
  peer.on("connection", accept)
  peer.on("disconnected", () => {
    setDiag("Room", `${code} (reconnecting)`)
    if (!peer.destroyed) peer.reconnect()
  })
  peer.on("error", (err) => {
    if (err.type === "unavailable-id" && tries > 1) {
      peer.destroy()
      register(tries - 1)
    } else if (err.type !== "peer-unavailable") fatal(describe(err.type))
  })
}

function accept(conn: DataConnection) {
  conn.on("open", () => {
    const id = (conn.metadata as PadHello | undefined)?.id ?? conn.peer
    let slot = owners.indexOf(id) // a returning phone gets its plane back
    if (slot < 0 || (pads[slot] && pads[slot]!.id !== id))
      slot = pads.findIndex((p, i) => !p && !owners[i])
    if (slot < 0) slot = pads.findIndex((p) => !p)
    if (slot < 0) {
      conn.send({ t: "full" } satisfies TvMsg)
      setTimeout(() => conn.close(), 1000)
      return
    }
    if (pads[slot] && pads[slot]!.conn !== conn) pads[slot]!.conn.close()
    pads[slot] = { conn, id, lastHeard: now(), input: NO_INPUT, seq: -1 }
    owners[slot] = id
    sendStatus()
  })
  conn.on("data", (d) => {
    const pad = pads.find((p) => p?.conn === conn)
    if (!pad) return
    pad.lastHeard = now()
    const msg = d as PadMsg
    if (msg.t === "input" && msg.seq > pad.seq) {
      pad.seq = msg.seq
      pad.input = { rot: msg.rot, fire: msg.fire }
    }
    if (msg.t === "start") startMatch()
  })
  const drop = () => {
    const i = pads.findIndex((p) => p?.conn === conn)
    if (i >= 0) pads[i] = null
  }
  conn.on("close", drop)
  conn.on("error", drop)
}

function startMatch() {
  if (game.mode === "playing") return
  inGame = pads.map(present)
  if (!inGame.some(Boolean)) return
  startGame(game, !(inGame[0] && inGame[1]))
}

const paused = () =>
  game.mode === "playing" && inGame.some((h, i) => h && !present(pads[i]))

function sendStatus() {
  const players = pads.map(present)
  pads.forEach((p, slot) => {
    if (!p?.conn.open) return
    p.conn.send({
      t: "pad",
      n: ++statusSeq,
      slot,
      mode: game.mode,
      paused: paused(),
      deaths: game.planes.map((pl) => pl.deaths),
      players,
    } satisfies TvMsg)
  })
}

// ---- Joining panel ------------------------------------------------------------

function showJoin() {
  const url = padUrl(code)
  // An ordinary image rather than a canvas, so players can join even if a device
  // has trouble showing canvases. Generated at its on-screen size, to stay sharp.
  const size = Math.round(innerHeight * 0.26 * devicePixelRatio)
  QRCode.toDataURL(url, { margin: 2, width: size }).then((src) => {
    ;($("qr") as HTMLImageElement).src = src
  })
  $("join-text").textContent = "Point your phone's camera at the code."
}

let joinSignature = ""
function updateJoin() {
  const show = !!code && (game.mode !== "playing" || paused())
  $("join").hidden = !show
  if (!show) return
  const players = pads.map(present)
  const lost = paused() ? inGame.findIndex((h, i) => h && !players[i]) : -1
  const hint =
    lost >= 0
      ? `Waiting for P${lost + 1} to reconnect…`
      : players.some(Boolean)
        ? "Press START on a phone when you're ready"
        : ""
  const sig = players.join() + hint
  if (sig === joinSignature) return
  joinSignature = sig
  $("players").replaceChildren(
    ...players.map((p, i) => {
      const li = document.createElement("li")
      li.style.color = PLANE_COLORS[i]
      const cpuOffer =
        players.some(Boolean) && game.mode !== "playing" ? " (or CPU)" : ""
      li.textContent = `P${i + 1}  ${p ? "● READY" : "○ scan to join" + cpuOffer}`
      return li
    }),
  )
  $("join-hint").textContent = hint
}

// ---- Main loop -----------------------------------------------------------------

const game = createGame()
const effects = new Effects()
const sfx = new Sfx()
sfx.init() // a Cast receiver may play sound straight away; a desktop browser waits for a click
addEventListener("click", () => sfx.init())
addEventListener("keydown", () => sfx.init())

let last = now(),
  acc = 0,
  lastStatus = 0,
  checked = false
function frame() {
  const t = now(),
    dt = Math.min(0.25, t - last)
  last = t
  acc = paused() ? 0 : acc + dt
  while (acc >= SIM_DT) {
    const inputs = [0, 1].map((i) =>
      inGame[i]
        ? present(pads[i])
          ? pads[i]!.input
          : NO_INPUT
        : cpuInput(game, i),
    )
    step(game, inputs, SIM_DT)
    acc -= SIM_DT
    for (const e of game.events) {
      sfx.play(e)
      effects.event(e)
    }
    game.events.length = 0
  }
  // Tidy up phones that went quiet long ago, so their plane is free for someone else.
  pads.forEach((p, i) => {
    if (p && t - p.lastHeard > 30) {
      p.conn.close()
      pads[i] = null
    }
  })
  if (t - lastStatus > 0.2) {
    lastStatus = t
    sendStatus()
  }

  effects.update(game, dt)
  const labels = inGame.map((h, i) =>
    h || game.mode === "title" ? `P${i + 1}` : "CPU",
  ) as [string, string]
  fitCanvas()
  const scale = canvas.width / W
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  render(ctx, game, effects.particles, { controls: "tv", labels })
  if (!checked) {
    checked = true
    checkCanvas()
  }
  game.planes.forEach((p, i) =>
    sfx.engine(
      i,
      game.mode === "playing" && (p.state === "ground" || p.state === "air"),
      p.speed,
      p.x,
    ),
  )
  updateJoin()
  requestAnimationFrame(frame)
}

register()
requestAnimationFrame(frame)
