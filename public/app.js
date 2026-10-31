'use strict';
/* Blind Pact online client. Rules + bots come from engine.js (shared with the server).
   The server is authoritative; this file only renders what the server sends. */
const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const rand6 = () => 1 + Math.floor(Math.random() * 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newDraft = () => ({ contract: null, energy: 3, action: null, boost: false });
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

let V = null;                       // latest view from the server
let session = null;                 // {code, token}
try { session = JSON.parse(ls.get('bp_session') || 'null'); } catch (e) { session = null; }
let es = null, online = false, offset = 0;
let draft = newDraft(), showRules = false, homeMsg = '', lastKey = null, sending = false;
let anim = { round: 0, cstate: [] };
const openRounds = {};
const drafts = { hname: ls.get('bp_name') || '', hcode: '', chatin: '' };
const urlRoom = (() => { try { return (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); } catch (e) { return ''; } })();
if (urlRoom) drafts.hcode = urlRoom;

const G = () => (V && V.game) || null;
const isHost = () => !!V && V.hostIdx === V.you;
const SEAL = px => `<svg class="waxseal" viewBox="0 0 48 48" width="${px}" height="${px}" role="img" aria-label="Wax seal"><circle cx="24" cy="24" r="22" style="fill:var(--seal)"/><circle cx="24" cy="24" r="16.5" style="fill:none;stroke:var(--seal-ink);stroke-opacity:.55;stroke-width:1.5;stroke-dasharray:2 3"/><path d="M17.5 15h8a4.8 4.8 0 0 1 0 9.5h-8zM17.5 24.5h9a4.8 4.8 0 0 1 0 9.5h-9z" style="fill:none;stroke:var(--seal-ink);stroke-width:2.4;stroke-linejoin:round"/></svg>`;
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const die = n => `<span class="die" role="img" aria-label="Die showing ${n}">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => `<i${PIPS[n].includes(k) ? ' class="on"' : ''}></i>`).join('')}</span>`;
const dot = i => `<i class="dot" style="background:var(--p${i % 6})"></i>`;
const pname = p => `${dot(p.id)}${esc(p.name)}`;
const soloOdds = c => Math.round(diceProb(c.diff - 5) * 100);
const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

/* ---------- network ---------- */
async function api(path, body) {
  let r;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new Error('Cannot reach the server. Check your connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}
function act(type, extra) {
  if (!session) return Promise.resolve();
  return api('/api/action', Object.assign({ code: session.code, token: session.token, type }, extra || {}))
    .catch(e => toast(e.message));
}
let toastT = null;
function toast(msg) {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500);
}
function saveSession() { ls.set('bp_session', JSON.stringify(session)); }
function clearSession(msg) {
  if (es) { es.close(); es = null; }
  session = null; V = null; online = false; anim = { round: 0, cstate: [] }; draft = newDraft();
  ls.del('bp_session');
  homeMsg = msg || '';
  try { history.replaceState(null, '', '/'); } catch (e) {}
  render();
}
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events?code=' + enc(session.code) + '&token=' + enc(session.token));
  es.onopen = () => { online = true; render(); };
  es.addEventListener('state', ev => { online = true; onState(JSON.parse(ev.data)); });
  es.addEventListener('kicked', ev => { let m = 'You were removed from the room.'; try { m = JSON.parse(ev.data).msg || m; } catch (e) {} clearSession(m); });
  es.onerror = () => {
    if (es && es.readyState === 2) clearSession('That room has ended, or your seat is gone.');
    else { online = false; render(); }
  };
}

/* ---------- state from server ---------- */
function onState(v) {
  const prev = V;
  V = v; offset = v.now - Date.now();
  const pg = prev && prev.game, ng = v.game;
  if (!pg || !ng || pg.round !== ng.round || (prev.phase !== 'choose' && v.phase === 'choose') || v.phase === 'lobby') draft = newDraft();
  sending = false;
  if (v.phase === 'lobby') anim = { round: 0, cstate: [] };
  handleReveal();
  render();
}
function handleReveal() {
  const g = G();
  if (!g || V.phase !== 'reveal') return;
  if (anim.round === g.round) return;                  // already animating / animated this round
  anim.round = g.round;
  const res = g.result;
  if (V.now - V.revealAt > 2500) { anim.cstate = res.map(() => 'done'); return; } // joined late: show instantly
  anim.cstate = res.map(() => 'sealed');
  runReveal(g.round, res);
}
async function runReveal(round, res) {
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  await sleep(reduce ? 0 : 1200);
  for (let i = 0; i < res.length; i++) {
    if (anim.round !== round) return;
    anim.cstate[i] = 'rolling'; render();
    if (reduce || res[i].void) await sleep(reduce ? 0 : 300);
    else for (let t = 0; t < 9; t++) { await sleep(90); if (anim.round !== round) return; render(); }
    anim.cstate[i] = 'done'; render();
    if (!reduce && !res[i].empty) await sleep(500);
  }
}

/* ---------- shared pieces ---------- */
function masthead() {
  const g = G();
  let tracker = '';
  if (g && g.round > 0) {
    let ticks = '';
    for (let k = 1; k <= ROUNDS; k++) {
      const cls = (k < g.round || (k === g.round && V.phase === 'final')) ? 'done' : (k === g.round ? 'now' : '');
      ticks += `<i class="${cls}"></i>`;
    }
    tracker = `<div class="rounds" role="img" aria-label="Round ${g.round} of ${ROUNDS}">${ticks}</div><span class="rlabel">Round ${g.round}/${ROUNDS}</span>`;
  }
  const room = V ? `<span class="roomtag" title="Room code">Room<b>${esc(V.code)}</b></span>` : '';
  const conn = (V && !online) ? '<span class="tag betray">Reconnecting…</span>' : '';
  const leave = V ? '<button class="btn ghost" data-act="leave" style="padding:8px 14px">Leave</button>' : '';
  return `<header class="mast">${SEAL(40)}<h1>Blind Pact</h1><span class="sp"></span>${conn}${room}${tracker}<button class="btn ghost" data-act="rules" style="padding:8px 14px">Rules</button>${leave}</header>`;
}
function slipFigs(c) {
  return `<div class="fig"><div><b>${c.reward}</b><span>Pays</span></div><div><b>${c.diff}</b><span>Needs</span></div></div>`;
}
function slipHTML(c) {
  const o = soloOdds(c);
  return `<div class="slip"><h3 class="h3">${esc(c.name)}</h3>${slipFigs(c)}<p class="small muted">${o === 0 ? 'Cannot be won alone. Needs a crew.' : `Alone at full effort: ${o}%`}</p></div>`;
}
function scoreboard(mode) {
  const g = G(), mx = Math.max(...g.players.map(p => p.coins));
  const delta = mode === 'delta';
  const rows = g.players.map(p => {
    let st = '';
    if (mode === 'status') st = p.sealed ? '<span class="tag coop">Sealed</span>' : (p.connected ? '<span class="tag">Thinking</span>' : '<span class="tag betray">Offline</span>');
    else if (delta && !p.bot) st = p.ready ? '<span class="tag coop">Ready</span>' : (p.connected ? '' : '<span class="tag betray">Offline</span>');
    const you = p.id === V.you ? '<span class="tag">You</span>' : '';
    return `<tr class="${p.coins === mx ? 'lead' : ''}"><td><span class="nm">${pname(p)}${p.bot ? '<span class="tag bot">Bot</span>' : ''}${you}${st}</span></td><td class="n">${p.coins}</td>${delta ? `<td class="n ${p.last > 0 ? 'pos' : 'zero'}">${p.last > 0 ? '+' : ''}${p.last}</td>` : ''}<td class="n">${p.tokens}${p.tokens >= BOOST_COST ? ' <span class="tag coop">Boost</span>' : ''}</td></tr>`;
  }).join('');
  return `<section class="panel"><h3 class="h3" style="margin-bottom:8px">Scoreboard</h3><div class="scroll"><table class="tbl"><thead><tr><th>Player</th><th class="n">Coins</th>${delta ? '<th class="n">Round</th>' : ''}<th class="n">Tokens</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function verdictTag(r) {
  if (r.empty) return '<span class="tag">No takers</span>';
  if (r.void) return '<span class="tag">Void</span>';
  if (r.success) return '<span class="tag coop">Fulfilled</span>';
  return `<span class="tag betray">${r.decisive ? 'Sabotaged' : 'Failed'}</span>`;
}
function chip(e) {
  return `<span class="chip">${dot(e.pid)}${esc(e.name)}<b class="${e.action === 'coop' ? 'c' : 'b'}">${e.action === 'coop' ? 'C' : 'B'}${e.eff}</b></span>`;
}
function ledgerHTML() {
  const g = G();
  if (!g.ledger.length) return `<section class="panel"><h3 class="h3" style="margin-bottom:6px">Public record</h3><p class="small muted">Empty so far. After each round every pledge is revealed and stays here, so you can see who delivered and who sank the job.</p></section>`;
  const rounds = g.ledger.map((L, idx) => {
    const landed = L.results.filter(r => r.decisive).length;
    const lines = L.results.filter(r => !r.empty).map(r => `<li><div class="lrow"><b>${esc(r.name)}</b>${verdictTag(r)}</div><div class="chips">${r.entries.map(chip).join('')}</div></li>`).join('');
    const open = (L.round in openRounds) ? openRounds[L.round] : idx === 0;
    return `<details class="rnd" data-round="${L.round}"${open ? ' open' : ''}><summary>Round ${L.round} · ${landed} sabotaged</summary><ul class="led">${lines}</ul></details>`;
  }).join('');
  return `<section class="panel"><h3 class="h3" style="margin-bottom:4px">Public record</h3><p class="small muted">C = cooperate, B = betray, number = energy.</p>${rounds}</section>`;
}
function chatHTML() {
  const msgs = V.chat.map(m => `<li><b style="color:var(--p${m.seat % 6})">${esc(m.name)}</b> ${esc(m.text)}</li>`).join('');
  return `<section class="panel"><h3 class="h3" style="margin-bottom:8px">Table talk</h3><ul class="chatlog" id="chatlog" aria-live="polite">${msgs || '<li class="small muted">Nobody has spoken yet. Promise something. Nothing binds.</li>'}</ul><div class="chatform"><input class="inp" id="chatin" maxlength="200" autocomplete="off" placeholder="Say something…" aria-label="Chat message" value="${esc(drafts.chatin)}"><button class="btn" data-act="chat">Send</button></div></section>`;
}

/* ---------- home ---------- */
function homeScreen() {
  return `<div class="hero"><section>
    <p class="kick">A game of sealed pledges · online</p>
    <h2 class="h2" id="sh" tabindex="-1">Every crew needs hands. Every crew has a snake.</h2>
    <p class="lede">Eight rounds. Four contracts a round. Pick one in secret, pledge your energy, then decide whether to deliver or to sink the job and pocket the wreckage. Make a room, send friends the code, play from anywhere.</p>
    <dl class="facts">
      <div><dt>Table</dt><dd>4 to 6 seats. Empty seats can be filled with bots.</dd></div>
      <div><dt>Energy</dt><dd>1 to 5 per pledge. Each point costs 1 coin.</dd></div>
      <div><dt>The roll</dt><dd>2d6 plus your crew's energy against the difficulty.</dd></div>
      <div><dt>Winner</dt><dd>Most coins after round 8.</dd></div>
    </dl>
    <div class="actions"><button class="btn ghost" data-act="rules">Read the full rules</button></div>
  </section>
  <section class="panel">
    <p class="fieldh">Your name</p>
    <input class="inp" id="hname" maxlength="16" autocomplete="nickname" placeholder="Name at the table" value="${esc(drafts.hname)}" aria-label="Your name">
    <div class="actions"><button class="btn seal" data-act="create">Create a room</button></div>
    <div class="or">or join a friend</div>
    <div class="row2"><input class="inp codein" id="hcode" maxlength="4" autocomplete="off" placeholder="CODE" value="${esc(drafts.hcode)}" aria-label="Room code"><button class="btn" data-act="join">Join room</button></div>
    ${homeMsg ? `<p class="err" role="alert">${esc(homeMsg)}</p>` : ''}
    <p class="small muted" style="margin-top:14px">No account needed. Pledges stay hidden until every seal breaks; the server rolls the dice.</p>
  </section></div>`;
}

/* ---------- lobby ---------- */
function lobbyScreen() {
  const host = isHost(), n = V.seats.length;
  const link = location.origin + '/?room=' + V.code;
  const rows = V.seats.map(s => {
    const mid = s.kind === 'bot'
      ? `<div class="sname"><b>${esc(s.name)} <span class="tag bot">Bot</span></b><span class="muted">${esc(BOTS[s.botType] ? BOTS[s.botType].blurb : '')}</span></div>`
      : `<div class="sname"><b>${esc(s.name)}${s.idx === V.you ? ' <span class="tag">You</span>' : ''}${s.idx === V.hostIdx ? ' <span class="tag coop">Host</span>' : ''}</b><span class="muted">${s.connected ? 'Online' : 'Offline'}</span></div>`;
    const right = (host && s.idx !== V.you) ? `<button class="btn ghost" data-act="remove" data-v="${s.idx}" aria-label="Remove ${esc(s.name)}">Remove</button>` : '';
    return `<div class="srow lobby">${dot(s.idx)}${mid}${right}</div>`;
  }).join('');
  const botOpts = '<option value="">Random bot</option>' + Object.keys(BOTS).map(k => `<option value="${k}">${esc(BOTS[k].name)}</option>`).join('');
  const timerOpts = [[0, 'Off'], [60, '60s'], [90, '90s'], [120, '2m'], [180, '3m']];
  const seg = timerOpts.map(([v, l]) => `<button data-act="timer" data-v="${v}" aria-pressed="${V.timer === v}"${host ? '' : ' disabled'}>${l}</button>`).join('');
  const controls = host ? `
    <div class="botadd"><select id="bottype" aria-label="Bot to add">${botOpts}</select><button class="btn ghost" data-act="addbot"${n >= V.max ? ' disabled' : ''}>Add bot</button></div>
    <p class="fieldh" style="margin-top:16px">Round timer</p><div class="seg" role="group" aria-label="Round timer">${seg}</div>
    <p class="small muted" style="margin-top:6px">When time runs out, anyone who has not sealed is auto-played.</p>
    <div class="actions" style="align-items:center"><button class="btn seal" data-act="start"${n >= V.min ? '' : ' disabled'}>Open the first round</button>${n < V.min ? '<button class="linkbtn" data-act="fill">Fill to ' + V.min + ' with bots</button>' : ''}</div>`
    : `<p class="fieldh" style="margin-top:16px">Round timer</p><p>${V.timer ? fmt(V.timer) + ' per round' : 'No timer'}</p><p class="muted" style="margin-top:12px">Waiting for the host to open the first round.</p>`;
  return `<div class="hero"><section>
    <p class="kick">Room lobby</p>
    <h2 class="h2" id="sh" tabindex="-1">Share the code. Fill the table.</h2>
    <div class="codebig" aria-label="Room code ${esc(V.code.split('').join(' '))}">${esc(V.code)}</div>
    <div class="actions" style="margin-top:0"><button class="btn" data-act="copy" data-v="${esc(link)}">Copy invite link</button></div>
    <p class="lede" style="margin-top:14px">Friends open the link, type a name and they are in. You need ${V.min} to ${V.max} seats; bots can fill the rest.</p>
    ${chatHTML()}
  </section>
  <section class="panel"><p class="fieldh">Seats · ${n}/${V.max}</p><div>${rows}</div>${controls}</section></div>`;
}

/* ---------- choose (negotiate + seal) ---------- */
function chooseScreen() {
  const g = G(), d = draft, me = g.players[V.you];
  let left = g.deadline ? Math.max(0, Math.ceil((g.deadline - (Date.now() + offset)) / 1000)) : 0;
  const timer = g.deadline ? `<p class="timer">Seals close in<b id="timer" class="${left <= 15 ? 'low' : ''}">${fmt(left)}</b></p>` : '';
  const head = `<p class="kick">Round ${g.round} of ${ROUNDS} · Negotiate, then seal</p>
    <h2 class="h2" id="sh" tabindex="-1">Four contracts. Talk first, then seal.</h2>`;
  let body;
  if (g.mine) {
    const m = g.mine, c = g.contracts[m.contract], eff = m.energy + (m.boost ? BOOST : 0);
    const waiting = g.players.filter(p => !p.sealed);
    const sum = `${m.action === 'coop' ? 'Cooperate' : 'Betray'} on ${c.name} with ${eff} energy${m.boost ? ` (${m.energy} paid + ${BOOST} boost)` : ''}. Cost: ${m.energy} coins.`;
    body = `<div class="panel sealedbox"><div class="wait">${SEAL(28)}<span>Your pact is sealed</span></div><p class="summary">${esc(sum)}</p>
      <p class="muted small">${waiting.length ? 'Waiting for ' + waiting.map(p => esc(p.name)).join(', ') + '. Keep talking; nothing binds.' : 'Everyone has sealed.'}</p>
      ${isHost() && waiting.length ? '<div><button class="btn ghost" data-act="force">Reveal now (auto-play the missing)</button></div>' : ''}</div>
      <div class="slips four">${g.contracts.map(slipHTML).join('')}</div>`;
  } else {
    const eff = d.energy + (d.boost ? BOOST : 0);
    const c = d.contract !== null ? g.contracts[d.contract] : null;
    const picks = g.contracts.map(k => `<button class="slip" data-act="pick" data-v="${k.id}" aria-pressed="${d.contract === k.id}"><h3 class="h3">${esc(k.name)}</h3>${slipFigs(k)}<span class="pick-odds">${soloOdds(k) === 0 ? 'Needs a crew' : 'Alone at 5 energy: ' + soloOdds(k) + '%'}</span></button>`).join('');
    const energy = [1, 2, 3, 4, 5].map(n => `<button data-act="energy" data-v="${n}" aria-pressed="${d.energy === n}">${n}</button>`).join('');
    const boost = me.tokens >= BOOST_COST
      ? `<label class="check"><input type="checkbox" id="boost" data-change="boost"${d.boost ? ' checked' : ''}><span>Spend ${BOOST_COST} reputation tokens for <b>+${BOOST} free energy</b> this round. You have ${me.tokens}.</span></label>`
      : `<p class="small muted">Reputation tokens: ${me.tokens}. Two buy a one-time +${BOOST} energy boost, for cooperating or sabotaging.</p>`;
    let hint = '';
    if (c && d.action === 'coop') hint = `<p class="note">Alone at ${eff} energy you would succeed ${Math.round(diceProb(c.diff - eff) * 100)}% of the time. More crew raises the odds but splits the reward.</p>`;
    else if (c && d.action === 'betray') hint = `<p class="note">Your ${eff} energy lifts the difficulty to ${c.diff + eff} for the crew. If the contract fails you earn 3 per cooperator, up to 9. If it succeeds, or nobody cooperates, you earn nothing.</p>`;
    const ready = c && d.action;
    const sum = ready ? `${d.action === 'coop' ? 'Cooperate' : 'Betray'} on ${c.name} with ${eff} energy${d.boost ? ` (${d.energy} paid + ${BOOST} boost)` : ''}. Cost: ${d.energy} coins.` : 'Choose a contract and a move.';
    body = `<div class="chooser">
      <div><p class="fieldh">Step 1 · Contract</p><div class="slips four" style="grid-template-columns:repeat(2,minmax(0,1fr))">${picks}</div></div>
      <div><p class="fieldh">Step 2 · Energy (1 coin each)</p><div class="seg" role="group" aria-label="Energy">${energy}</div><div style="margin-top:10px">${boost}</div></div>
      <div><p class="fieldh">Step 3 · Move</p><div class="acts">
        <button class="act coop" data-act="move" data-v="coop" aria-pressed="${d.action === 'coop'}"><b>Cooperate</b><span>Your energy helps clear the difficulty. Share the reward if it works.</span></button>
        <button class="act betray" data-act="move" data-v="betray" aria-pressed="${d.action === 'betray'}"><b>Betray</b><span>Your energy raises the difficulty. Profit if the crew fails.</span></button>
      </div>${hint}</div>
      <p class="summary">${esc(sum)}</p>
      <div class="actions" style="margin-top:0"><button class="btn seal" data-act="seal"${ready && !sending ? '' : ' disabled'}>Seal my choice</button></div></div>`;
  }
  return `<div class="stage"><section class="main">${head}<p class="lede">You have ${me.coins} coins. Use the table talk to bargain and bluff. Nobody sees your pledge until every seal breaks.</p>${timer}${body}</section>
    <aside class="rail">${scoreboard('status')}${chatHTML()}${ledgerHTML()}</aside></div>`;
}

/* ---------- reveal ---------- */
function rcard(r, i) {
  const g = G(), st = anim.cstate[i] || 'done';
  const head = `<div><h3 class="h3" style="margin-bottom:8px">${esc(r.name)}</h3>${slipFigs({ reward: r.reward, diff: r.diff })}</div>`;
  const wrap = b => `<article class="rcard">${head}${b}</article>`;
  if (r.empty) return wrap('<p class="muted">Nobody took this contract.</p>');
  if (st === 'sealed') return wrap(`<div class="wait">${SEAL(28)}<span>Sealed</span></div>`);
  if (st === 'rolling') {
    if (r.void) return wrap('<p class="muted">Checking pledges…</p>');
    return wrap(`<div class="dice">${die(rand6())}${die(rand6())}<span class="muted mono small">Rolling…</span></div>`);
  }
  const boosted = r.entries.some(e => e.boost);
  const rows = r.entries.map(e => {
    const pay = (r.payouts[e.pid] || 0) + (r.gains[e.pid] || 0);
    return `<tr><td><span class="nm">${dot(e.pid)}${esc(e.name)}</span></td><td><span class="tag ${e.action === 'coop' ? 'coop' : 'betray'}">${e.action === 'coop' ? 'Cooperate' : 'Betray'}</span></td><td class="n">${e.eff}${e.boost ? '*' : ''}</td><td class="n ${pay > 0 ? 'pos' : 'zero'}">${pay > 0 ? '+' + pay : '0'}</td></tr>`;
  }).join('');
  const table = `<div class="scroll"><table class="tbl sm"><thead><tr><th>Player</th><th>Move</th><th class="n">Energy</th><th class="n">Won</th></tr></thead><tbody>${rows}</tbody></table></div>${boosted ? '<p class="small muted">* includes a +3 boost.</p>' : ''}`;
  if (r.void) return wrap(`${table}<div class="verdict void">Void<small>Nobody cooperated, so nothing was rolled. Energy spent is lost.</small></div>`);
  const [d1, d2] = r.dice;
  const math = `<div class="dice">${die(d1)}${die(d2)}</div><p class="math">Dice ${d1}+${d2} = ${d1 + d2}<br>Crew energy +${r.coopE}<br><b>Total ${r.total}</b> vs difficulty ${r.diff}${r.betE ? ` + ${r.betE} sabotage = <b>${r.target}</b>` : ''}</p>`;
  let v;
  if (r.success) v = `<div class="verdict ok">Fulfilled<small>Reward of ${r.reward} split by energy among cooperators.</small></div>`;
  else if (r.decisive) v = `<div class="verdict fail">Sabotaged<small>Without the betrayal it would have passed. ${r.tokenTo.map(id => esc(g.players[id].name)).join(', ')} earn${r.tokenTo.length === 1 ? 's' : ''} a reputation token.</small></div>`;
  else if (Object.keys(r.gains).length) v = `<div class="verdict fail">Failed<small>It was going to fall short anyway. Betrayers still collect.</small></div>`;
  else v = `<div class="verdict fail">Failed<small>The crew fell short. Nobody profits.</small></div>`;
  return wrap(`${math}${table}${v}`);
}
function revealScreen() {
  const g = G(), res = g.result;
  const done = anim.cstate.length === res.length && anim.cstate.every(x => x === 'done');
  const last = g.round >= ROUNDS;
  const hum = g.players.filter(p => !p.bot && p.connected);
  const nReady = hum.filter(p => p.ready).length;
  const me = g.players[V.you];
  const after = done ? `<div style="margin-top:22px;max-width:520px">${scoreboard('delta')}<div class="actions">
      ${me.ready ? `<button class="btn" disabled>Waiting for the table (${nReady}/${hum.length})</button>` : `<button class="btn" data-act="ready">${last ? 'See the final tally' : 'Ready for next round'}</button>`}
      ${isHost() && nReady < hum.length ? '<button class="btn ghost" data-act="skip">Skip waiting</button>' : ''}</div></div>` : '';
  return `<div class="stage"><section class="main"><p class="kick">Round ${g.round} of ${ROUNDS} · The reveal</p>
    <h2 class="h2" id="sh" tabindex="-1">Break the seals.</h2>
    <p class="lede">Every pledge is now public. Contracts resolve one at a time.</p>
    <div class="rcards" style="margin-top:0">${res.map(rcard).join('')}</div>${after}</section>
    <aside class="rail">${chatHTML()}</aside></div>`;
}

/* ---------- final ---------- */
function chartHTML() {
  const g = G(), H = g.coinHist, R = H.length - 1, W = 560, Ht = 300, ml = 34, mr = 104, mt = 12, mb = 30;
  const ymax = Math.max(20, Math.ceil(Math.max(...H.flat()) / 10) * 10), step = ymax > 80 ? 20 : 10;
  const x = r => ml + (W - ml - mr) * r / R, y = v => mt + (Ht - mt - mb) * (1 - v / ymax);
  let s = '';
  for (let v = 0; v <= ymax; v += step) s += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--line);stroke-width:1"/><text class="ct" x="${ml - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let r = 0; r <= R; r++) s += `<text class="ct" x="${x(r)}" y="${Ht - 10}" text-anchor="middle">${r}</text>`;
  const lines = g.players.map((p, i) => `<polyline points="${H.map((row, r) => x(r) + ',' + y(row[i])).join(' ')}" style="fill:none;stroke:var(--p${i % 6});stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round"/><circle cx="${x(R)}" cy="${y(H[R][i])}" r="4" style="fill:var(--p${i % 6})"/>`).join('');
  const ends = g.players.map((p, i) => ({ i, y: y(H[R][i]) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
  const labels = ends.map(e => { const p = g.players[e.i]; const nm = p.name.length > 11 ? p.name.slice(0, 10) + '…' : p.name; return `<text class="cl" x="${x(R) + 9}" y="${e.y + 4}" style="fill:var(--p${e.i % 6})">${esc(nm)} ${p.coins}</text>`; }).join('');
  return `<div class="chartbox"><svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Coins held by each player after each round">${s}${lines}${labels}</svg></div><p class="small muted">Coins after each round. Round 0 is the starting purse.</p>`;
}
function finalScreen() {
  const g = G(), rk = rankPlayers(g), top = rk.filter(p => p.rank === 1), mx = rk[0].coins || 1;
  const head = top.length === 1 ? `${esc(top[0].name)} takes the pot` : `${top.map(p => esc(p.name)).join(' and ')} split the pot`;
  const rows = rk.map(p => `<tr><td class="n">${p.rank}</td><td><span class="nm">${pname(p)}${p.id === V.you ? '<span class="tag">You</span>' : ''}</span></td><td class="n"><span class="bar" style="width:${Math.max(4, Math.round(p.coins / mx * 80))}px;background:var(--p${p.id % 6})"></span>${p.coins}</td><td class="n">${p.tokens}</td><td class="n">${p.stats.betrays}</td><td class="n">${p.stats.landed}</td><td class="n">${p.stats.sabotaged}</td></tr>`).join('');
  const again = isHost()
    ? '<button class="btn seal" data-act="again">Play again, same room</button>'
    : '<span class="muted">Waiting for the host to start another game.</span>';
  return `<div class="stage"><section class="main"><p class="kick">Final tally · ${ROUNDS} rounds</p>
    <div class="winner"><h2 class="h2" id="sh" tabindex="-1" style="margin:0 0 8px">${head}</h2><p class="mono">${top[0].coins} coins${top.length > 1 ? ' each' : ''}${top[0].stats.landed ? ` · ${top[0].stats.landed} sabotage${top[0].stats.landed > 1 ? 's' : ''} landed` : ''}</p></div>
    <div class="panel scroll" style="margin-bottom:16px"><table class="tbl"><thead><tr><th class="n">#</th><th>Player</th><th class="n">Coins</th><th class="n">Tokens</th><th class="n">Betrayals</th><th class="n">Landed</th><th class="n">Sabotaged</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted" style="margin-top:8px">Landed = betrayals that tipped a contract into failure. Sabotaged = times a cooperating pledge was lost to a betrayer.</p></div>
    <div class="panel" style="margin-bottom:16px"><h3 class="h3" style="margin-bottom:8px">How the purses moved</h3>${chartHTML()}</div>
    <div class="actions">${again}</div></section>
    <aside class="rail">${chatHTML()}${ledgerHTML()}</aside></div>`;
}

/* ---------- rules ---------- */
function rulesHTML() {
  return `<div class="overlay" data-act="close-rules"><div class="sheet" role="dialog" aria-modal="true" aria-label="Rules"><h2 class="h2" style="margin:0">Rules</h2>
  <h3 class="h3">Setup</h3><ul><li>4 to 6 players, 8 rounds. Each player starts with 10 coins and gets 5 more at the start of every round.</li><li>Four contracts appear each round, each with its own reward and difficulty.</li></ul>
  <h3 class="h3">Each round</h3><ul><li><b>Talk.</b> Promise anything in the table chat. Nothing is binding.</li><li><b>Seal.</b> Secretly pick one contract (several players may pick the same one), invest 1 to 5 energy at 1 coin each, and choose Cooperate or Betray. Everyone seals at the same time.</li><li><b>Reveal.</b> For every contract with at least one cooperator, roll two dice. Dice sum plus the energy of cooperators must reach the difficulty plus the energy of betrayers.</li></ul>
  <h3 class="h3">Payouts</h3><ul><li><b>Success:</b> the reward is split among cooperators in proportion to their energy (rounded by largest remainder). Betrayers get nothing.</li><li><b>Failure:</b> each betrayer earns 3 coins per cooperator on that contract, up to 9.</li><li>A contract with no cooperators is void. Nothing rolls and spent energy is lost.</li><li>Everyone pays their energy cost whatever happens.</li></ul>
  <h3 class="h3">Reputation</h3><ul><li>A betrayal is successful when the contract would have passed without the betrayers' energy. Each betrayer on it earns a reputation token.</li><li>Two tokens buy a one-time +3 free energy boost on a later round, for cooperating or sabotaging.</li></ul>
  <h3 class="h3">Winning</h3><ul><li>Most coins after round 8. Ties go to the player with more tokens, then are shared.</li></ul>
  <div class="actions" style="margin-top:6px"><button class="btn" data-act="close-rules" data-btn="1">Back to the game</button></div></div></div>`;
}

/* ---------- render ---------- */
function render() {
  const ae = document.activeElement;
  let keep = null;
  if (ae && ae.id && app.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) {
    keep = { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd, v: ae.value };
  }
  const oldLog = document.getElementById('chatlog');
  const atBottom = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;

  let body = '', key = 'home';
  if (!V) {
    if (session) { key = 'connecting'; body = `<div class="center">${SEAL(48)}<h2 class="h2" id="sh" tabindex="-1" style="margin:0">Reconnecting to your room…</h2></div>`; }
    else body = homeScreen();
  } else {
    key = V.phase;
    switch (V.phase) {
      case 'lobby': body = lobbyScreen(); break;
      case 'choose': body = chooseScreen(); break;
      case 'reveal': body = revealScreen(); break;
      case 'final': body = finalScreen(); break;
    }
  }
  app.innerHTML = masthead() + body + (showRules ? rulesHTML() : '');

  if (lastKey !== key) {
    lastKey = key;
    try { window.scrollTo(0, 0); } catch (e) {}
    const h = document.getElementById('sh'); if (h) try { h.focus({ preventScroll: true }); } catch (e) {}
  } else if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      if (el.tagName === 'SELECT') el.value = keep.v;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.s, keep.e); } catch (e) {}
    }
  }
  const log = document.getElementById('chatlog');
  if (log && atBottom) log.scrollTop = log.scrollHeight;
}

