# Snake Duel

A free, real-time, head-to-head Snake prototype. This version supports guest play and optional Supabase email accounts. It has no deposits, cash prizes, or blockchain.

## What's included

- Responsive browser game and matchmaking lobby.
- Guest players join one free queue; two different guest IDs are paired.
- Synchronized three-second start and server-authoritative movement, food, collisions, scores, and winner.
- WebSocket heartbeat, queue cancellation, a 15-second reconnect grace period, and same-tick draw handling.
- Render blueprint for the match server.

## Match rules in this prototype

- Both snakes share one 25 by 25 board and one fruit.
- Each snake speeds up independently as it grows: every two fruit reduce its move interval by 10 ms, from 140 ms to a 75 ms minimum.
- A wall, your own body, or the opponent's body is fatal.
- If both snakes crash on the same tick, the match is a draw.
- If a player disconnects, the match pauses for 15 seconds; if they do not return, the other player wins by forfeit.
- The first two different guest IDs in the queue are matched. Matchmaking identity is per browser tab; Supabase accounts are used for saved match history, not to change queue rules.
- A guest profile keeps the name and recent free-match history in this browser using local storage. It does not sync between devices or browsers.

## Deploy the match server on Render

1. Push the repository to GitHub with `server/package.json`, `server/server.js`, and `render.yaml` included.
2. In Render, create a new Blueprint and connect this repository. Review the service named `snake-duel-match-server` and deploy it.
3. Copy the public service host Render assigns, for example `snake-duel-match-server.onrender.com`.
4. In `config.js`, set `window.SNAKE_DUEL_SERVER_URL` to the secure WebSocket address, for example `wss://snake-duel-match-server.onrender.com/ws`.
5. Commit and push the updated `config.js`; GitHub Pages will update the browser client.

The Render service also exposes `/health` for a basic health check. Only the GitHub Pages origin is allowed by default; add other origins to `ALLOWED_ORIGINS` if needed.

## Local development

Start the server from `server/` with Node.js 20 or later: `npm install`, then `npm start`. Set `window.SNAKE_DUEL_SERVER_URL` in `config.js` to `ws://localhost:10000/ws`, and serve the static files from a local web server. The browser client defaults to that address on localhost.

The game is intentionally an early free-play MVP. Before cash matches, add payment-specific abuse controls and review legal and payment requirements for each market.

## Supabase accounts and cloud match history

This step adds email/password accounts and stores completed match results for signed-in players. Match results are written by the match server; browser clients can read only the signed-in user's rows through Row Level Security. Guest match history remains local to the browser.

1. In the Supabase SQL Editor, run supabase/schema.sql.
2. In Supabase Project Settings, copy the Project URL and Publishable key into supabase-config.js. The publishable key is public; never put a service-role or secret key in this file.
3. In Supabase Authentication URL Configuration, set the Site URL and allowed Redirect URL to https://snakegameonsol-web.github.io/.
4. In the Render service Environment settings, add SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY. Keep the secret key only in Render's private environment settings. Redeploy the match server after saving.
5. Commit and push supabase-config.js and the project files so GitHub Pages updates. Create an account, confirm the email if prompted, then sign in before joining a match for the server to save it to the account.

The UI uses the Supabase JavaScript client from the official CDN. The SQL grants authenticated users read access only to their own records; it grants result writes to the server role only.
