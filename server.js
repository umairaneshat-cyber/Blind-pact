'use strict';
/*
 * Blind Pact: online multiplayer server.
 * - Zero dependencies. Node 18+.
 * - Rooms live in memory. The server is authoritative: it rolls the dice, runs bots,
 *   and never sends other players' sealed choices until the reveal.
 * - Realtime = Server-Sent Events (server -> client) + plain POST (client -> server).
 *   This works behind every normal proxy/host without WebSocket configuration.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/engine.js');
const { ROUNDS, BOTS, BOOST_COST, freshGame, startRound, resolveRound, botDecide } = E;

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIN_SEATS = 4, MAX_SEATS = 6;
const REVEAL_MIN_MS = Number(process.env.BP_REVEAL_MIN_MS || 7500); // lets every client finish the dice animation
const TIMERS = [0, 60, 90, 120, 180];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_ROOMS = 500;
const BOT_KEYS = Object.keys(BOTS);

const rooms = new Map();

/* ---------- helpers ---------- */
const rid = n => crypto.randomBytes(n).toString('hex');
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHA[crypto.randomInt(ALPHA.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(s, fallback) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || fallback;
}
function fail(code, msg) { const e = new Error(msg); e.status = code; return e; }

/* ---------- rooms and seats ---------- */
function makeRoom() {
  if (rooms.size >= MAX_ROOMS) throw fail(503, 'The server is full right now. Try again in a few minutes.');
  const room = {
    code: newCode(), seats: [], hostSeat: null, phase: 'lobby', settings: { timer: 120 },
    game: null, ready: new Set(), revealAt: 0, deadline: 0, timerH: null, advH: null,
    chat: [], created: Date.now(), lastSeen: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}
function uniqueName(room, name) {
  const taken = n => room.seats.some(s => s.kind === 'human' && s.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let i = 2; ; i++) { const c = name.slice(0, 13) + ' ' + i; if (!taken(c)) return c; }
}
function addHuman(room, name) {
  const seat = {
    token: rid(16), kind: 'human', botType: null, conns: new Set(), lastChat: 0,
    name: uniqueName(room, cleanName(name, 'Player ' + (room.seats.length + 1)))
  };
  room.seats.push(seat);
  return seat;
}
function addBot(room, botType) {
  if (!BOTS[botType]) {
    const used = new Set(room.seats.filter(s => s.kind === 'bot').map(s => s.botType));
    const free = BOT_KEYS.filter(k => !used.has(k));
    const pool = free.length ? free : BOT_KEYS;
    botType = pool[crypto.randomInt(pool.length)];
  }
  room.seats.push({ token: null, kind: 'bot', botType, name: BOTS[botType].name, conns: new Set(), lastChat: 0 });
}
function humans(room) { return room.seats.filter(s => s.kind === 'human'); }
function ensureHost(room) {
  const hs = humans(room);
  if (!hs.length) return;
  const cur = room.hostSeat;
  if (cur && room.seats.includes(cur) && (cur.conns.size || !hs.some(s => s.conns.size))) return;
  room.hostSeat = hs.find(s => s.conns.size) || hs[0];
}
function destroyRoom(room) {
  clearTimeout(room.timerH); clearTimeout(room.advH);
  for (const s of room.seats) for (const r of s.conns) { try { r.end(); } catch (e) {} }
  rooms.delete(room.code);
}
function removeSeat(room, seat, kickedMsg) {
  const i = room.seats.indexOf(seat);
  if (i < 0) return;
  room.seats.splice(i, 1);
  for (const r of seat.conns) { try { if (kickedMsg) send(r, 'kicked', { msg: kickedMsg }); r.end(); } catch (e) {} }
  seat.conns.clear();
  if (!humans(room).length) return destroyRoom(room);
  ensureHost(room);
}

/* ---------- views (what each player may see) ---------- */
function view(room, seat) {
  const you = room.seats.indexOf(seat), g = room.game;
  const v = {
    code: room.code, phase: room.phase, now: Date.now(), you,
    hostIdx: room.seats.indexOf(room.hostSeat), timer: room.settings.timer,
    min: MIN_SEATS, max: MAX_SEATS, revealAt: room.revealAt,
    seats: room.seats.map((s, i) => ({
      idx: i, name: s.name, kind: s.kind, botType: s.botType,
      connected: s.kind === 'human' ? s.conns.size > 0 : true
    })),
    chat: room.chat.slice(-60), game: null
  };
  if (g) {
    const showResult = room.phase === 'reveal' || room.phase === 'final';
    v.game = {
      round: g.round, contracts: g.contracts, ledger: g.ledger, coinHist: g.coinHist,
      players: g.players.map((p, i) => {
        const s = room.seats[i];
        return {
          id: p.id, name: p.name, bot: p.bot, coins: p.coins, tokens: p.tokens, last: p.last, stats: p.stats,
          connected: s.kind === 'human' ? s.conns.size > 0 : true,
          sealed: p.bot ? true : !!g.choices[p.id],
          ready: p.bot ? true : room.ready.has(p.id)
        };
      }),
      deadline: room.phase === 'choose' ? room.deadline : 0,
      mine: room.phase === 'choose' && g.choices[you] ? g.choices[you] : null, // only YOUR sealed pledge
      result: showResult ? g.result : null
    };
  }
  return v;
}
function send(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
}
function broadcast(room) {
  for (const seat of room.seats) {
    if (seat.kind !== 'human' || !seat.conns.size) continue;
    const v = view(room, seat);
    for (const res of seat.conns) send(res, 'state', v);
  }
}

/* ---------- game flow ---------- */
function startGame(room) {
  const setup = {
    n: room.seats.length,
    slots: room.seats.map(s => ({ type: s.kind === 'human' ? 'human' : s.botType, name: s.name }))
  };
  room.game = freshGame(setup);
  startRound(room.game, Math.random);
  room.phase = 'choose';
  room.ready = new Set();
  armTimer(room);
}
function armTimer(room) {
  clearTimeout(room.timerH);
  room.deadline = 0;
  const t = room.settings.timer;
  if (t > 0) {
    room.deadline = Date.now() + t * 1000;
    room.timerH = setTimeout(() => {
      if (room.phase === 'choose' && rooms.has(room.code)) { forceResolve(room); broadcast(room); }
    }, t * 1000 + 300);
  }
}
function resolve(room) {
  if (room.phase !== 'choose') return;
  clearTimeout(room.timerH);
  const g = room.game;
  g.players.filter(p => p.bot).forEach(p => { g.choices[p.id] = botDecide(g, p, Math.random); });
  g.result = resolveRound(g, Math.random);
  room.phase = 'reveal';
  room.revealAt = Date.now();
  room.deadline = 0;
  room.ready = new Set();
}
function forceResolve(room) {
  const g = room.game;
  g.players.forEach(p => {
    if (!p.bot && !g.choices[p.id]) g.choices[p.id] = botDecide(g, Object.assign({}, p, { bot: 'fox' }), Math.random);
  });
  resolve(room);
}
function maybeResolve(room) {
  const g = room.game;
  if (room.phase === 'choose' && g.players.every(p => p.bot || g.choices[p.id])) resolve(room);
}
function advance(room) {
  clearTimeout(room.advH);
  if (room.phase !== 'reveal') return;
  const g = room.game;
  room.ready = new Set();
  if (g.round >= ROUNDS) room.phase = 'final';
  else { startRound(g, Math.random); room.phase = 'choose'; armTimer(room); }
  broadcast(room);
}
function maybeAdvance(room) {
  if (room.phase !== 'reveal') return;
  const online = room.game.players.filter(p => !p.bot && room.seats[p.id].conns.size > 0);
  if (!online.length || !online.every(p => room.ready.has(p.id))) return;
  const wait = room.revealAt + REVEAL_MIN_MS - Date.now();
  clearTimeout(room.advH);
  if (wait > 0) room.advH = setTimeout(() => advance(room), wait); else advance(room);
}

/* ---------- player actions ---------- */
function act(room, seat, b) {
  const isHost = room.hostSeat === seat, idx = room.seats.indexOf(seat), g = room.game;
  const needHost = () => { if (!isHost) throw fail(403, 'Only the host can do that.'); };
  switch (b.type) {
    case 'addBot':
      needHost();
      if (room.phase !== 'lobby') throw fail(400, 'The game has already started.');
      if (room.seats.length >= MAX_SEATS) throw fail(400, 'All ' + MAX_SEATS + ' seats are taken.');
      addBot(room, b.botType);
      break;
    case 'fillBots':
      needHost();
      if (room.phase !== 'lobby') throw fail(400, 'The game has already started.');
      while (room.seats.length < MIN_SEATS) addBot(room);
      break;
    case 'removeSeat': {
      needHost();
      if (room.phase !== 'lobby') throw fail(400, 'Seats are locked once the game starts.');
      const t = room.seats[Number(b.idx)];
      if (!t || t === seat) throw fail(400, 'Cannot remove that seat.');
      removeSeat(room, t, 'The host removed you from the room.');
      break;
    }
    case 'timer':
      needHost();
      if (room.phase !== 'lobby') throw fail(400, 'Set the timer before the game starts.');
      if (!TIMERS.includes(Number(b.value))) throw fail(400, 'Bad timer.');
      room.settings.timer = Number(b.value);
      break;
    case 'start':
      needHost();
      if (room.phase !== 'lobby') throw fail(400, 'Already started.');
      if (room.seats.length < MIN_SEATS) throw fail(400, 'Need at least ' + MIN_SEATS + ' seats. Add bots to fill the table.');
      startGame(room);
      break;
    case 'seal': {
      if (room.phase !== 'choose') throw fail(400, 'Not accepting pledges right now.');
      const p = g.players[idx];
      if (!p || p.bot) throw fail(400, 'No seat.');
      if (g.choices[idx]) throw fail(400, 'You already sealed this round.');
      const c = Number(b.contract), e = Number(b.energy);
      if (!Number.isInteger(c) || c < 0 || c >= g.contracts.length) throw fail(400, 'Pick a contract.');
      if (!Number.isInteger(e) || e < 1 || e > 5) throw fail(400, 'Energy must be 1 to 5.');
      if (b.action !== 'coop' && b.action !== 'betray') throw fail(400, 'Cooperate or betray?');
      g.choices[idx] = { contract: c, energy: e, action: b.action, boost: !!b.boost && p.tokens >= BOOST_COST };
      maybeResolve(room);
      break;
    }
    case 'force':
      needHost();
      if (room.phase !== 'choose') throw fail(400, 'Nothing to reveal.');
      forceResolve(room);
      break;
    case 'ready':
      if (room.phase !== 'reveal') throw fail(400, 'Not in the reveal.');
      room.ready.add(idx);
      maybeAdvance(room);
      break;
    case 'skip':
      needHost();
      if (room.phase !== 'reveal') throw fail(400, 'Not in the reveal.');
      if (Date.now() < room.revealAt + REVEAL_MIN_MS) throw fail(400, 'The seals are still breaking.');
      advance(room);
      return;
    case 'again':
      needHost();
      if (room.phase !== 'final') throw fail(400, 'The game is not over.');
      clearTimeout(room.timerH); clearTimeout(room.advH);
      room.seats.filter(s => s.kind === 'human' && !s.conns.size).forEach(s => removeSeat(room, s));
      if (!rooms.has(room.code)) return;
      room.phase = 'lobby'; room.game = null; room.ready = new Set(); room.deadline = 0; room.revealAt = 0;
      break;
    case 'chat': {
      const text = String(b.text == null ? '' : b.text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
      if (!text) return;
      const now = Date.now();
      if (now - seat.lastChat < 400) throw fail(429, 'Slow down a little.');
      seat.lastChat = now;
      room.chat.push({ seat: idx, name: seat.name, text, t: now });
      if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);
      break;
    }
    case 'leave':
      if (room.phase === 'lobby') {
        removeSeat(room, seat);
      } else {
        // In a running game the seat is taken over by a bot so the table can finish.
        seat.kind = 'bot'; seat.botType = 'fox';
        g.players[idx].bot = 'fox';
        for (const r of seat.conns) { try { r.end(); } catch (e) {} }
        seat.conns.clear();
        if (!humans(room).length) return destroyRoom(room);
        ensureHost(room);
        maybeResolve(room);
        maybeAdvance(room);
      }
      break;
    default:
      throw fail(400, 'Unknown action.');
  }
  if (rooms.has(room.code)) broadcast(room);
}

/* ---------- http ---------- */
const hits = new Map();
function limited(ip, max) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function readJSON(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 8192) { no(fail(413, 'Too large.')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(fail(400, 'Bad JSON.')); } });
    req.on('error', no);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
function findSeat(room, token) { return token ? room.seats.find(s => s.token && s.token === token) : null; }

async function api(req, res, url) {
  const b = await readJSON(req);
  const name = url.pathname;
  if (name === '/api/create') {
    if (limited(ipOf(req), 12)) throw fail(429, 'Too many requests. Wait a minute.');
    const room = makeRoom();
    const seat = addHuman(room, b.name);
    room.hostSeat = seat;
    return json(res, 200, { code: room.code, token: seat.token });
  }
  if (name === '/api/join') {
    if (limited(ipOf(req), 30)) throw fail(429, 'Too many requests. Wait a minute.');
    const room = rooms.get(cleanCode(b.code));
    if (!room) throw fail(404, 'No room with that code.');
    room.lastSeen = Date.now();
    let seat;
    if (room.phase === 'lobby') {
      if (room.seats.length >= MAX_SEATS) throw fail(400, 'That room is full.');
      seat = addHuman(room, b.name);
    } else {
      // Game running: you can only take back your own disconnected seat, by name.
      const want = cleanName(b.name, '').toLowerCase();
      const i = want ? room.game.players.findIndex((p, k) => !p.bot && room.seats[k].kind === 'human' && !room.seats[k].conns.size &&
        (p.name.toLowerCase() === want || room.seats[k].name.toLowerCase() === want)) : -1;
      if (i < 0) throw fail(400, 'That game has already started. To rejoin, use the exact name you played under.');
      seat = room.seats[i];
      seat.token = rid(16);
    }
    broadcast(room);
    return json(res, 200, { code: room.code, token: seat.token });
  }
  if (name === '/api/action') {
    const room = rooms.get(cleanCode(b.code));
    const seat = room && findSeat(room, b.token);
    if (!seat) throw fail(404, 'You are not in that room.');
    room.lastSeen = Date.now();
    act(room, seat, b);
    return json(res, 200, { ok: true });
  }
  throw fail(404, 'Not found.');
}

function events(req, res, url) {
  const room = rooms.get(cleanCode(url.searchParams.get('code')));
  const seat = room && findSeat(room, url.searchParams.get('token'));
  if (!seat) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No such room or seat.'); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  seat.conns.add(res);
  room.lastSeen = Date.now();
  ensureHost(room);
  broadcast(room);
  req.on('close', () => {
    seat.conns.delete(res);
    room.lastSeen = Date.now();
    if (!rooms.has(room.code) || !room.seats.includes(seat)) return;
    if (!seat.conns.size) scheduleOffline(room, seat);
    broadcast(room);
    maybeAdvance(room);
  });
}
function scheduleOffline(room, seat) {
  setTimeout(() => {
    if (!rooms.has(room.code) || !room.seats.includes(seat) || seat.conns.size) return;
    if (room.phase === 'lobby') { removeSeat(room, seat); }
    else ensureHost(room);
    if (rooms.has(room.code)) broadcast(room);
  }, Number(process.env.BP_OFFLINE_MS || 60000));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain'
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res, url);
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    res.writeHead(405); res.end();
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    else try { res.end(); } catch (x) {}
  }
});

/* keep-alive pings + cleanup of abandoned rooms */
setInterval(() => {
  for (const room of rooms.values()) for (const s of room.seats) for (const r of s.conns) { try { r.write(': ping\n\n'); } catch (e) {} }
}, 20000).unref();
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const anyone = room.seats.some(s => s.conns.size);
    if ((!anyone && now - room.lastSeen > 20 * 60000) || now - room.created > 12 * 3600000) destroyRoom(room);
  }
  for (const [ip, arr] of hits) if (!arr.some(t => now - t < 60000)) hits.delete(ip);
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Blind Pact online on http://localhost:' + PORT));
}
module.exports = server;
