'use strict';
/* Renders every screen of the client against REAL server states using a stubbed DOM (no browser needed). */
process.env.BP_REVEAL_MIN_MS = '30';
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const server = require('../server.js');
let base;
const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

function sseOnce(code, token, pred) {
  return new Promise(async (ok, no) => {
    const ac = new AbortController(); const t = setTimeout(() => no(new Error('timeout')), 4000);
    const r = await fetch(`${base}/api/events?code=${code}&token=${token}`, { signal: ac.signal });
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ch = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /event: state\ndata: (.*)/s.exec(ch); if (m) { const v = JSON.parse(m[1]); if (pred(v)) { clearTimeout(t); ac.abort(); return ok(v); } } } }
  });
}
function makeCtx() {
  const el = { innerHTML: '', addEventListener() {}, contains() { return false; }, querySelector() { return null; } };
  const doc = { getElementById: id => id === 'app' ? el : null, activeElement: null, addEventListener() {} };
  const ctx = { document: doc, window: { matchMedia: () => ({ matches: true }), scrollTo() {}, confirm() { return true; }, prompt() {} }, navigator: {},
    location: { search: '', origin: 'http://x' }, history: { replaceState() {} }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; }, fetch: async () => ({}), console, setTimeout, clearTimeout, setInterval: () => 0, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/engine.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/^'use strict';/, ''), ctx);
  return { ctx, el };
}
(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port;
  const { ctx, el } = makeCtx();
  const feed = (v, token) => { ctx.__v = v; vm.runInContext('session={code:__v.code,token:"t"};online=true;onState(__v);', ctx); return el.innerHTML; };
  vm.runInContext('render()', ctx);
  assert(el.innerHTML.includes('Create a room'), 'home screen');

  const c = await post('/api/create', { name: 'Ann <b>' }); const j = await post('/api/join', { code: c.code, name: 'Bob' });
  for (const t of [c, j]) fetch(`${base}/api/events?code=${c.code}&token=${t.token}`).then(r => r.body.getReader().read().then(function p(x) { return x.done ? 0 : r.body.getReader; })).catch(() => {}); // keep both seats online
  let v = await sseOnce(c.code, c.token, x => x.seats.length === 2);
  let html = feed(v); assert(html.includes('Share the code') && html.includes(c.code) && !html.includes('<b>Ann <b>'), 'lobby (escaped)');
  await post('/api/action', { code: c.code, token: c.token, type: 'fillBots' });
  await post('/api/action', { code: c.code, token: c.token, type: 'chat', text: '<img src=x onerror=alert(1)>' });
  v = await sseOnce(c.code, c.token, x => x.seats.length === 4 && x.chat.length === 1);
  html = feed(v); assert(html.includes('Open the first round') && !html.includes('<img src=x'), 'lobby full + chat escaped');
  await post('/api/action', { code: c.code, token: c.token, type: 'start' });
  v = await sseOnce(c.code, c.token, x => x.phase === 'choose');
  html = feed(v); assert(html.includes('Step 1') && html.includes('Seal my choice') && html.includes('Thinking'), 'choose screen');
  vm.runInContext('draft={contract:1,energy:4,action:"betray",boost:false};render()', ctx);
  assert(el.innerHTML.includes('lifts the difficulty'), 'betray hint');
  await post('/api/action', { code: c.code, token: c.token, type: 'seal', contract: 1, energy: 4, action: 'coop' });
  v = await sseOnce(c.code, c.token, x => x.game && x.game.mine);
  html = feed(v); assert(html.includes('Your pact is sealed') && html.includes('Waiting for'), 'sealed screen');
  await post('/api/action', { code: c.code, token: c.token, type: 'timer', value: 60 }); // ignored (not lobby) -> fine
  await post('/api/action', { code: j.code, token: j.token, type: 'seal', contract: 0, energy: 2, action: 'betray' });
  v = await sseOnce(c.code, c.token, x => x.phase === 'reveal');
  vm.runInContext('anim={round:0,cstate:[]}', ctx);
  html = feed(v); assert(html.includes('Sealed'), 'animation starts sealed'); await new Promise(r => setTimeout(r, 80)); vm.runInContext('render()', ctx); html = el.innerHTML; assert(html.includes('Break the seals') && html.includes('Ready for next round') && html.includes('Scoreboard'), 'reveal screen');
  for (let r = 1; r <= 8; r++) {
    await post('/api/action', { code: c.code, token: c.token, type: 'ready' }); await post('/api/action', { code: j.code, token: j.token, type: 'ready' });
    if (r === 8) break;
    v = await sseOnce(c.code, c.token, x => x.phase === 'choose' && x.game.round === r + 1);
    for (const t of [c, j]) await post('/api/action', { code: c.code, token: t.token, type: 'seal', contract: r % 4, energy: 3, action: 'coop' });
    v = await sseOnce(c.code, c.token, x => x.phase === 'reveal' && x.game.round === r + 1);
  }
  v = await sseOnce(c.code, c.token, x => x.phase === 'final');
  html = feed(v); assert(html.includes('Final tally') && html.includes('How the purses moved') && html.includes('Play again, same room'), 'final screen');
  vm.runInContext('showRules=true;render()', ctx); assert(el.innerHTML.includes('Back to the game'), 'rules');
  console.log('render check passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
