# ♠ Neon Hold'em

![Neon Hold'em table](docs/screenshot.png)

Private, real-time no-limit Texas Hold'em for you and your friends, with a dark neon look. It uses play chips only, needs no accounts, and seats up to 9 players per table.

## Features

- **Real poker rules.** Blinds and heads-up blind rules, minimum-raise enforcement, short all-ins that don't reopen betting, side pots, split pots with odd-chip handling, and all-in run-outs with cards shown.
- **Secure dealing.** The server shuffles with a cryptographic RNG and each player receives only their own hole cards, so nobody can peek at yours.
- **Turn timer.** You can choose 15s, 30s, 60s or off. When time runs out the player auto-checks, or auto-folds if there's a bet. Two timeouts in a row sit that player out.
- **Table chat, emoji reactions** that float over a player's seat, and a hand log.
- **Synthesised sound effects** (no audio files): dealing, chips, checks, folds, your-turn alert, timer ticks and a win fanfare.
- **Animations.** Cards fly out from the deck, the board flips, chips slide to the pot and the pot slides to the winner, winning cards glow, and you get confetti when you win.
- **Live hand strength.** You always see what you're holding, for example "Two Pair, Kings & Threes".
- **Standings tab** with each player's stack, buy-ins and net result. Busted players can rebuy.
- **Reconnects.** If you refresh or your phone drops, you come back to the same seat.
- **Works on phones and desktop.** It has a portrait layout for phones and keyboard shortcuts on desktop: **F** fold, **C** check/call, **R** raise.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Friends on the same Wi-Fi can join at `http://<your-computer's-local-IP>:3000`.

## Play over the internet in two minutes (no deploy)

Keep `npm start` running and open a free tunnel in another terminal. One option is [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://….trycloudflare.com` link. Open that link, create a table, and use **Invite** to copy a link for your friends. The game stays up as long as your computer and the tunnel are running.

## Deploy it permanently (free)

Any Node host that supports WebSockets works. Using **Render** as an example:

1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com), choose **New → Web Service** and pick the repo.
3. Use these settings: Runtime **Node**, Build command `npm install`, Start command `npm start`.
4. Deploy, then open your `https://<name>.onrender.com` URL.

On free plans the server goes to sleep when nobody is using it, so the first visit can take up to a minute to wake it up. Railway and Fly.io work the same way: the start command is `npm start`, and the server reads the `PORT` environment variable.

## How a game works

1. One person creates a table and chooses the blinds, starting stack and turn timer. That person becomes the host 👑.
2. Click **Invite** to copy the link and send it to your friends. They can also join by typing the 5-letter table code.
3. When at least 2 players are seated, the host clicks **Start game**. After that, hands deal automatically.
4. **Sit out** skips hands without losing your seat. **Rebuy** appears when you run out of chips. **Leave** gives up your seat.

Tables live in the server's memory. Restarting the server clears them, and an empty table is removed after 30 minutes.

## Project layout

```
server.js            HTTP + WebSocket server, rooms, chat
src/table.js         Hold'em engine (betting rounds, side pots, timers)
src/handEval.js      Hand evaluator (shared with the browser)
public/index.html    App shell (lobby + table)
public/style.css     Neon theme
public/app.js        Client: rendering, animations, sounds, controls
public/net.js        Small reconnecting WebSocket client
test/                Hand-evaluator tests, engine simulation, end-to-end socket test
```

Run `npm test` to check everything. The engine test plays thousands of random hands at 2–9 players and checks that no chips are ever created or lost.
