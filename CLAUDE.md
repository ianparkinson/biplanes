# Biplanes

A two-player biplane dogfight in TypeScript and Canvas, with online play over
WebRTC and couch play on a Chromecast. Hosted on GitHub Pages:
https://ianparkinson.github.io/biplanes/

Background, design decisions and open issues: @docs/design.md

## Commands

```bash
npm run dev           # Vite dev server on all interfaces (phones on the LAN can connect)
npm run build         # tsc (strict) + vite build into dist/
npm run format        # Prettier, including import sorting
npm run format:check  # what CI runs
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
The deploy runs `format:check` and the type-check first, so a push that fails
either doesn't deploy. Run `npm run format` and `npm run build` before
committing.

## Conventions

- **Keep `sim.ts` pure:** no DOM, clock, audio, network or randomness. Anything
  cosmetic or random belongs in `effects.ts` or the page modules. Its determinism
  is what makes online play and behaviour checks work.
- **Descriptive names.** Single letters only for `x`/`y`, `vx`/`vy`, `dx`/`dy`,
  `dt` and loop indexes. Top-level functions are `function` declarations, not
  `const` arrows.
- **Named constants with units** for tuning numbers, and a comment on any formula
  whose purpose isn't obvious. The coordinate and angle conventions are in
  `config.ts`.
- **Prettier style:** no semicolons; imports sorted (packages, then local).
  Stylesheet imports must stay at the top of each entry file in their written
  order (`importOrderSideEffects: false`); `pad.css` overrides `style.css`.
- **Strict TypeScript,** including `noUnusedLocals`/`noUnusedParameters`.

## Checking changes

- **Behaviour-preserving changes:** the simulation is deterministic, so record a
  fingerprint before and after (see "Testing" in `docs/design.md`).
- **Anything visible:** run it in the browser. Use the dev server; module
  scripts don't load from `file://`.
- **Multiplayer:** see "Testing" in `docs/design.md`.

## Things that live outside this repo

- **Cast app `743316D5`** is registered and published in the Google Cast
  developer console (owner's account). Its receiver URL is fixed there as
  `https://ianparkinson.github.io/biplanes/cast.html`: renaming or moving
  `cast.html` breaks casting until the console is updated.
- **PeerJS:** online and couch play use the public PeerJS server and its
  relay. Room ids are `biplanes-v1-<CODE>`; changing the prefix or message
  format means old and new versions can't talk to each other.
