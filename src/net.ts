// Online play over WebRTC (via PeerJS). The host runs the simulation and streams
// snapshots; the guest sends its inputs and draws what the host sends.
import Peer, { DataConnection } from "peerjs"

import { wrapAngle, wrapX, wrappedDx } from "./geometry"
import { GameEvent, GameView, Mode, PlaneState, PlaneView } from "./sim"

export const ID_PREFIX = "biplanes-v1-" // namespaces our room codes on the shared PeerJS broker
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no 0/O, 1/I/L
const CODE_LENGTH = 6
export const TIMEOUT = 4 // seconds of silence before a link counts as lost

// ---- Messages ----------------------------------------------------------------

// Snapshots are sent ~30 times a second, so planes and bullets are packed into
// tuples, with states and modes as indexes into these lists.
type PlaneTuple = [
  x: number,
  y: number,
  angle: number,
  state: number,
  deaths: number,
  speed: number,
]
type BulletTuple = [x: number, y: number, vx: number, vy: number]
const STATES: PlaneState[] = ["ground", "air", "crashing", "dead"]
const MODES: Mode[] = ["title", "playing", "over"]

// An event tagged with a sequence number and the host time it happened.
export type TimedEvent = [id: number, time: number, event: GameEvent]

export interface Snapshot {
  type: "state"
  time: number // host sim time, seconds
  mode: number
  planes: PlaneTuple[]
  bullets: BulletTuple[]
  events: TimedEvent[] // the last second's events, repeated so a lost packet loses none
}
export type HostMsg = Snapshot
export type GuestMsg =
  | { type: "input"; seq: number; turn: number; fire: boolean }
  | { type: "start" } // asks the host to start a (new) game

function roundTo1dp(value: number) {
  return Math.round(value * 10) / 10
}
function roundTo3dp(value: number) {
  return Math.round(value * 1000) / 1000
}

export function encodeSnapshot(
  game: {
    time: number
    mode: Mode
    planes: PlaneView[]
    bullets: { x: number; y: number; vx: number; vy: number }[]
  },
  events: TimedEvent[],
): Snapshot {
  return {
    type: "state",
    time: roundTo3dp(game.time),
    mode: MODES.indexOf(game.mode),
    planes: game.planes.map((plane) => [
      roundTo1dp(plane.x),
      roundTo1dp(plane.y),
      roundTo3dp(plane.angle),
      STATES.indexOf(plane.state),
      plane.deaths,
      roundTo1dp(plane.speed),
    ]),
    bullets: game.bullets.map((bullet) => [
      roundTo1dp(bullet.x),
      roundTo1dp(bullet.y),
      Math.round(bullet.vx),
      Math.round(bullet.vy),
    ]),
    events,
  }
}

// ---- Guest-side smoothing ----------------------------------------------------

// Snapshots arrive unevenly (and occasionally not at all), so the guest draws
// the game slightly in the past, blending between the two snapshots either side
// of that moment. That moment is RENDER_DELAY behind the newest host time.
const RENDER_DELAY = 0.1 // seconds
const MAX_SNAPSHOTS = 30 // about a second's worth
const CLOCK_WINDOW = 2 // seconds of arrivals used to estimate the host clock

export class SnapshotBuffer {
  private snapshots: Snapshot[] = []
  // For each recent arrival: host time minus local time when it arrived. Network
  // delay only ever makes this smaller, so the largest is the best clock estimate.
  private clockOffsets: { at: number; offset: number }[] = []
  private lastEventId = 0
  private pendingEvents: TimedEvent[] = []

  push(snapshot: Snapshot, now: number) {
    const newest = this.snapshots[this.snapshots.length - 1]
    if (newest && snapshot.time <= newest.time) return // stale: the channel is unordered
    this.snapshots.push(snapshot)
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift()
    this.clockOffsets.push({ at: now, offset: snapshot.time - now })
    this.clockOffsets = this.clockOffsets.filter(
      (sample) => now - sample.at < CLOCK_WINDOW,
    )
    for (const timedEvent of snapshot.events) {
      const [id] = timedEvent
      if (id > this.lastEventId) {
        this.pendingEvents.push(timedEvent)
        this.lastEventId = id
      }
    }
  }

