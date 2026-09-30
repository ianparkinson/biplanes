// Online play over WebRTC (via PeerJS). The host runs the simulation and streams
// snapshots; the guest sends its inputs and draws what the host sends.
import Peer, { DataConnection } from "peerjs";
import { W } from "./config";
import { GameEvent, GameView, Mode, PlaneState, PlaneView } from "./sim";
import { wrapAngle } from "./cpu";

const ID_PREFIX = "biplanes-v1-"; // namespaces our room codes on the shared PeerJS broker
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const SNAPSHOT_EVERY = 2;  // sim steps per snapshot (30 Hz)
export const TIMEOUT = 4;         // seconds of silence before the link counts as lost

// ---- Messages ----------------------------------------------------------------

type PlaneTuple = [x: number, y: number, a: number, state: number, deaths: number, speed: number];
const STATES: PlaneState[] = ["ground", "air", "crashing", "dead"];
const MODES: Mode[] = ["title", "playing", "over"];

export interface Snapshot {
  t: "state";
  time: number; // host sim time, seconds
  mode: number;
  planes: PlaneTuple[];
  bullets: [x: number, y: number, vx: number, vy: number][];
  events: [id: number, time: number, e: GameEvent][]; // recent events, repeated so a lost packet loses none
}
export type HostMsg = Snapshot;
export type GuestMsg =
  | { t: "input"; seq: number; rot: number; fire: boolean }
  | { t: "start" }; // guest asks the host to start a (new) game

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function encodeSnapshot(g: { time: number; mode: Mode; planes: PlaneView[]; bullets: { x: number; y: number; vx: number; vy: number }[] },
                               events: Snapshot["events"]): Snapshot {
  return {
    t: "state", time: r3(g.time), mode: MODES.indexOf(g.mode),
    planes: g.planes.map(p => [r1(p.x), r1(p.y), r3(p.a), STATES.indexOf(p.state), p.deaths, r1(p.speed)]),
    bullets: g.bullets.map(b => [r1(b.x), r1(b.y), Math.round(b.vx), Math.round(b.vy)]),
    events,
  };
}

// ---- Guest-side smoothing ----------------------------------------------------

// Snapshots arrive unevenly, so the guest draws the game slightly in the past,
// blending between the two snapshots either side of that moment.
const RENDER_DELAY = 0.1; // seconds

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  private offsets: { at: number; offset: number }[] = []; // host time minus local time, per arrival
  private lastEvent = 0;
  private pending: [number, number, GameEvent][] = [];

  push(s: Snapshot, now: number) {
    if (this.snaps.length && s.time <= this.snaps[this.snaps.length - 1].time) return; // stale: the channel is unordered
    this.snaps.push(s);
    if (this.snaps.length > 30) this.snaps.shift();
    this.offsets.push({ at: now, offset: s.time - now });
    this.offsets = this.offsets.filter(o => now - o.at < 2);
    for (const ev of s.events) if (ev[0] > this.lastEvent) { this.pending.push(ev); this.lastEvent = ev[0]; }
  }

  reset() { this.snaps = []; this.offsets = []; this.pending = []; this.lastEvent = 0; }

  get empty() { return this.snaps.length === 0; }

  // Host time to draw at: the least-delayed recent arrival sets the clock.
  private renderTime(now: number) {
    return now + Math.max(...this.offsets.map(o => o.offset)) - RENDER_DELAY;
  }

  // Events that have now come due (sounds and explosions stay in step with the picture).
  takeEvents(now: number): GameEvent[] {
    if (this.empty) return [];
    const t = this.renderTime(now);
    const due = this.pending.filter(ev => ev[1] <= t);
    this.pending = this.pending.filter(ev => ev[1] > t);
    return due.map(ev => ev[2]);
  }

  view(now: number): GameView | null {
    if (this.empty) return null;
    const t = this.renderTime(now);
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i - 1].time > t) i--;
    const b = this.snaps[i], a = this.snaps[Math.max(0, i - 1)];
    const k = b.time > a.time ? Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time))) : 1;
    const planes = b.planes.map((pb, id): PlaneView => {
      const pa = a.planes[id];
      const plane = (p: PlaneTuple, x: number, y: number, ang: number): PlaneView =>
        ({ id, x, y, a: ang, state: STATES[p[3]], deaths: p[4], speed: p[5] });
      // Don't blend across a respawn or a change of state.
      if (pa[3] !== pb[3] || pa[4] !== pb[4]) { const p = k < 0.5 ? pa : pb; return plane(p, p[0], p[1], p[2]); }
      let dx = pb[0] - pa[0]; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
      return plane(pb, (pa[0] + dx * k + W) % W, pa[1] + (pb[1] - pa[1]) * k, pa[2] + wrapAngle(pb[2] - pa[2]) * k);
    });
    // Bullets fly in straight lines, so move the older snapshot's bullets forward.
    const dt = Math.max(0, t - a.time);
    const bullets = a.bullets.map(([x, y, vx, vy]) => ({ x: (x + vx * dt + W) % W, y: y + vy * dt }));
    return { mode: MODES[b.mode], planes, bullets };
  }
}

