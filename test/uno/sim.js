// Plays many full UNO No Mercy rounds with random-but-legal players and checks invariants.
const assert = require('assert');
const { Game, COLORS } = require('../../src/uno/game');

const pick = a => a[Math.floor(Math.random() * a.length)];

function check(g) {
  const ids = [...g.deck, ...g.discard, ...g.players.flatMap(p => p.hand)].map(c => c.id);
  assert.strictEqual(ids.length, 168, 'cards created or lost');
  assert.strictEqual(new Set(ids).size, 168, 'duplicate card');
  for (const p of g.players) {
    if (p.out) assert.strictEqual(p.hand.length, 0);
    else assert(p.hand.length < 25 || g.phase === 'over', 'mercy rule missed');
  }
  if (g.phase !== 'over') assert(!g.cur().out, 'turn landed on a knocked-out player');
}

function playRound(n, stats) {
  const g = new Game('S', { turnTime: 0, sevenZero: Math.random() < 0.8 });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  let steps = 0;
  while (g.phase !== 'over' && steps++ < 20000) {
    const p = g.cur();
    // someone sometimes catches a missed UNO, and players sometimes call it
    if (g.unoPending && Math.random() < 0.3) {
      const catcher = g.active().find(x => x.id !== g.unoPending);
      if (catcher) { g.act(catcher.id, 'catch', { target: g.unoPending }); stats.catches++; }
    }
    if (p.hand.length <= 2 && Math.random() < 0.5) g.act(p.id, 'uno');
    if (g.phase === 'over') break;
    if (g.phase === 'roulette') { assert.strictEqual(g.act(p.id, 'rouletteColor', { color: pick(COLORS) }), null); stats.roulette++; continue; }
    const v = g.view(p.id);
    if (v.playable.length && Math.random() < 0.9) {
      const chosen = pick(v.playable);
      const c = p.hand.find(x => x.id === chosen);
      const target = pick(g.active().filter(x => x !== p)).id;
      const err = g.act(p.id, 'play', { cardId: c.id, color: pick(COLORS), target });
      assert.strictEqual(err, null, `legal play rejected: ${err}`);
      if (g.pending) stats.maxStack = Math.max(stats.maxStack, g.pending);
    } else if (g.drawn != null) {
      assert.strictEqual(g.act(p.id, 'pass'), null);
    } else {
      assert.strictEqual(g.act(p.id, 'draw'), null);
    }
    check(g);
    JSON.stringify(g.view('p0'));
  }
  assert.strictEqual(g.phase, 'over', 'round did not finish');
  stats.mercy += g.players.filter(p => p.out).length;
  stats.rounds++;
  g.destroy();
}

const stats = { rounds: 0, mercy: 0, catches: 0, roulette: 0, maxStack: 0 };
for (const n of [2, 3, 4, 6, 8, 10]) for (let k = 0; k < 40; k++) playRound(n, stats);
console.log(`uno sim: ${stats.rounds} rounds, ${stats.mercy} mercy knockouts, ${stats.roulette} roulettes, biggest stack +${stats.maxStack} — all invariants held`);
