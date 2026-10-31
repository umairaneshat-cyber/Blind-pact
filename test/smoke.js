'use strict';
/* End-to-end test: starts the server, plays a full 8-round game with 3 humans + 1 bot over real HTTP/SSE. */
process.env.BP_REVEAL_MIN_MS = '30';
process.env.BP_OFFLINE_MS = '300';
const assert = require('assert');
const server = require('../server.js');

let base;
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

function client(code, token) {
  const c = { v: null, waiters: [], ac: new AbortController() };
  (async () => {
    const r = await fetch(`${base}/api/events?code=${code}&token=${token}`, { signal: c.ac.signal });
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /event: (\w+)\ndata: (.*)/s.exec(chunk);
          if (m && m[1] === 'state') { c.v = JSON.parse(m[2]); c.waiters = c.waiters.filter(w => !w(c.v)); }
        }
      }
    } catch (e) {}
  })();
  c.until = (pred, ms = 4000) => new Promise((ok, no) => {
    if (c.v && pred(c.v)) return ok(c.v);
    const t = setTimeout(() => no(new Error('timeout waiting; phase=' + (c.v && c.v.phase))), ms);
    c.waiters.push(v => { if (pred(v)) { clearTimeout(t); ok(v); return true; } return false; });
  });
  c.close = () => c.ac.abort();
  return c;
}

(async () => {
  await new Promise(r => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;

  const created = await post('/api/create', { name: 'Host' });
  const code = created.body.code;
  assert(/^[A-Z]{4}$/.test(code), 'room code');
  const j1 = await post('/api/join', { code, name: 'Bea' });
  const j2 = await post('/api/join', { code: code.toLowerCase(), name: 'Host' }); // duplicate name gets suffix
  assert.strictEqual(j1.status, 200); assert.strictEqual(j2.status, 200);
  assert.strictEqual((await post('/api/join', { code: 'ZZZZ', name: 'x' })).status, 404);

  const H = client(code, created.body.token), B = client(code, j1.body.token), C = client(code, j2.body.token);
  const clients = [H, B, C];
  const act = (c, tok, type, extra) => post('/api/action', Object.assign({ code, token: tok, type }, extra));
  const toks = [created.body.token, j1.body.token, j2.body.token];

  let v = await H.until(x => x.seats.length === 3);
  assert.strictEqual(v.seats[2].name, 'Host 2');
  // non-host can't start; need >=4 seats
  assert.strictEqual((await act(B, toks[1], 'start')).status, 403);
  assert.strictEqual((await act(H, toks[0], 'start')).status, 400);
  assert.strictEqual((await act(H, toks[0], 'addBot', { botType: 'snake' })).status, 200);
  await act(H, toks[0], 'chat', { text: 'I will cooperate, promise' });
  v = await B.until(x => x.chat.length === 1 && x.seats.length === 4);
  assert.strictEqual((await act(H, toks[0], 'timer', { value: 60 })).status, 200);
  assert.strictEqual((await act(H, toks[0], 'start')).status, 200);
  // game full / started: stranger cannot join
  assert.strictEqual((await post('/api/join', { code, name: 'Eve' })).status, 400);

  for (let round = 1; round <= 8; round++) {
    for (const c of clients) await c.until(x => x.phase === 'choose' && x.game.round === round);
    // privacy: before reveal nobody sees result or another seat's pledge
    for (let i = 0; i < 3; i++) {
      const cv = clients[i].v;
      assert.strictEqual(cv.game.result, null, 'no result leak');
      assert.strictEqual(cv.game.mine, null);
    }
    const useForce = round === 2;
    for (let i = 0; i < 3; i++) {
      if (useForce && i === 2) continue; // this player never seals; host forces
      const r = await act(clients[i], toks[i], 'seal', { contract: (i + round) % 4, energy: 1 + ((i + round) % 5), action: (i + round) % 3 === 0 ? 'betray' : 'coop', boost: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      if (i === 0) {
        const mine = await H.until(x => x.game.mine);
        assert(mine.game.mine.contract >= 0);
        // peers must not see my pledge, only the sealed flag
        const bv = await B.until(x => x.game.players[0].sealed);
        assert.strictEqual(bv.game.mine, null);
        assert.strictEqual((await act(H, toks[0], 'seal', { contract: 0, energy: 1, action: 'coop' })).status, 400, 'double seal rejected');
      }
    }
    if (useForce) {
      assert.strictEqual((await act(B, toks[1], 'force')).status, 403);
      await H.until(x => x.game.players[1].sealed);
      assert.strictEqual((await act(H, toks[0], 'force')).status, 200);
    }
    for (const c of clients) {
      const rv = await c.until(x => x.phase === 'reveal' && x.game.round === round);
      assert.strictEqual(rv.game.result.length, 4);
      rv.game.result.forEach(r => { if (!r.empty && !r.void) assert(r.dice[0] >= 1 && r.dice[1] <= 6); });
    }
    for (let i = 0; i < 3; i++) await act(clients[i], toks[i], 'ready');
  }
  for (const c of clients) {
    const f = await c.until(x => x.phase === 'final');
    assert.strictEqual(f.game.coinHist.length, 9);
  }
  const total = H.v.game.players.reduce((s, p) => s + p.coins, 0);
  assert(total > 0);

  // play again -> lobby, then rejoin flow check mid-game
  assert.strictEqual((await act(B, toks[1], 'again')).status, 403);
  assert.strictEqual((await act(H, toks[0], 'again')).status, 200);
  await H.until(x => x.phase === 'lobby' && x.game === null);
  await act(H, toks[0], 'start');
  await C.until(x => x.phase === 'choose');
  C.close();
  await H.until(x => x.game && !x.game.players[2].connected, 3000);
  const rj = await post('/api/join', { code, name: 'host 2' });
  assert.strictEqual(rj.status, 200, 'rejoin by name');
  assert.strictEqual((await act(C, toks[2], 'chat', { text: 'old token' })).status, 404, 'old token invalid');
  const C2 = client(code, rj.body.token);
  const rv = await C2.until(x => x.game && x.you === 2);
  assert.strictEqual(rv.phase, 'choose');

  // leaving mid-game hands the seat to a bot
  await act(C2, rj.body.token, 'leave');
  await H.until(x => x.game.players[2].bot === 'fox');

  clients.forEach(c => c.close()); C2.close();
  console.log('smoke test passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