  reset() {
    this.snapshots = []
    this.clockOffsets = []
    this.pendingEvents = []
    this.lastEventId = 0
  }

  get empty() {
    return this.snapshots.length === 0
  }

  // The host time to draw at.
  private renderTime(now: number) {
    const offset = Math.max(...this.clockOffsets.map((sample) => sample.offset))
    return now + offset - RENDER_DELAY
  }

  // Events that have now come due, so sounds and explosions stay in step with the picture.
  takeEvents(now: number): GameEvent[] {
    if (this.empty) return []
    const time = this.renderTime(now)
    const due = this.pendingEvents.filter(([, eventTime]) => eventTime <= time)
    this.pendingEvents = this.pendingEvents.filter(
      ([, eventTime]) => eventTime > time,
    )
    return due.map(([, , event]) => event)
  }

  view(now: number): GameView | null {
    if (this.empty) return null
    const time = this.renderTime(now)

    // Find the pair of snapshots either side of `time` (or the oldest/newest
    // pair if it falls outside them), and how far between them it is (0..1).
    let index = this.snapshots.length - 1
    while (index > 0 && this.snapshots[index - 1].time > time) index--
    const newer = this.snapshots[index]
    const older = this.snapshots[Math.max(0, index - 1)]
    const blend =
      newer.time > older.time
        ? Math.max(
            0,
            Math.min(1, (time - older.time) / (newer.time - older.time)),
          )
        : 1

    const planes = newer.planes.map((newerPlane, id): PlaneView => {
      const olderPlane = older.planes[id]
      const [oldX, oldY, oldAngle, oldState, oldDeaths] = olderPlane
      const [newX, newY, newAngle, newState, newDeaths] = newerPlane
      function planeView(
        [, , , state, deaths, speed]: PlaneTuple,
        x: number,
        y: number,
        angle: number,
      ): PlaneView {
        return { id, x, y, angle, state: STATES[state], deaths, speed }
      }
      // Don't blend across a respawn or a change of state: snap to the nearer one.
      if (oldState !== newState || oldDeaths !== newDeaths) {
        const nearer = blend < 0.5 ? olderPlane : newerPlane
        const [x, y, angle] = nearer
        return planeView(nearer, x, y, angle)
      }
      // Blend position and heading, going the short way round the wrapping
      // world and the shorter way round the circle.
      return planeView(
        newerPlane,
        wrapX(oldX + wrappedDx(oldX, newX) * blend),
        oldY + (newY - oldY) * blend,
        oldAngle + wrapAngle(newAngle - oldAngle) * blend,
      )
    })

    // Bullets fly in straight lines, so move the older snapshot's bullets forward.
    const elapsed = Math.max(0, time - older.time)
    const bullets = older.bullets.map(([x, y, vx, vy]) => ({
      x: wrapX(x + vx * elapsed),
      y: y + vy * elapsed,
    }))
    return { mode: MODES[newer.mode], planes, bullets }
  }
}

// ---- Links and room codes ------------------------------------------------------

export function newRoomCode() {
  let code = ""
  for (let i = 0; i < CODE_LENGTH; i++)
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return code
}

// Link that invites a friend to an online game.
export function joinUrl(code: string) {
  const url = new URL(location.href)
  url.search = ""
  url.hash = ""
  url.searchParams.set("join", code)
  return url.toString()
}

// Link for a phone to join a TV game as a controller.
export function padUrl(code: string) {
  const url = new URL("pad.html", location.href)
  url.searchParams.set("code", code)
  return url.toString()
}

export function codeFromUrl(param = "join"): string | null {
  const code =
    new URLSearchParams(location.search).get(param)?.toUpperCase() ?? ""
  return /^[A-Z0-9]{6}$/.test(code) ? code : null
}

export function clearJoinFromUrl() {
  const url = new URL(location.href)
  if (!url.searchParams.has("join")) return
  url.searchParams.delete("join")
  history.replaceState(null, "", url)
}

