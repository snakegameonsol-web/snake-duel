'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 10000;
const BOARD = 25;
const HEARTBEAT_MS = 25;
const BASE_MOVE_MS = 160;
const MIN_MOVE_MS = 75;
const COUNTDOWN_SECONDS = 3;
const RECONNECT_GRACE_MS = 15000;
const CLIENT_HEARTBEAT_MS = 5000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_CLIENTS = 500;
const MAX_MESSAGE_BYTES = 8192;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://snakegameonsol-web.github.io,http://localhost:5500,http://127.0.0.1:5500')
    .split(',').map(value => value.trim()).filter(Boolean)
);
const DIRECTIONS = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
};

const clients = new Set();
const waiting = [];
const matches = new Map();
const suspendedPlayers = new Map();
const expiredSessions = new Map();

const server = http.createServer((request, response) => {
  if (request.url === '/health' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', service: 'snake-duel-match-server', queuedPlayers: waiting.length, activeMatches: matches.size }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (request.url !== '/ws' || (origin && !ALLOWED_ORIGINS.has(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (clients.size >= MAX_CLIENTS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

function send(client, message) {
  if (client?.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ') : '';
  return (name || `Guest-${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 20);
}

function cleanPlayerId(value) {
  if (typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value)) return value;
  return randomUUID();
}

async function persistMatchHistory(match, winner, state, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const accountIds = match.accountIds || [];
  const rows = match.players.flatMap((player, index) => {
    const userId = accountIds[index];
    if (!userId) return [];
    return [{ match_id: match.id, user_id: userId, opponent_name: cleanName(match.players[1-index].name), result: winner === null ? 'DRAW' : winner === index ? 'VICTORY' : 'DEFEAT', your_score: Number(state.scores[index] || 0), opponent_score: Number(state.scores[1-index] || 0), duration_seconds: Number(state.elapsedSeconds || 0), reason: options.reason || (options.forfeitIndex !== undefined ? 'forfeit' : winner === null ? 'draw' : 'normal') }];
  });
  if (!rows.length) return;
  try {
    const response = await fetch(SUPABASE_URL + '/rest/v1/match_history?on_conflict=match_id,user_id', { method: 'POST', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows), signal: AbortSignal.timeout(8000) });
    if (!response.ok) console.error('Could not persist match history. Supabase HTTP', response.status, (await response.text()).slice(0,300));
  } catch (error) { console.error('Could not persist match history:', error.message); }
}

async function verifySupabaseToken(token) {
  if (!token) return { accountId: null, status: 'guest' };
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return { accountId: null, status: 'server_unconfigured' };
  if (typeof token !== 'string' || token.length > 7000) return { accountId: null, status: 'invalid' };
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { accountId: null, status: response.status === 401 ? 'invalid' : 'unavailable' };
    const user = await response.json();
    return { accountId: typeof user.id === 'string' ? user.id : null, status: user.id ? 'authenticated' : 'invalid' };
  } catch { return { accountId: null, status: 'unavailable' }; }
}

function removeFromQueue(client) {
  const index = waiting.indexOf(client);
  if (index !== -1) waiting.splice(index, 1);
  client.queued = false;
}

function findPair() {
  for (let left = 0; left < waiting.length; left++) {
    for (let right = left + 1; right < waiting.length; right++) {
      if (waiting[left].playerId !== waiting[right].playerId) return [left, right];
    }
  }
  return null;
}

function queueClient(client, name) {
  if (!client.playerId) {
    send(client, { type: 'error', message: 'Reconnect to the server before joining the queue.' });
    return;
  }
  if (client.match) return;
  if (typeof name === 'string') client.name = cleanName(name);
  if (!client.queued) {
    client.queued = true;
    client.queueEnteredAt = Date.now();
    waiting.push(client);
  }
  const pair = findPair();
  if (!pair) {
    send(client, { type: 'queue', position: waiting.indexOf(client) + 1, queuedPlayers: waiting.length });
    return;
  }
  const [firstIndex, secondIndex] = pair;
  const second = waiting.splice(secondIndex, 1)[0];
  const first = waiting.splice(firstIndex, 1)[0];
  first.queued = false;
  second.queued = false;
  createMatch(first, second);
}

function makeSnake(x, y, direction, tailDirection) {
  const body = [];
  for (let segment = 0; segment < 4; segment++) body.push({ x: x + tailDirection.x * segment, y: y + tailDirection.y * segment });
  return { body, direction, nextDirection: direction, alive: true, turnLocked: false, lastMovedAt: 0 };
}

function moveInterval(score) {
  return Math.max(MIN_MOVE_MS, BASE_MOVE_MS - Math.floor(score / 2) * 10);
}

function makeFood(snakes) {
  const occupied = new Set(snakes.flatMap(snake => snake.body.map(point => `${point.x},${point.y}`)));
  const available = [];
  for (let y = 1; y < BOARD - 1; y++) for (let x = 1; x < BOARD - 1; x++) if (!occupied.has(`${x},${y}`)) available.push({ x, y });
  return available.length ? available[Math.floor(Math.random() * available.length)] : null;
}

function publicState(match) {
  const now = match.pausedAt ?? Date.now();
  const elapsedMs = match.startedAt ? Math.max(0, now - match.startedAt - match.pausedDurationMs) : 0;
  return {
    snakes: match.snakes.map(snake => ({ body: snake.body, direction: snake.direction, alive: snake.alive })),
    scores: match.scores,
    speedMultipliers: match.scores.map(score => Math.round((BASE_MOVE_MS / moveInterval(score)) * 10) / 10),
    food: match.food,
    elapsedSeconds: Math.floor(elapsedMs / 1000)
  };
}

function createMatch(first, second) {
  const players = [first, second];
  const match = {
    id: randomUUID(), players, accountIds: players.map(player => player.accountId || null), finished: false, phase: 'countdown',
    snakes: [
      makeSnake(5, 7, DIRECTIONS.right, DIRECTIONS.left),
      makeSnake(19, 17, DIRECTIONS.left, DIRECTIONS.right)
    ],
    scores: [0, 0], food: null, startedAt: 0, tickTimer: null,
    countdownTimer: null, countdownSeconds: COUNTDOWN_SECONDS,
    disconnected: new Map(), paused: false, pausedAt: null, pausedDurationMs: 0
  };
  match.food = makeFood(match.snakes);
  matches.set(match.id, match);
  players.forEach((player, index) => {
    player.match = match;
    player.playerIndex = index;
    player.connected = true;
    send(player, {
      type: 'match_found', matchId: match.id, playerIndex: index,
      players: players.map(item => ({ name: item.name }))
    });
  });
  runCountdown(match);
}

function stopCountdown(match) {
  if (!match.countdownTimer) return;
  clearInterval(match.countdownTimer);
  match.countdownTimer = null;
}

function runCountdown(match) {
  if (match.finished || match.phase !== 'countdown' || match.paused || match.countdownTimer) return;
  match.countdownTimer = setInterval(() => {
    if (match.finished || match.paused) { stopCountdown(match); return; }
    if (match.players.some(player => !player.connected || player.ws.readyState !== WebSocket.OPEN)) {
      stopCountdown(match);
      return;
    }
    const seconds = match.countdownSeconds;
    match.players.forEach(player => send(player, { type: 'countdown', seconds }));
    match.countdownSeconds -= 1;
    if (match.countdownSeconds < 1) {
      stopCountdown(match);
      startMatch(match);
    }
  }, 1000);
}

function startMatch(match) {
  if (match.finished) return;
  match.phase = 'playing';
  match.startedAt = Date.now();
  match.snakes.forEach(snake => { snake.lastMovedAt = match.startedAt; });
  const state = publicState(match);
  match.players.forEach(player => send(player, { type: 'match_start', state }));
  scheduleNextTick(match);
}

function scheduleNextTick(match) {
  if (match.finished || match.paused) return;
  match.tickTimer = setTimeout(() => {
    tickMatch(match);
    scheduleNextTick(match);
  }, HEARTBEAT_MS);
}

function isSame(a, b) { return a.x === b.x && a.y === b.y; }

function tickMatch(match) {
  if (match.finished || match.paused) return;
  const now = Date.now();
  const moving = match.snakes.map((snake, index) => now - snake.lastMovedAt >= moveInterval(match.scores[index]));
  if (!moving.some(Boolean)) return;
  const nextHeads = match.snakes.map((snake, index) => moving[index]
    ? { x: snake.body[0].x + snake.nextDirection.x, y: snake.body[0].y + snake.nextDirection.y }
    : snake.body[0]);
  const eating = nextHeads.map((head, index) => moving[index] && Boolean(match.food && isSame(head, match.food)));
  const dead = [false, false];

  match.snakes.forEach((snake, index) => {
    if (!moving[index]) return;
    const head = nextHeads[index];
    const ownBody = eating[index] ? snake.body : snake.body.slice(0, -1);
    if (head.x < 1 || head.y < 1 || head.x >= BOARD - 1 || head.y >= BOARD - 1 || ownBody.some(point => isSame(point, head))) dead[index] = true;
  });

  for (let index = 0; index < 2; index++) {
    if (!moving[index]) continue;
    const otherIndex = 1 - index;
    const other = match.snakes[otherIndex];
    const otherBody = moving[otherIndex] && !eating[otherIndex] ? other.body.slice(0, -1) : other.body;
    if (otherBody.some(point => isSame(point, nextHeads[index]))) dead[index] = true;
  }
  if (moving[0] && moving[1] && isSame(nextHeads[0], nextHeads[1])) { dead[0] = true; dead[1] = true; }
  if (moving[0] && moving[1] && isSame(nextHeads[0], match.snakes[1].body[0]) && isSame(nextHeads[1], match.snakes[0].body[0])) { dead[0] = true; dead[1] = true; }

  if (dead[0] || dead[1]) {
    match.snakes.forEach((snake, index) => { snake.alive = !dead[index]; });
    finishMatch(match, dead[0] === dead[1] ? null : (dead[0] ? 1 : 0));
    return;
  }

  match.snakes.forEach((snake, index) => {
    if (!moving[index]) return;
    snake.direction = snake.nextDirection;
    snake.body.unshift(nextHeads[index]);
    if (eating[index]) match.scores[index] += 1;
    else snake.body.pop();
    snake.lastMovedAt = now;
    snake.turnLocked = false;
  });
  if (eating.some(Boolean)) match.food = makeFood(match.snakes);
  const state = publicState(match);
  match.players.forEach(player => send(player, { type: 'state', state }));
  if (!match.food) finishMatch(match, match.scores[0] === match.scores[1] ? null : (match.scores[0] > match.scores[1] ? 0 : 1));
}

function clearMatchReconnects(match) {
  stopCountdown(match);
  for (const player of match.disconnected.values()) {
    clearTimeout(player.reconnectTimer);
    if (player.playerId) suspendedPlayers.delete(player.playerId);
  }
  match.disconnected.clear();
  if (match.pausedAt !== null) {
    match.pausedDurationMs += Date.now() - match.pausedAt;
    match.pausedAt = null;
  }
  match.paused = false;
}

function rememberExpiredSession(playerId, result) {
  if (!playerId) return;
  const previous = expiredSessions.get(playerId);
  if (previous) clearTimeout(previous.timer);
  const record = {
    ...result,
    expiresAt: Date.now() + 60000,
    timer: setTimeout(() => expiredSessions.delete(playerId), 60000)
  };
  expiredSessions.set(playerId, record);
}

function finishMatch(match, winner, options = {}) {
  if (match.finished) return;
  match.finished = true;
  clearTimeout(match.tickTimer);
  clearMatchReconnects(match);
  matches.delete(match.id);
  const state = publicState(match);
  void persistMatchHistory(match, winner, state, options);
  match.players.forEach((player, index) => {
    player.match = null;
    player.playerIndex = null;
    if (options.forfeitIndex !== undefined && index !== options.forfeitIndex) {
      send(player, { type: 'opponent_left', winner, state, reason: options.reason || 'forfeit' });
    } else {
      send(player, { type: 'match_over', winner, state, reason: index === options.forfeitIndex ? 'forfeit' : undefined });
    }
  });
}

function leaveMatch(client) {
  const match = client.match;
  if (!match || match.finished) return;
  const quitterIndex = client.playerIndex;
  const winner = 1 - quitterIndex;
  const disconnectedOpponent = match.disconnected.get(winner);
  const state = publicState(match);
  finishMatch(match, winner, { forfeitIndex: quitterIndex, reason: 'forfeit' });
  if (disconnectedOpponent) {
    rememberExpiredSession(disconnectedOpponent.playerId, {
      type: 'match_expired', winner: quitterIndex, playerIndex: winner, state, reason: 'opponent_left',
      players: match.players.map(player => ({ name: player.name }))
    });
  }
}

function pauseMatchForDisconnect(client) {
  const match = client.match;
  if (!match || match.finished || client.playerIndex === null) return;
  const index = client.playerIndex;
  client.connected = false;
  if (!match.paused) {
    match.paused = true;
    match.pausedAt = Date.now();
    clearTimeout(match.tickTimer);
    match.tickTimer = null;
    stopCountdown(match);
  }
  match.disconnected.set(index, client);
  suspendedPlayers.set(client.playerId, { match, client, index });
  client.reconnectTimer = setTimeout(() => expireDisconnectedPlayer(match, index, client), RECONNECT_GRACE_MS);
  const opponent = match.players[1 - index];
  send(opponent, {
    type: 'opponent_disconnected', phase: match.phase,
    reconnectInSeconds: Math.ceil(RECONNECT_GRACE_MS / 1000), state: publicState(match)
  });
}

function resumeDisconnectedPlayer(client) {
  const suspended = suspendedPlayers.get(client.playerId);
  if (!suspended) return false;
  const { match, client: previousClient, index } = suspended;
  if (match.finished || match.disconnected.get(index) !== previousClient) {
    suspendedPlayers.delete(client.playerId);
    return false;
  }

  clearTimeout(previousClient.reconnectTimer);
  suspendedPlayers.delete(client.playerId);
  match.disconnected.delete(index);
  client.name = previousClient.name;
  client.match = match;
  client.playerIndex = index;
  client.connected = true;
  match.players[index] = client;
  previousClient.match = null;
  previousClient.playerIndex = null;

  if (match.disconnected.size === 0 && match.paused) {
    const now = Date.now();
    if (match.pausedAt !== null) match.pausedDurationMs += now - match.pausedAt;
    match.pausedAt = null;
    match.paused = false;
    if (match.phase === 'playing') {
      match.snakes.forEach(snake => { snake.lastMovedAt = now; });
      scheduleNextTick(match);
    } else {
      runCountdown(match);
    }
  }

  const state = publicState(match);
  const players = match.players.map(player => ({ name: player.name }));
  send(client, {
    type: 'match_resumed', matchId: match.id, playerIndex: index, players,
    phase: match.phase, paused: match.paused, countdownSeconds: match.countdownSeconds, state
  });
  send(match.players[1 - index], {
    type: 'opponent_reconnected', phase: match.phase,
    paused: match.paused, countdownSeconds: match.countdownSeconds, state
  });
  return true;
}

function resumeActivePlayer(client) {
  const previousClient = [...clients].find(item => item !== client && item.playerId === client.playerId && item.match && !item.match.finished);
  if (!previousClient) return false;
  const match = previousClient.match;
  const index = previousClient.playerIndex;
  if (!match.paused) {
    match.paused = true;
    match.pausedAt = Date.now();
    clearTimeout(match.tickTimer);
    match.tickTimer = null;
    stopCountdown(match);
  }
  previousClient.connected = false;
  clients.delete(previousClient);
  match.disconnected.set(index, previousClient);
  suspendedPlayers.set(client.playerId, { match, client: previousClient, index });
  previousClient.ws.close(4001, 'Player reconnected');
  return resumeDisconnectedPlayer(client);
}

function expireDisconnectedPlayer(match, index, client) {
  if (match.finished || match.disconnected.get(index) !== client) return;
  const otherIndex = 1 - index;
  const state = publicState(match);
  if (match.disconnected.has(otherIndex)) {
    const disconnectedPlayers = [...match.disconnected.entries()];
    finishMatch(match, null);
    for (const [playerIndex, player] of disconnectedPlayers) {
      rememberExpiredSession(player.playerId, {
        type: 'match_expired', winner: null, playerIndex, state, reason: 'both_disconnected',
        players: match.players.map(item => ({ name: item.name }))
      });
    }
    return;
  }
  finishMatch(match, otherIndex, { forfeitIndex: index, reason: 'reconnect_timeout' });
  rememberExpiredSession(client.playerId, {
    type: 'match_expired', winner: otherIndex, playerIndex: index, state, reason: 'reconnect_timeout',
    players: match.players.map(player => ({ name: player.name }))
  });
}

async function processHello(client, message, requestId) {
  client.playerId = cleanPlayerId(message.playerId);
  client.name = cleanName(message.name);
  const auth = await verifySupabaseToken(message.accessToken);
  if (client.identityRequestId !== requestId) return;
  client.accountId = auth.accountId;
  client.authStatus = auth.status;
  send(client, { type: 'welcome', playerId: client.playerId, name: client.name, authenticated: Boolean(client.accountId), authStatus: auth.status, historySyncReady: Boolean(client.accountId && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
  if (message.accessToken && auth.status === 'invalid') send(client, { type: 'auth_error', message: 'Your login session expired. Sign in again to sync match history.' });
  if (resumeDisconnectedPlayer(client) || (message.resumeMatch && resumeActivePlayer(client))) return;
  const expired = expiredSessions.get(client.playerId);
  if (expired && expired.expiresAt > Date.now()) {
    clearTimeout(expired.timer); expiredSessions.delete(client.playerId);
    send(client, { type: expired.type, winner: expired.winner, playerIndex: expired.playerIndex, state: expired.state, reason: expired.reason, players: expired.players });
  } else if (message.resumeMatch) send(client, { type: 'resume_unavailable' });
}

async function handleMessage(client, payload) {
  let message;
  try { message = JSON.parse(payload.toString()); }
  catch { send(client, { type: 'error', message: 'Invalid message format.' }); return; }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'hello') {
    client.identityRequestId = (client.identityRequestId || 0) + 1;
    client.identityReady = processHello(client, message, client.identityRequestId);
    await client.identityReady;
    return;
  }
  await client.identityReady;
  if (message.type === 'join_queue') {
    queueClient(client, message.name);
  } else if (message.type === 'cancel_queue') {
    removeFromQueue(client);
    send(client, { type: 'queue_cancelled' });
  } else if (message.type === 'turn') {
    const next = DIRECTIONS[message.direction];
    const snake = client.match?.snakes[client.playerIndex];
    if (!next || !snake || client.match.finished || client.match.paused || !client.match.startedAt) return;
    if (snake.turnLocked) return;
    if (next.x === snake.nextDirection.x && next.y === snake.nextDirection.y) return;
    if (next.x === -snake.nextDirection.x && next.y === -snake.nextDirection.y) return;
    snake.nextDirection = next;
    snake.turnLocked = true;
  } else if (message.type === 'leave_match') {
    removeFromQueue(client);
    leaveMatch(client);
  } else if (message.type === 'ping') {
    send(client, { type: 'pong', at: Date.now() });
  }
}

wss.on('connection', ws => {
  const client = { ws, playerId: null, name: 'Guest', accountId: null, authStatus: 'guest', identityReady: Promise.resolve(), identityRequestId: 0, queued: false, match: null, playerIndex: null, alive: true, connected: true };
  clients.add(client);
  ws.on('pong', () => { client.alive = true; });
  ws.on('message', payload => { handleMessage(client, payload).catch(error => { console.warn('Message handling failed:', error.message); send(client, { type: 'error', message: 'Could not process that request.' }); }); });
  ws.on('error', error => console.warn('WebSocket error:', error.message));
  ws.on('close', () => {
    removeFromQueue(client);
    if (!shuttingDown) pauseMatchForDisconnect(client);
    clients.delete(client);
  });
});

let shuttingDown = false;
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) { client.ws.terminate(); continue; }
    client.alive = false;
    client.ws.ping();
  }
}, CLIENT_HEARTBEAT_MS);

server.listen(PORT, '0.0.0.0', () => console.log(`Snake Duel match server listening on ${PORT}`));

function shutdown() {
  shuttingDown = true;
  clearInterval(heartbeat);
  for (const match of matches.values()) {
    clearTimeout(match.tickTimer);
    stopCountdown(match);
    clearMatchReconnects(match);
  }
  for (const expired of expiredSessions.values()) clearTimeout(expired.timer);
  expiredSessions.clear();
  wss.clients.forEach(client => client.close(1001, 'Server restarting'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
