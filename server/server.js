'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 10000;
const BOARD = 25;
const TICK_MS = 140;
const COUNTDOWN_SECONDS = 3;
const MAX_CLIENTS = 500;
const MAX_MESSAGE_BYTES = 1024;
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
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ') : '';
  return (name || `Guest-${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 20);
}

function cleanPlayerId(value) {
  if (typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value)) return value;
  return randomUUID();
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
  return { body, direction, nextDirection: direction, alive: true };
}

function makeFood(snakes) {
  const occupied = new Set(snakes.flatMap(snake => snake.body.map(point => `${point.x},${point.y}`)));
  const available = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) if (!occupied.has(`${x},${y}`)) available.push({ x, y });
  return available.length ? available[Math.floor(Math.random() * available.length)] : null;
}

function publicState(match) {
  return {
    snakes: match.snakes.map(snake => ({ body: snake.body, direction: snake.direction, alive: snake.alive })),
    scores: match.scores,
    food: match.food,
    elapsedSeconds: Math.floor((Date.now() - match.startedAt) / 1000)
  };
}

function createMatch(first, second) {
  const players = [first, second];
  const match = {
    id: randomUUID(), players, timers: new Set(), finished: false,
    snakes: [
      makeSnake(5, 7, DIRECTIONS.right, DIRECTIONS.left),
      makeSnake(19, 17, DIRECTIONS.left, DIRECTIONS.right)
    ],
    scores: [0, 0], food: null, startedAt: 0, tickTimer: null, tickNumber: 0
  };
  match.food = makeFood(match.snakes);
  matches.set(match.id, match);
  players.forEach((player, index) => {
    player.match = match;
    player.playerIndex = index;
    send(player, {
      type: 'match_found', matchId: match.id, playerIndex: index,
      players: players.map(item => ({ name: item.name }))
    });
  });
  let seconds = COUNTDOWN_SECONDS;
  const countdown = setInterval(() => {
    if (match.finished || players.some(player => player.ws.readyState !== WebSocket.OPEN)) {
      clearInterval(countdown); return;
    }
    players.forEach(player => send(player, { type: 'countdown', seconds }));
    seconds -= 1;
    if (seconds < 1) {
      clearInterval(countdown);
      startMatch(match);
    }
  }, 1000);
  match.timers.add(countdown);
}

function startMatch(match) {
  if (match.finished) return;
  match.startedAt = Date.now();
  const state = publicState(match);
  match.players.forEach(player => send(player, { type: 'match_start', state }));
  match.tickTimer = setInterval(() => tickMatch(match), TICK_MS);
}

function isSame(a, b) { return a.x === b.x && a.y === b.y; }

function tickMatch(match) {
  if (match.finished) return;
  match.tickNumber += 1;
  const nextHeads = match.snakes.map(snake => ({
    x: snake.body[0].x + snake.nextDirection.x,
    y: snake.body[0].y + snake.nextDirection.y
  }));
  const eating = nextHeads.map(head => Boolean(match.food && isSame(head, match.food)));
  const dead = [false, false];

  match.snakes.forEach((snake, index) => {
    const head = nextHeads[index];
    const ownBody = eating[index] ? snake.body : snake.body.slice(0, -1);
    if (head.x < 0 || head.y < 0 || head.x >= BOARD || head.y >= BOARD || ownBody.some(point => isSame(point, head))) dead[index] = true;
  });

  for (let index = 0; index < 2; index++) {
    const otherIndex = 1 - index;
    const other = match.snakes[otherIndex];
    const otherBody = eating[otherIndex] ? other.body : other.body.slice(0, -1);
    if (otherBody.some(point => isSame(point, nextHeads[index]))) dead[index] = true;
  }
  if (isSame(nextHeads[0], nextHeads[1])) { dead[0] = true; dead[1] = true; }
  if (isSame(nextHeads[0], match.snakes[1].body[0]) && isSame(nextHeads[1], match.snakes[0].body[0])) { dead[0] = true; dead[1] = true; }

  if (dead[0] || dead[1]) {
    match.snakes.forEach((snake, index) => { snake.alive = !dead[index]; });
    finishMatch(match, dead[0] === dead[1] ? null : (dead[0] ? 1 : 0));
    return;
  }

  match.snakes.forEach((snake, index) => {
    snake.direction = snake.nextDirection;
    snake.body.unshift(nextHeads[index]);
    if (eating[index]) match.scores[index] += 1;
    else snake.body.pop();
  });
  if (eating.some(Boolean)) match.food = makeFood(match.snakes);
  const state = publicState(match);
  match.players.forEach(player => send(player, { type: 'state', state }));
  if (!match.food) finishMatch(match, match.scores[0] === match.scores[1] ? null : (match.scores[0] > match.scores[1] ? 0 : 1));
}

function finishMatch(match, winner) {
  if (match.finished) return;
  match.finished = true;
  clearInterval(match.tickTimer);
  for (const timer of match.timers) clearInterval(timer);
  matches.delete(match.id);
  const state = publicState(match);
  match.players.forEach(player => {
    player.match = null;
    player.playerIndex = null;
    send(player, { type: 'match_over', winner, state });
  });
}

function leaveMatch(client, message = 'opponent_left') {
  const match = client.match;
  if (!match || match.finished) return;
  const winner = 1 - client.playerIndex;
  match.finished = true;
  clearInterval(match.tickTimer);
  for (const timer of match.timers) clearInterval(timer);
  matches.delete(match.id);
  const opponent = match.players[winner];
  const state = publicState(match);
  for (const player of match.players) { player.match = null; player.playerIndex = null; }
  send(opponent, { type: message, winner, state });
  send(client, { type: 'match_over', winner, state, reason: 'forfeit' });
}

function handleMessage(client, payload) {
  let message;
  try { message = JSON.parse(payload.toString()); }
  catch { send(client, { type: 'error', message: 'Invalid message format.' }); return; }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'hello') {
    client.playerId = cleanPlayerId(message.playerId);
    client.name = cleanName(message.name);
    send(client, { type: 'welcome', playerId: client.playerId, name: client.name });
  } else if (message.type === 'join_queue') {
    queueClient(client, message.name);
  } else if (message.type === 'cancel_queue') {
    removeFromQueue(client);
    send(client, { type: 'queue_cancelled' });
  } else if (message.type === 'turn') {
    const next = DIRECTIONS[message.direction];
    const snake = client.match?.snakes[client.playerIndex];
    if (!next || !snake || client.match.finished || !client.match.startedAt) return;
    if (client.lastTurnTick === client.match.tickNumber) return;
    if (next.x === -snake.direction.x && next.y === -snake.direction.y) return;
    client.lastTurnTick = client.match.tickNumber;
    snake.nextDirection = next;
  } else if (message.type === 'leave_match') {
    removeFromQueue(client);
    leaveMatch(client);
  } else if (message.type === 'ping') {
    send(client, { type: 'pong', at: Date.now() });
  }
}

wss.on('connection', ws => {
  const client = { ws, playerId: null, name: 'Guest', queued: false, match: null, playerIndex: null, alive: true };
  clients.add(client);
  ws.on('pong', () => { client.alive = true; });
  ws.on('message', payload => handleMessage(client, payload));
  ws.on('error', error => console.warn('WebSocket error:', error.message));
  ws.on('close', () => {
    removeFromQueue(client);
    leaveMatch(client);
    clients.delete(client);
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) { client.ws.terminate(); continue; }
    client.alive = false;
    client.ws.ping();
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`Snake Duel match server listening on ${PORT}`));

function shutdown() {
  clearInterval(heartbeat);
  for (const match of matches.values()) {
    clearInterval(match.tickTimer);
    for (const timer of match.timers) clearInterval(timer);
  }
  wss.clients.forEach(client => client.close(1001, 'Server restarting'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
