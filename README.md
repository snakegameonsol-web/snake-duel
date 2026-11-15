# Snake Duel

A free, real-time, head-to-head Snake prototype. This version has no deposits, prizes, accounts, or blockchain.

## What's included

- Responsive browser game and matchmaking lobby.
- Guest players join one free queue; two different guest IDs are paired.
- Synchronized three-second start and server-authoritative movement, food, collisions, scores, and winner.
- WebSocket heartbeat, queue cancellation, disconnect-forfeit handling, and same-tick draw handling.
- Render blueprint for the match server.

## Match rules in this prototype

- Both snakes share one 25 by 25 board and one fruit.
- Each snake speeds up independently as it grows: every two fruit reduce its move interval by 10 ms, from 140 ms to a 75 ms minimum.
- A wall, your own body, or the opponent's body is fatal.
- If both snakes crash on the same tick, the match is a draw.
- If a player disconnects or leaves during a match, the other player wins by forfeit.
- The first two different guest IDs in the queue are matched. Guest identity is per browser tab and is not account authentication.

## Deploy the match server on Render

1. Push the repository to GitHub with `server/package.json`, `server/server.js`, and `render.yaml` included.
2. In Render, create a new Blueprint and connect this repository. Review the service named `snake-duel-match-server` and deploy it.
3. Copy the public service host Render assigns, for example `snake-duel-match-server.onrender.com`.
4. In `config.js`, set `window.SNAKE_DUEL_SERVER_URL` to the secure WebSocket address, for example `wss://snake-duel-match-server.onrender.com/ws`.
5. Commit and push the updated `config.js`; GitHub Pages will update the browser client.

The Render service also exposes `/health` for a basic health check. Only the GitHub Pages origin is allowed by default; add other origins to `ALLOWED_ORIGINS` if needed.

## Local development

Start the server from `server/` with Node.js 20 or later: `npm install`, then `npm start`. Set `window.SNAKE_DUEL_SERVER_URL` in `config.js` to `ws://localhost:10000/ws`, and serve the static files from a local web server. The browser client defaults to that address on localhost.

The game is intentionally an early free-play MVP. Before cash matches, add authenticated accounts, persistent match records, abuse controls, and review the legal and payment requirements for each market.