// ---- Connections -------------------------------------------------------------

interface LinkHandlers<In> {
  onMessage(msg: In): void
  onOpen(): void
  onClose(): void
  onError(message: string): void
}

// Shared by both ends: one data connection, plus when we last heard from it.
abstract class Link<In, Out> {
  protected peer: Peer | null = null
  protected conn: DataConnection | null = null
  lastHeard = 0 // seconds, performance.now() clock
  constructor(protected handlers: LinkHandlers<In>) {}

  get open() {
    return !!this.conn?.open
  }

  send(msg: Out) {
    if (this.conn?.open) this.conn.send(msg)
  }

  // Makes `conn` the current connection, replacing (and closing) any previous one.
  protected adopt(conn: DataConnection) {
    this.conn?.close()
    this.conn = conn
    conn.on("open", () => {
      this.lastHeard = performance.now() / 1000
      this.handlers.onOpen()
    })
    conn.on("data", (data) => {
      if (conn !== this.conn) return
      this.lastHeard = performance.now() / 1000
      this.handlers.onMessage(data as In)
    })
    const lost = () => {
      if (conn !== this.conn) return
      this.conn = null
      this.handlers.onClose()
    }
    conn.on("close", lost)
    conn.on("error", lost)
  }

  close() {
    this.conn?.close()
    this.peer?.destroy()
    this.conn = null
    this.peer = null
  }
}

// Registers a room code with the broker and accepts one guest at a time. A guest
// that reconnects (same link) replaces the old connection.
export class HostLink extends Link<GuestMsg, HostMsg> {
  code = ""

  constructor(
    handlers: LinkHandlers<GuestMsg> & { onReady(code: string): void },
  ) {
    super(handlers)
    this.register(handlers.onReady, 3)
  }

  private register(onReady: (code: string) => void, attemptsLeft: number) {
    this.code = newRoomCode()
    const peer = (this.peer = new Peer(ID_PREFIX + this.code, { debug: 1 }))
    peer.on("open", () => onReady(this.code))
    peer.on("connection", (conn) => this.adopt(conn))
    // Lost touch with the broker (not the guest): re-register the same code.
    peer.on("disconnected", () => {
      if (!peer.destroyed) peer.reconnect()
    })
    peer.on("error", (err) => {
      if (peer !== this.peer) return
      if (err.type === "unavailable-id" && attemptsLeft > 1) {
        // Someone else has this room code: pick another.
        peer.destroy()
        this.register(onReady, attemptsLeft - 1)
      } else {
        this.handlers.onError(describeError(err.type))
      }
    })
  }
}

// Connects to a host (or a TV) by room code. `metadata` is passed to the other
// end with the connection.
export class GuestLink<In = HostMsg, Out = GuestMsg> extends Link<In, Out> {
  private ready: Promise<Peer>

  constructor(
    readonly code: string,
    handlers: LinkHandlers<In>,
    private metadata?: object,
  ) {
    super(handlers)
    const peer = (this.peer = new Peer({ debug: 1 }))
    this.ready = new Promise((resolve) => peer.on("open", () => resolve(peer)))
    peer.on("disconnected", () => {
      if (!peer.destroyed) peer.reconnect()
    })
    peer.on("error", (err) => handlers.onError(describeError(err.type)))
    this.connect()
  }

  // (Re)connects; safe to call again after the connection drops.
  connect() {
    void this.ready.then((peer) => {
      if (peer.destroyed) return
      this.adopt(
        peer.connect(ID_PREFIX + this.code, {
          reliable: false, // unordered, so a delayed message doesn't hold up newer ones
          serialization: "json",
          metadata: this.metadata,
        }),
      )
    })
  }
}

// A player-facing explanation of a PeerJS error type.
export function describeError(type: string) {
  switch (type) {
    case "peer-unavailable":
      return "That game wasn't found. It may have ended, or the link is out of date."
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return "Couldn't reach the matchmaking server. Check your internet connection."
    case "browser-incompatible":
      return "This browser doesn't support online play."
    default:
      return `Connection problem (${type}).`
  }
}
