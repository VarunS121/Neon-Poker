// Plays many full Yahtzee games with random-but-legal humans (and some bots), checking invariants.
const assert = require('assert');
const { Game, CATS } = require('../../src/yahtzee/game');

const pick = a => a[Math.floor(Math.random() * a.length)];
let games = 0, turns = 0, yBonuses = 0, upperBonuses = 0, best = 0;

for (const [humans, bots] of [[1, 0], [2, 0], [3, 2], [1, 7], [8, 0]]) {
  for (let k = 0; k < 30; k++) {
    const g = new Game('S', { botMs: 0, turnTime: 0 });
    for (let i = 0; i < humans; i++) g.addPlayer('p' + i, 'P' + i);
    for (let b = 0; b < bots; b++) assert.strictEqual(g.addBot('p0'), null);
    assert.strictEqual(g.start('p0'), null);
    let steps = 0;
    while (g.phase === 'play' && steps++ < 10000) {
      const p = g.cur();
      assert(!p.bot, 'a bot is stuck');
      assert.strictEqual(g.act(p.id, 'roll'), null);
      for (let r = 0; r < 2 && Math.random() < 0.7; r++) {
        for (let i = 0; i < 5; i++) if (Math.random() < 0.4) g.act(p.id, 'hold', { index: i });
        if (g.held.every(Boolean)) g.act(p.id, 'hold', { index: 0 });
        assert.strictEqual(g.act(p.id, 'roll'), null);
      }
      for (const d of g.dice) assert(d >= 1 && d <= 6);
      const opts = Object.keys(g.options(p));
      assert(opts.length, 'no box to score in');
      const filled = CATS.filter(c => p.card[c] !== null);
      if (filled.length) assert(g.act(p.id, 'score', { cat: filled[0] }), 'filled box accepted');
      assert.strictEqual(g.act(p.id, 'score', { cat: pick(opts) }), null);
      turns++;
    }
    assert.strictEqual(g.phase, 'over', 'game did not finish');
    for (const p of g.players) {
      assert(CATS.every(c => Number.isInteger(p.card[c])), 'card not full');
      const t = g.totals(p);
      assert.strictEqual(t.total, t.upper + t.bonus + t.lower + t.yBonus);
      yBonuses += p.yBonus; if (t.bonus) upperBonuses++; best = Math.max(best, t.total);
    }
    games++;
    g.destroy();
  }
}
console.log(`yahtzee sim: ${games} games, ${turns} human turns, ${yBonuses} bonus Yahtzees, ${upperBonuses} upper bonuses, best ${best} — all invariants held`);
