# Biplanes

A two-player 8-bit style biplane dogfight for the browser. Take off, dogfight,
and shoot down your rival five times to win.

**Play:** https://ianparkinson.github.io/biplanes/

- **One player** against the computer, on a keyboard or a phone
- **Two players** on one keyboard
- **Online** against a friend: one phone hosts and shares a link or QR code,
  the other joins. Uses WebRTC via the public [PeerJS](https://peerjs.com) server.

## Controls

| | Turn | Fire |
|---|---|---|
| Player 1 | A / D | S |
| Player 2 | ← / → | ↓ |
| Touch | ↺ / ↻ buttons | FIRE button |

M toggles sound.

## Development

```bash
npm install
npm run dev      # dev server, also reachable from phones on your network
npm run build    # type-check and build into dist/
```

Pushing to `main` deploys to GitHub Pages.
