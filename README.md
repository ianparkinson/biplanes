# Biplanes

A two-player 8-bit style biplane dogfight for the browser. Take off, dogfight,
and shoot down your rival five times to win.

**Play:** https://ianparkinson.github.io/biplanes/

- **One player** against the computer, on a keyboard or a phone
- **Two players** on one keyboard
- **Online** against a friend: one phone hosts and shares a link or QR code,
  the other joins. Uses WebRTC via the public [PeerJS](https://peerjs.com) server.
- **Couch play on a TV**: choose _Play on TV_ in Chrome to cast to a Chromecast
  with Google TV, and phones become controllers (scan the QR code on the TV to
  join). Without a Chromecast, open [`cast.html`](https://ianparkinson.github.io/biplanes/cast.html)
  in any browser on a big screen.

## Controls

|          | Turn          | Fire        |
| -------- | ------------- | ----------- |
| Player 1 | A / D         | S           |
| Player 2 | ← / →         | ↓           |
| Touch    | ↺ / ↻ buttons | FIRE button |

M toggles sound.

## Development

```bash
npm install
npm run dev      # dev server, also reachable from phones on your network
npm run build    # type-check and build into dist/
npm run format   # format all files with Prettier
```

Pushing to `main` deploys to GitHub Pages. The deploy fails if any file isn't
formatted with Prettier, so run `npm run format` before committing.