/* live countdown without re-rendering the whole page */
setInterval(() => {
  const el = document.getElementById('timer'), g = G();
  if (!el || !g || !g.deadline) return;
  const left = Math.max(0, Math.ceil((g.deadline - (Date.now() + offset)) / 1000));
  el.textContent = fmt(left);
  el.classList.toggle('low', left <= 15);
}, 500);

/* ---------- events ---------- */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => toast('Invite link copied.')).catch(() => window.prompt('Copy this link:', text));
  }
  window.prompt('Copy this link:', text);
}
function sendChat() {
  const t = drafts.chatin.trim();
  if (!t) return;
  drafts.chatin = '';
  const el = document.getElementById('chatin'); if (el) el.value = '';
  act('chat', { text: t });
}
app.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  const a = t.dataset.act, v = t.dataset.v;
  if (a === 'close-rules') {
    if (!(t.dataset.btn || e.target === t)) return;
    showRules = false; render(); return;
  }
  switch (a) {
    case 'rules': showRules = true; break;
    case 'create': {
      const name = drafts.hname.trim(); ls.set('bp_name', name); homeMsg = '';
      api('/api/create', { name }).then(r => { session = { code: r.code, token: r.token }; saveSession(); connect(); render(); })
        .catch(err => { homeMsg = err.message; render(); });
      return;
    }
    case 'join': {
      const name = drafts.hname.trim(), code = drafts.hcode.trim().toUpperCase(); ls.set('bp_name', name); homeMsg = '';
      if (code.length !== 4) { homeMsg = 'Enter the 4-letter room code.'; render(); return; }
      api('/api/join', { name, code }).then(r => { session = { code: r.code, token: r.token }; saveSession(); try { history.replaceState(null, '', '/'); } catch (x) {} connect(); render(); })
        .catch(err => { homeMsg = err.message; render(); });
      return;
    }
    case 'leave':
      if (window.confirm(V && V.phase !== 'lobby' ? 'Leave this game? A bot will take your seat.' : 'Leave this room?')) {
        const s = session; clearSession('');
        if (s) api('/api/action', { code: s.code, token: s.token, type: 'leave' }).catch(() => {});
      }
      return;
    case 'copy': copyText(v); return;
    case 'addbot': { const sel = document.getElementById('bottype'); act('addBot', { botType: sel ? sel.value : '' }); return; }
    case 'fill': act('fillBots'); return;
    case 'remove': act('removeSeat', { idx: +v }); return;
    case 'timer': act('timer', { value: +v }); return;
    case 'start': act('start'); return;
    case 'pick': draft.contract = +v; break;
    case 'energy': draft.energy = +v; break;
    case 'move': draft.action = v; break;
    case 'seal': {
      if (sending) return;
      sending = true; render();
      act('seal', { contract: draft.contract, energy: draft.energy, action: draft.action, boost: !!draft.boost })
        .then(() => { if (sending) { sending = false; render(); } });
      return;
    }
    case 'force': act('force'); return;
    case 'ready': act('ready'); return;
    case 'skip': act('skip'); return;
    case 'again': act('again'); return;
    case 'chat': sendChat(); return;
  }
  render();
});
app.addEventListener('input', e => {
  const t = e.target;
  if (t.id in drafts) {
    if (t.id === 'hcode') { t.value = t.value.toUpperCase().replace(/[^A-Z]/g, ''); }
    drafts[t.id] = t.value;
  }
});
app.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset && t.dataset.change === 'boost') { draft.boost = t.checked; render(); }
});
app.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'chatin') { e.preventDefault(); sendChat(); }
  else if (e.target.id === 'hname' || e.target.id === 'hcode') {
    e.preventDefault();
    const b = app.querySelector(drafts.hcode.length === 4 && e.target.id === 'hcode' ? '[data-act="join"]' : '[data-act="create"]');
    if (b) b.click();
  }
});
app.addEventListener('toggle', e => {
  const d = e.target;
  if (d && d.tagName === 'DETAILS' && d.dataset.round) openRounds[d.dataset.round] = d.open;
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && showRules) { showRules = false; render(); }
});

if (session) connect();
render();