// ---- Connections -------------------------------------------------------------

export function newRoomCode() {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

export function joinUrl(code: string) {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  u.searchParams.set("join", code);
  return u.toString();
}

export function codeFromUrl(): string | null {
  const c = new URLSearchParams(location.search).get("join")?.toUpperCase() ?? "";
  return /^[A-Z0-9]{6}$/.test(c) ? c : null;
}

export function clearJoinFromUrl() {
  const u = new URL(location.href);
  if (!u.searchParams.has("join")) return;
  u.searchParams.delete("join");
  history.replaceState(null, "", u);
}

interface LinkEvents<In> {
  onMessage(msg: In): void;
  onOpen(): void;
  onClose(): void;
  onError(message: string): void;
}

// Shared by both ends: one data connection, plus when we last heard from it.
abstract class Link<In, Out> {
  protected peer: Peer | null = null;
  protected conn: DataConnection | null = null;
  lastHeard = 0;
  constructor(protected ev: LinkEvents<In>) {}

  get open() { return !!this.conn?.open; }
  send(msg: Out) { if (this.conn?.open) this.conn.send(msg); }

  protected adopt(conn: DataConnection) {
    this.conn?.close();
    this.conn = conn;
    conn.on("open", () => { this.lastHeard = performance.now() / 1000; this.ev.onOpen(); });
    conn.on("data", d => {
      if (conn !== this.conn) return;
      this.lastHeard = performance.now() / 1000;
      this.ev.onMessage(d as In);
    });
    conn.on("close", () => { if (conn === this.conn) { this.conn = null; this.ev.onClose(); } });
    conn.on("error", () => { if (conn === this.conn) { this.conn = null; this.ev.onClose(); } });
  }

  close() { this.conn?.close(); this.peer?.destroy(); this.conn = null; this.peer = null; }
}

// Registers a room code with the broker and accepts one guest at a time. A guest
// that reconnects (same link) replaces the old connection.
export class HostLink extends Link<GuestMsg, HostMsg> {
  code = "";
  constructor(ev: LinkEvents<GuestMsg> & { onReady(code: string): void }) {
    super(ev);
    this.register(ev.onReady, 3);
  }

  private register(onReady: (code: string) => void, tries: number) {
    this.code = newRoomCode();
    const peer = (this.peer = new Peer(ID_PREFIX + this.code, { debug: 1 }));
    peer.on("open", () => onReady(this.code));
    peer.on("connection", conn => this.adopt(conn));
    peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); }); // lost the broker, not the guest
    peer.on("error", err => {
      if (peer !== this.peer) return;
      if (err.type === "unavailable-id" && tries > 1) { // room code clash: pick another
        peer.destroy();
        this.register(onReady, tries - 1);
      } else {
        this.ev.onError(describe(err.type));
      }
    });
  }
}

export class GuestLink extends Link<HostMsg, GuestMsg> {
  private ready: Promise<Peer>;
  constructor(readonly code: string, ev: LinkEvents<HostMsg>) {
    super(ev);
    const peer = (this.peer = new Peer({ debug: 1 }));
    this.ready = new Promise(resolve => peer.on("open", () => resolve(peer)));
    peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on("error", err => ev.onError(describe(err.type)));
    this.connect();
  }

  connect() {
    void this.ready.then(peer => {
      if (peer.destroyed) return;
      this.adopt(peer.connect(ID_PREFIX + this.code, { reliable: false, serialization: "json" }));
    });
  }
}

function describe(type: string) {
  switch (type) {
    case "peer-unavailable": return "That game wasn't found. It may have ended, or the link is out of date.";
    case "network": case "server-error": case "socket-error": case "socket-closed":
      return "Couldn't reach the matchmaking server. Check your internet connection.";
    case "browser-incompatible": return "This browser doesn't support online play.";
    default: return `Connection problem (${type}).`;
  }
}
