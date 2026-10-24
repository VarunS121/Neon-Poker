// Yahtzee rule checks: every box, the upper bonus, Yahtzee bonuses and the Joker rules.
const assert = require('assert');
const { Game, scoreFor, CATS } = require('../../src/yahtzee/game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}
function fresh(n = 2) {
  const g = new Game('T', { turnTime: 0, botMs: 0 });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  return g;
}
// roll once, then force the dice
function setDice(g, dice) {
  if (g.rollsLeft === 3) assert.strictEqual(g.act(g.cur().id, 'roll'), null);
  g.dice = dice.slice();
}

test('box scores', () => {
  assert.strictEqual(scoreFor('threes', [3, 3, 1, 3, 6]), 9);
  assert.strictEqual(scoreFor('sixes', [1, 2, 3, 4, 5]), 0);
  assert.strictEqual(scoreFor('threeKind', [4, 4, 4, 2, 1]), 15);
  assert.strictEqual(scoreFor('threeKind', [4, 4, 3, 2, 1]), 0);
  assert.strictEqual(scoreFor('fourKind', [5, 5, 5, 5, 1]), 21);
  assert.strictEqual(scoreFor('fourKind', [5, 5, 5, 1, 1]), 0);
  assert.strictEqual(scoreFor('fullHouse', [2, 2, 3, 3, 3]), 25);
  assert.strictEqual(scoreFor('fullHouse', [2, 2, 2, 2, 3]), 0);
  assert.strictEqual(scoreFor('fullHouse', [6, 6, 6, 6, 6]), 0, 'a Yahtzee is not a full house without the Joker');
  assert.strictEqual(scoreFor('smallStraight', [1, 2, 3, 4, 6]), 30);
  assert.strictEqual(scoreFor('smallStraight', [3, 4, 5, 6, 6]), 30);
  assert.strictEqual(scoreFor('smallStraight', [1, 2, 3, 5, 6]), 0);
  assert.strictEqual(scoreFor('largeStraight', [2, 3, 4, 5, 6]), 40);
  assert.strictEqual(scoreFor('largeStraight', [1, 2, 3, 4, 6]), 0);
  assert.strictEqual(scoreFor('yahtzee', [4, 4, 4, 4, 4]), 50);
  assert.strictEqual(scoreFor('chance', [1, 2, 3, 4, 6]), 16);
});

test('three rolls a turn, holds keep dice, then you must score', () => {
  const g = fresh();
  assert(g.act('p0', 'score', { cat: 'chance' }), 'roll first');
  assert(g.act('p0', 'hold', { index: 0 }), 'nothing to hold yet');
  assert(g.act('p1', 'roll'), 'not your turn');
  g.act('p0', 'roll');
  const kept = g.dice[0];
  g.act('p0', 'hold', { index: 0 });
  g.act('p0', 'roll');
  assert.strictEqual(g.dice[0], kept);
  g.act('p0', 'roll', { held: [true, true, true, true, false] });
  assert.strictEqual(g.rollsLeft, 0);
  assert(g.act('p0', 'roll'), 'no fourth roll');
  assert.strictEqual(g.act('p0', 'score', { cat: 'chance' }), null);
  assert(g.act('p0', 'roll'), 'turn passed');
  assert.strictEqual(g.cur().id, 'p1');
});

test('each box is used once; zero is allowed', () => {
  const g = fresh(1);
  setDice(g, [1, 2, 3, 4, 6]);
  assert.strictEqual(g.act('p0', 'score', { cat: 'yahtzee' }), null);
  assert.strictEqual(g.players[0].card.yahtzee, 0);
  setDice(g, [5, 5, 5, 5, 5]);
  assert(g.act('p0', 'score', { cat: 'yahtzee' }), 'already filled');
});

test('upper bonus: +35 at 63', () => {
  const g = fresh(1);
  const p = g.players[0];
  Object.assign(p.card, { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15 });
  setDice(g, [6, 6, 6, 1, 2]);
  g.act('p0', 'score', { cat: 'sixes' });
  assert.deepStrictEqual([g.totals(p).upper, g.totals(p).bonus], [63, 35]);
  p.card.ones = 2;
  assert.strictEqual(g.totals(p).bonus, 0);
});

test('bonus Yahtzee: +100 and the Joker rules', () => {
  const g = fresh(1);
  const p = g.players[0];
  p.card.yahtzee = 50;
  // matching upper box open: it must go there
  setDice(g, [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(Object.keys(g.options(p)), ['fours']);
  assert(g.act('p0', 'score', { cat: 'fullHouse' }));
  assert.strictEqual(g.act('p0', 'score', { cat: 'fours' }), null);
  assert.strictEqual(p.card.fours, 20);
  assert.strictEqual(p.yBonus, 1);
  // upper box filled: any lower box, straights and full house at full value
  setDice(g, [4, 4, 4, 4, 4]);
  const o = g.options(p);
  assert.strictEqual(o.largeStraight, 40);
  assert.strictEqual(o.fullHouse, 25);
  assert.strictEqual(o.threeKind, 20);
  assert(!('sixes' in o), 'lower boxes first');
  g.act('p0', 'score', { cat: 'largeStraight' });
  assert.strictEqual(p.yBonus, 2);
  assert.strictEqual(g.totals(p).yBonus, 200);
  // every lower box filled: any upper box, for whatever it scores
  for (const c of ['threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'chance']) p.card[c] = 0;
  setDice(g, [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(Object.keys(g.options(p)).sort(), ['fives', 'ones', 'sixes', 'threes', 'twos']);
  assert.strictEqual(g.options(p).ones, 0);
});

test('a scratched Yahtzee box gives no bonus, but the Joker rules still apply', () => {
  const g = fresh(1);
  const p = g.players[0];
  p.card.yahtzee = 0;
  p.card.twos = 4;
  setDice(g, [2, 2, 2, 2, 2]);
  assert.strictEqual(g.options(p).smallStraight, 30);
  g.act('p0', 'score', { cat: 'smallStraight' });
  assert.strictEqual(p.yBonus, 0);
});

test('13 rounds, then the highest total wins (ties share it)', () => {
  const g = fresh(2);
  for (let k = 0; k < 26; k++) {
    const p = g.cur();
    setDice(g, [6, 6, 6, 6, 6]);
    const open = CATS.find(c => p.card[c] === null && c in g.options(p)) || Object.keys(g.options(p))[0];
    assert.strictEqual(g.act(p.id, 'score', { cat: open }), null);
  }
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winners.length, 2, 'identical cards tie');
  assert.strictEqual(g.players[0].wins, 1);
  assert.strictEqual(g.start('p0'), null, 'play again');
  assert(g.players.every(p => CATS.every(c => p.card[c] === null)));
});

test('bots finish whole games with sensible scores', () => {
  const totals = [];
  for (let k = 0; k < 60; k++) {
    const g = new Game('B', { botMs: 0, turnTime: 0 });
    g.addPlayer('h', 'Host');
    g.addBot('h'); g.addBot('h');
    g.players[0].bot = true;   // let the bot logic play the host's seat too
    g.start('h');
    assert.strictEqual(g.phase, 'over');
    for (const p of g.players) totals.push(g.totals(p).total);
    g.destroy();
  }
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  assert(avg > 170, `bots average only ${avg.toFixed(0)}`);
  console.log(`  bots average ${avg.toFixed(0)} points (best ${Math.max(...totals)})`);
});

test('the turn timer plays for a slow human', () => {
  const g = fresh(1);
  g.onTimeout();
  assert.strictEqual(Object.values(g.players[0].card).filter(v => v !== null).length, 1);
});

console.log(`yahtzee rules: ${passed} tests passed`);
