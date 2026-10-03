# Biplanes design notes

Why the game is built the way it is. The code comments explain what each piece
does; this explains the decisions behind them, and what's still open.

## Code map

Three pages, each with its own entry module:

| Page         | Entry         | Role                                                    |
| ------------ | ------------- | ------------------------------------------------------- |
| `index.html` | `src/main.ts` | The game: local play, and online host or guest          |
| `cast.html`  | `src/tv.ts`   | Couch play on a TV: runs the game for phone controllers |
| `pad.html`   | `src/pad.ts`  | A phone used as a controller for the TV                 |

Shared modules:

- `config.ts`: constants, and the coordinate and angle conventions
- `sim.ts`: the whole game. Pure data and logic, no browser APIs
- `cpu.ts`: the computer pilot, which produces inputs like a player
- `render.ts`, `effects.ts`, `audio.ts`: drawing, particles, synthesized sound
- `input.ts`: keyboard and on-screen touch buttons
- `net.ts`: online play over WebRTC, and the guest's snapshot smoothing
- `couch.ts`, `cast.ts`: TV/phone messages, and launching the TV app on a Chromecast
- `ui.ts`: HTML menus and dialogs

## The simulation

`sim.ts` holds all game state as plain data and advances it with
`step(game, inputs, dt)`. It never touches the page, the clock, sound or the
network, and it uses no randomness. So:

- **It's deterministic.** The same inputs always produce the same game, which
  makes behaviour easy to check (see "Testing" below).
- **One device can run it and send the state to others.** Online and couch play
  both work this way.
- **Side effects come out as events.** Instead of playing a sound, the
  simulation pushes a `GameEvent` (`shoot`, `explode`...). Whoever runs the loop
  drains them to the sound and particle systems, or sends them over the network.

The loop runs the simulation in **fixed 1/60 s steps**, however long each
frame takes (`SIM_DT`). Leftover time carries over to the next frame. This keeps
physics identical on 60 Hz and 120 Hz screens, and makes the game reproducible.

Particles are deliberately _not_ part of the simulation. They're cosmetic and
random, so each device generates its own from the events (`effects.ts`). That
keeps network messages small.

## Online play: one device runs the game

The **host** runs the only copy of the simulation. The **guest** sends its
inputs (turn and fire, a few bytes) every frame, and the host sends back
**snapshots** of the game about 30 times a second.

The alternative, both devices simulating in lockstep and exchanging inputs,
would give the guest instant response but needs perfectly deterministic code on
both ends, plus rollback to hide latency. That's a lot of machinery for a game
with two slow-turning planes. The cost of the host approach: the guest's own
plane responds one network round trip late. On home Wi-Fi that's unnoticeable;
over mobile data it might be 100–200 ms. If it ever feels bad, the fix is
client-side prediction (the guest moves its own plane immediately and corrects
it when snapshots arrive).

### Snapshots

A snapshot holds the game mode, each plane and bullet, and the last second's
events. Planes and bullets are packed into tuples with rounded numbers, which
comes to about 300 bytes per snapshot, around 8.5 KB/s.

Events are repeated in every snapshot for a second, each with an id, so a lost
packet doesn't lose an explosion. The guest plays each id once.

The data channel is **unordered** (PeerJS `reliable: false`): a delayed message
never holds up newer ones. Messages carry sequence numbers or timestamps, and
stale ones are ignored.

### Guest-side smoothing

Snapshots arrive unevenly and sometimes not at all. Drawing each one as it
arrives would make the planes stutter. Instead `SnapshotBuffer` draws the game
**0.1 s in the past** (`RENDER_DELAY`), blending between the two snapshots
either side of that moment:

- **Clock:** for each arrival it records host time minus local time. Network
  delay only ever makes that smaller, so the largest recent value is the best
  estimate of the host's clock.
- **Blending:** positions and angles are interpolated the short way round the
  wrapping world and the circle. Planes aren't blended across a state change or
  respawn; they snap instead.
- **Bullets** fly in straight lines, so they're moved forward from the older
  snapshot rather than matched up between snapshots.

Tested with 10% packet loss and 30–90 ms of random delay, the guest's planes
move as smoothly as the host's.

### Finding each other

