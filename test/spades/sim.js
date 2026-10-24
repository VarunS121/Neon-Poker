// Plays many full Spades games (random legal humans mixed with bots) and checks invariants.
const assert = require('assert');
const { Game } = require('../../src/spades/game');

const pick = a => a[Math.floor(Math.random() * a.length)];

function check(g) {
  if (g.phase === 'playing' || g.phase === 'bidding') {
    const cards = [...g.hands.flat(), ...g.trick.map(t => t.card)];
    const played = 52 - cards.length;
    assert.strictEqual(new Set(cards.map(c => c.id)).size, cards.length, 'duplicate card');
    assert.strictEqual(g.tricks.reduce((a, b) => a + b, 0) * 4, played, 'tricks do not add up'); // cards in the current trick are still "in play"
    const sizes = g.hands.map(h => h.length);
    assert(Math.max(...sizes) - Math.min(...sizes) <= 1, 'uneven hands');
  }
}

function playGame(bots, stats) {
  const g = new Game('S', { botMs: 0, trickMs: 0, turnTime: 0, target: pick([250, 300, 500]), blindNil: true });
  const humans = 4 - bots;
  for (let i = 0; i < humans; i++) g.addPlayer('p' + i, 'P' + i);
  for (let s = humans; s < 4; s++) assert.strictEqual(g.addBot('p0', s), null);
  assert.strictEqual(g.start('p0'), null);
  let steps = 0;
  while (g.phase !== 'over' && steps++ < 20000) {
    if (g.phase === 'handOver') { stats.hands++; assert.strictEqual(g.act('p0', 'next'), null); continue; }
    const seat = g.actorSeat();
    assert(seat != null, 'nobody to move in ' + g.phase);
    assert(!g.seats[seat].bot, 'a bot is stuck');
    const id = g.seats[seat].id;
    if (g.phase === 'bidding') {
      const v = g.view(id);
      const bid = v.canBlind && Math.random() < 0.3 ? 'blind' : Math.random() < 0.1 ? 'nil' : 1 + Math.floor(Math.random() * 5);
      if (bid === 'blind') stats.blind++;
      assert.strictEqual(g.act(id, 'bid', { bid }), null);
    } else {
      const v = g.view(id);
      assert(v.legal.length, 'no legal card');
      const bad = g.hands[seat].find(c => !v.legal.includes(c.id));
      if (bad) assert(g.act(id, 'play', { card: bad.id }), 'illegal card accepted');
      assert.strictEqual(g.act(id, 'play', { card: pick(v.legal) }), null);
    }
    check(g);
    JSON.stringify(g.view('p0'));
  }
  assert.strictEqual(g.phase, 'over', 'game did not finish');
  assert(Math.max(...g.scores) >= g.settings.target || Math.min(...g.scores) <= -200);
  if (Math.min(...g.scores) <= -200) stats.mercy++;
  for (const b of g.bags) assert(b >= 0 && b < 10);
  stats.games++;
  stats.hands++;
  g.destroy();
}

const stats = { games: 0, hands: 0, blind: 0, mercy: 0 };
for (const bots of [0, 1, 2, 3]) for (let k = 0; k < 25; k++) playGame(bots, stats);
console.log(`spades sim: ${stats.games} games, ${stats.hands} hands, ${stats.blind} blind nils, ${stats.mercy} ended at −200 — all invariants held`);
