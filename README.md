# 🎲 Game Night

Private, real-time games for you and your friends in the browser. There are no accounts: create a room and share the invite link.

| Game | Players | Where |
|---|---|---|
| ♠ **Neon Hold'em**: no-limit Texas Hold'em with play chips | 2–9 | `/poker/` |
| 🏝️ **Catan**: the full base game and the 5–6 player extension | 2–4 or 5–6 | `/catan/` |
| 🃏 **UNO Show 'Em No Mercy**: the 168-card brutal edition | 2–10 | `/uno/` |

One Node server runs all three games. The home page at `/` lets you pick a game. Each game has its own rooms, so room codes never mix between games. Invite links from before the merge (`/?room=CODE`) still open the poker table.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Friends on the same Wi-Fi can join at `http://<your-computer's-local-IP>:3000`.

**Over the internet, without deploying:** keep `npm start` running and open a free tunnel in another terminal, for example `cloudflared tunnel --url http://localhost:3000`. It prints a public `https://….trycloudflare.com` link to share.

## Deploy it (free)

The repo includes a `render.yaml` blueprint. On [Render](https://render.com), choose **New → Blueprint** and pick this repo. WebSockets work on the free plan. Any other Node host with WebSockets works too: the start command is `npm start`, and the server reads the `PORT` environment variable.

On free plans the server goes to sleep when nobody is using it, so the first visit can take up to a minute. Rooms live in the server's memory, so a restart ends any game in progress.

---

## ♠ Neon Hold'em

![Neon Hold'em table](docs/screenshot.png)

- **Real poker rules.** Blinds and heads-up blind rules, minimum-raise enforcement, short all-ins that don't reopen betting, side pots, split pots with odd-chip handling, and all-in run-outs with cards shown.
- **Secure dealing.** The server shuffles with a cryptographic RNG and each player receives only their own hole cards.
- **Turn timer.** 15s, 30s, 60s or off. When time runs out the player auto-checks, or auto-folds if there's a bet. Two timeouts in a row sit that player out.
- **Table chat, emoji reactions** that float over a player's seat, and a hand log.
- **Sound and animation.** Synthesised sound effects, cards flying from the deck, chips sliding to the pot, glowing winning cards and confetti.
- **Live hand strength**, a **standings tab** with buy-ins and net results, and rebuys for busted players.
- **Reconnects** to the same seat after a refresh. Works on phones, with keyboard shortcuts on desktop: **F** fold, **C** check/call, **R** raise.

How a game works: one person creates a table and chooses the blinds, starting stack and turn timer. They become the host 👑. Once at least 2 players are seated, the host clicks **Start game** and hands deal automatically. **Sit out** skips hands without losing your seat. An empty table is removed after 30 minutes.

## 🏝️ Catan

The server enforces the official rules:

- **Board.** A random board every game: 19 hexes and 9 harbors on the base board, or 30 hexes, 2 deserts and 11 harbors on the 5–6 player board. 6s and 8s never touch.
- **Setup.** Snake order with the distance rule. Each road must touch the settlement just placed, and the second settlement pays out its starting resources.
- **Production.** Cities collect double, and the robber blocks its hex. The official bank-shortage rule applies.
- **Rolling a 7.** Players over the discard limit discard half, then the robber moves and steals.
- **Development cards.** One per turn, playable before rolling but never on the turn you bought it. Victory point cards stay hidden until the end.
- **Longest Road and Largest Army.** Opponents' settlements can break a road, and ties are handled the official way.
- **Trading.** 4:1 with the bank, or 3:1 and 2:1 at harbors. Player trades happen only with the active player, other players can make counter-offers, and gifts aren't allowed.
- **5–6 players.** A Special Building Phase after every turn.
- **Winning.** You can only win on your own turn.

The host can set the points to win (8–14), a turn timer (off, or 1–5 minutes, with automatic moves when time runs out), the discard limit, and whether the bank's card counts are hidden. The board uses hand-drawn SVG art and animations, and the game works on phones.

## 🃏 UNO No Mercy

The server enforces the official No Mercy rules:

- **Deck.** 168 cards: numbers, Skip, Reverse, Draw 2, Draw 4, Skip Everyone and Discard All in four colors, plus Wild Reverse Draw 4, Wild Draw 6, Wild Draw 10 and Wild Color Roulette.
- **Stacking.** On a draw card you can stack any draw card of equal or higher value (+2 → +4 → +6 → +10). Whoever can't stack takes the whole pile and loses their turn.
- **Can't play?** Draw until you can, then play that card or pass.
- **Action cards.** Skip Everyone lets you go again. Discard All also discards every other card of that color in your hand. With Color Roulette, the next player names a color and flips cards until it comes up, keeping every card they flip.
- **7–0 rule** (the host can turn it off). A 7 swaps hands with a player you choose; a 0 passes every hand to the next player.
- **Mercy rule.** Anyone holding 25 or more cards is knocked out of the round.
- **UNO!** Call it when you're down to one card. Until the next player moves, anyone can catch you for +2.
- **Winning.** Empty your hand, or be the last player standing. Wins are tallied across rounds, and players can join between rounds.

The host can set a turn timer (off, 15–60 seconds). When time runs out, the game takes the penalty or draws and plays for you. Each player receives only their own hand, and the draw pile stays hidden.

---

## Project layout

```
server.js              Game Night server: home page, static files, routes /poker/ws, /catan/ws and /uno/ws
games/poker.js         Poker rooms and WebSocket handlers
games/catan.js         Catan rooms and WebSocket handlers
games/uno.js           UNO rooms and WebSocket handlers
src/poker/             Hold'em engine (table.js) and hand evaluator (handEval.js, also used in the browser)
src/catan/             Catan rules engine (game.js) and board generator (board.js)
src/uno/               UNO No Mercy rules engine (game.js)
public/index.html      Game Night home page
public/net.js          Small reconnecting WebSocket client shared by both games
public/poker/          Poker client
public/catan/          Catan client (art.js holds the SVG artwork)
public/uno/            UNO client
test/                  Tests for each game, plus site routing (site.test.js)
```

## Tests

```bash
npm test
```

This runs every game's tests and checks the site routing.

- **Poker** (`npm run test:poker`): hand-evaluator tests, then thousands of random hands at 2–9 players checking that no chips are created or lost, then an end-to-end socket test.
- **UNO** (`npm run test:uno`): rule checks for every card and rule, hundreds of random rounds at 2–10 players checking that all 168 cards are always accounted for, and a socket test.
- **Catan** (`npm run test:catan`): targeted rule checks, dozens of full random games on both boards with invariants checked after every action, a game played entirely by timeouts, and a socket test.