WebRTC needs a matchmaking server for the first handshake. We use the free
public **PeerJS** server: the host registers an id of `biplanes-v1-` plus a
six-character room code, and the guest connects to it. After that, traffic goes
directly between devices. When a direct connection is blocked (common on mobile
data), PeerJS's default config includes a public relay (TURN) server.

Both are free services with no uptime guarantee. All of this lives behind
`HostLink`/`GuestLink` in `net.ts`, so swapping in our own server later
wouldn't touch the game.

### Dropouts

A connection counts as present only while messages keep arriving (`TIMEOUT`,
4 s). Phones that lose signal or lock their screen often never close the
connection cleanly. When the guest goes missing, the host pauses and shows the
invite again; reopening the link resumes the same match. The guest retries on
its own every few seconds.

## Couch play: the TV runs the game

`cast.html` is the same host design with the TV as host: it runs the
simulation and accepts up to **two phones as controllers**. Phones send inputs
like an online guest and get back a small status message (their plane, lives,
match state) rather than snapshots, since they don't draw the game. The CPU
flies any plane without a phone.

- **Reconnecting:** each phone keeps a random id in `localStorage` and sends it
  when connecting, so a phone that drops out gets its own plane back.
- **Pausing:** a match pauses while any of its human players is missing.
- **Background tabs:** browsers throttle animation frames in background tabs, so
  the controller also sends a heartbeat from a timer. The TV page must stay in
  the foreground (on a TV it always is).

### Chromecast

`cast.html` doubles as a **Google Cast receiver app**. "Play on TV" on the game
page uses the Cast sender SDK (Chrome on Android and desktop only; iPhones can't
start a cast from a web page) to launch it. The TV then tells the launching
phone its room code over a Cast message channel, and the phone switches to the
controller page. Other phones, including iPhones, join by scanning the QR code
on the TV.

- **App:** id `743316D5`, registered in the
  [Cast developer console](https://cast.google.com/publish) under the owner's
  account, and **published**. The receiver URL is fixed there:
  `https://ianparkinson.github.io/biplanes/cast.html`.
- **Registration lessons:** unpublished apps only appear for registered test
  devices, and the console shows "Ready for testing" immediately whether or not
  the device actually picked it up. A Chromecast with Google TV needs its _Cast_
  software serial number (from developer settings), not the hardware serial.
  Even after publishing, the app took a while to appear for our devices.
- **Diagnostics:** there's no console on a TV, so `cast.html` shows a status
  line (WebRTC, device type, GPU, room code, a canvas self-check) and puts any
  error on screen.
- **Drawing:** the TV canvas is sized to the screen's real pixels and drawn
  scaled, rather than upscaled by CSS; the QR code is an `<img>`, so players can
  join even if canvases fail.

## Open issues

- **Nvidia Shield shows a blank screen.** The receiver runs and phones connect,
  but neither canvas appeared. The drawing changes above (full-resolution
  canvas, QR as an image) were made for this but are untested on the Shield;
  the status line's canvas self-check should show whether drawing or display is
  failing.
- **Older Chromecasts (e.g. the Ultra)** reportedly don't support WebRTC in
  receiver apps (only Chromecast with Google TV and Nest displays do). Options:
  have a phone run the game and send state to the TV over Cast messaging, or run
  the game on a small server with WebSockets.
- **Guest input lag** in online play, as above. Client-side prediction if needed.
- **No automated tests yet.** The simulation and `SnapshotBuffer` are easy
  candidates (see below).

## Testing

There's no test suite yet. Two techniques used so far:

- **Behaviour fingerprint.** Because the simulation is deterministic, a script
  can run a long scripted match (CPU against a scripted player), feed snapshots
  through `SnapshotBuffer` with pseudo-random delay and loss, and render sample
  frames, then hash the results. Running it before and after a refactor proves
  nothing changed. The dev server can import TypeScript modules straight into
  the page, e.g. `await import('/src/sim.ts')` from the browser console.
- **Multiplayer in one browser.** Open the host or TV in one tab and the guest
  or controllers in others. Two controllers need different `localStorage`, so
  open one via `localhost` and the other via `127.0.0.1`. Keep the host or TV
  tab in the foreground, since background tabs are throttled.
