# Blind Pact (online)

The same game, now played in private rooms over the internet.
One player creates a room, shares the 4-letter code (or invite link), friends join from their own devices, and everyone seals their pledge at the same time.

## What changed from the single-file version

| Original | Online |
|---|---|
| Pass one device around | Everyone plays on their own device, sealing **simultaneously** |
| Setup screen with seats | **Room lobby**: code + invite link, host adds/removes bots, 4 to 6 seats |
| Talk out loud | Built-in **table chat** (also a round **timer**: Off / 60s / 90s / 2m / 3m) |
| Bots decide in the browser | Server runs bots, rolls the dice and decides who wins, so nobody can cheat |

Rules, contracts, bots, dice and payouts are the original engine, untouched (`public/engine.js`).
Other players' pledges are never sent to your browser until the reveal.

## Run it locally

```bash
npm start            # needs Node 18+, no npm install required (zero dependencies)
```
Open http://localhost:3000, create a room, then open the invite link in a second tab (or on your phone via your computer's LAN IP) to test with more players.

```bash
npm test             # plays a full 8-round game against the server + renders every screen
```

## Deploy it as a website

This game needs a **server that stays running** (rooms live in memory and the browser holds a live connection to it).
That means a Node host, **not Vercel or Netlify**, which are static/serverless and would drop rooms between requests.

### Render (free tier works)
1. Push this folder to a GitHub repo.
2. On https://render.com choose **New > Web Service**, select the repo.
3. Runtime **Node**, Build command `echo ok` (or leave blank), Start command `npm start`. Deploy.
   (Or use **New > Blueprint**; `render.yaml` is included.)
4. Open the URL Render gives you. Share it. Done.

### Railway / Fly.io / Koyeb / any VPS
Anything that runs `npm start` works. The server reads the `PORT` environment variable.
Make sure the host does not buffer or time out long-lived HTTP responses (all the ones above are fine).

## Good to know

- **Free hosts sleep.** On Render's free plan the app spins down after ~15 min idle; the first visit takes about 30s to wake. Active rooms are lost if the server restarts (state is in memory by design: simple and fast).
- **Disconnects:** refresh the page and you are back in your seat automatically. If you lose your saved session, rejoin a running game with the room code and the **exact name** you played under.
- **Leaving mid-game** hands your seat to a bot so the others can finish.
- If someone stalls, the host can press **Reveal now**, or set a round timer in the lobby; missing players are auto-played.

## Files

```
server.js            rooms, lobby, authoritative game flow, SSE realtime (no dependencies)
public/index.html    page shell
public/app.js        client UI (lobby, sealed choices, reveal, final)
public/engine.js     the original game engine (shared by server + browser)
public/style.css     the original look
public/online.css    small additions for lobby/chat/timer
test/                end-to-end tests
```
