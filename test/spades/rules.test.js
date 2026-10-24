// Spades rule checks on hand-built positions.
const assert = require('assert');
const { Game, trickWinner } = require('../../src/spades/game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}
const C = id => ({ id, r: { J: 11, Q: 12, K: 13, A: 14 }[id.slice(0, -1)] || +id.slice(0, -1), s: id.slice(-1) });

// four humans seated, game started, in the play phase with given hands
function fresh(settings = {}) {
  const g = new Game('T', { turnTime: 0, botMs: 0, trickMs: 0, ...settings });
  for (let i = 0; i < 4; i++) g.addPlayer('p' + i, 'P' + i);
  return g;
}
function playing(g, hands, lead = 0) {
  g.start('p0');
  g.hands = hands.map(h => h.map(C));
  g.bids = [3, 3, 3, 3];
  g.tricks = [0, 0, 0, 0];
  g.trick = [];
  g.phase = 'playing';
  g.turn = lead;
  g.spadesBroken = false;
}
const play = (g, seat, id) => g.act('p' + seat, 'play', { card: id });

test('seats, teams and bots', () => {
  const g = new Game('T', { botMs: 0 });
  g.addPlayer('a', 'A'); g.addPlayer('b', 'B');
  assert.deepStrictEqual(g.seats.map(s => s && s.id), ['a', 'b', null, null]);
  assert(g.start('a'), 'needs four seats');
  assert(g.addBot('b', 2), 'only the host adds bots');
  assert.strictEqual(g.sit('b', 3), null);
  assert.deepStrictEqual(g.seats.map(s => s && s.id), ['a', null, null, 'b']);
  g.addBot('a', 1); g.addBot('a', 2);
  assert(g.seats[1].bot && g.seats[2].bot);
  assert.strictEqual(g.start('a'), null);
  assert.strictEqual(g.hands.every(h => h.length === 13), true);
  assert.strictEqual(new Set(g.hands.flat().map(c => c.id)).size, 52);
  g.destroy();
});

test('trick winner: highest of the led suit unless trumped', () => {
  const t = cards => cards.map((id, seat) => ({ seat, card: C(id) }));
  assert.strictEqual(trickWinner(t(['5H', 'KH', '2C', 'AD'])), 1);
  assert.strictEqual(trickWinner(t(['5H', 'KH', '2S', 'AH'])), 2, 'any spade trumps');
  assert.strictEqual(trickWinner(t(['5H', '3S', 'QS', 'AH'])), 2, 'highest spade wins');
});

test('bidding goes round from the dealer\'s left; Nil is allowed', () => {
  const g = fresh();
  g.start('p0');
  const first = (g.dealer + 1) % 4;
  assert.strictEqual(g.turn, first);
  assert(g.act('p' + ((first + 1) % 4), 'bid', { bid: 3 }), 'out of turn');
  assert(g.act('p' + first, 'bid', { bid: 14 }), 'too high');
  for (let k = 0; k < 4; k++) assert.strictEqual(g.act('p' + ((first + k) % 4), 'bid', { bid: k === 1 ? 'nil' : 3 }), null);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.bids[(first + 1) % 4], 'nil');
  assert.strictEqual(g.turn, first, 'the player left of the dealer leads');
});

test('must follow suit; spades cannot be led until broken', () => {
  const g = fresh();
  playing(g, [['2S', '5H', '9H'], ['3H', 'KS', '4C'], ['7H', '8C', '2D'], ['4D', 'AH', '3S']]);
  assert(play(g, 0, '2S'), 'spades not broken');
  assert.strictEqual(play(g, 0, '5H'), null);
  assert(play(g, 1, 'KS'), 'must follow hearts');
  assert.strictEqual(play(g, 1, '3H'), null);
  assert.strictEqual(play(g, 2, '7H'), null);
  assert.strictEqual(play(g, 3, 'AH'), null);
  assert.strictEqual(g.tricks[3], 1);
  assert.strictEqual(g.turn, 3, 'the winner leads');
  assert(play(g, 3, '3S'), 'still not broken');
  assert.strictEqual(play(g, 3, '4D'), null);
  assert.strictEqual(play(g, 0, '2S'), null, 'void in diamonds, so trump');
  assert(g.spadesBroken);
});

test('you may lead spades when you hold nothing else', () => {
  const g = fresh();
  playing(g, [['2S', '5S'], ['3H', '4C'], ['7H', '8C'], ['4D', 'AH']]);
  assert.strictEqual(play(g, 0, '5S'), null);
});

test('scoring: making the bid, bags, sets', () => {
  const g = fresh();
  g.start('p0');
  g.bids = [4, 2, 3, 2]; g.tricks = [5, 1, 4, 3];   // team 0 bid 7 took 9; team 1 bid 4 took 4
  g.hands = [[], [], [], []];
  g.scoreHand();
  assert.deepStrictEqual(g.scores, [72, 40]);
  assert.deepStrictEqual(g.bags, [2, 0]);
  g.phase = 'handOver'; g.deal();
  g.bids = [5, 4, 4, 4]; g.tricks = [3, 3, 2, 5];   // team 0 bid 9 took 5: set; team 1 bid 8 took 8
  g.scoreHand();
  assert.deepStrictEqual(g.scores, [72 - 90, 40 + 80]);
});

test('ten bags cost 100 points', () => {
  const g = fresh();
  g.start('p0');
  g.bags = [8, 0];
  g.bids = [2, 3, 2, 3]; g.tricks = [4, 3, 3, 3];   // team 0 bid 4 took 7: 3 bags -> 11 -> penalty
  g.scoreHand();
  assert.deepStrictEqual(g.bags, [1, 0]);
  assert.strictEqual(g.scores[0], 43 - 100);
});

test('nil: +100 made, −100 broken (tricks become bags); blind nil ±200', () => {
  const g = fresh();
  g.start('p0');
  g.bids = ['nil', 4, 4, 4]; g.tricks = [0, 5, 4, 4];
  g.scoreHand();
  assert.strictEqual(g.scores[0], 100 + 40);
  assert.strictEqual(g.scores[1], 81);
  g.phase = 'handOver'; g.deal();
  g.bids = ['nil', 4, 3, 4]; g.tricks = [2, 4, 3, 4];
  const before = g.scores[0];
  g.scoreHand();
  assert.strictEqual(g.scores[0] - before, -100 + 30 + 2, 'partner made 3; the 2 nil tricks are bags');
  g.phase = 'handOver'; g.deal();
  g.bids = ['blind', 'blind', 13, 'nil']; g.tricks = [0, 0, 13, 0];
  const s = g.scores.slice();
  g.scoreHand();
  assert.deepStrictEqual([g.scores[0] - s[0], g.scores[1] - s[1]], [200 + 130, 200 + 100]);
});

test('blind nil only when behind by 100, and before looking', () => {
  const g = fresh({ blindNil: true });
  g.start('p0');
  const first = g.turn;
  assert(g.act('p' + first, 'bid', { bid: 'blind' }), 'not behind');
  g.scores = [0, 0];
  g.scores[1 - (first % 2)] = 150;
  assert.strictEqual(g.view('p' + first).hand, null, 'cards hidden until you look');
  assert.strictEqual(g.view('p' + first).canBlind, true);
  assert.strictEqual(g.act('p' + first, 'bid', { bid: 'blind' }), null);
  assert.strictEqual(g.bids[first], 'blind');
  const nxt = (first + 1) % 4;   // the other team is ahead, so they cannot
  assert(g.act('p' + nxt, 'bid', { bid: 'blind' }));
  const g2 = fresh({ blindNil: true });
  g2.start('p0');
  g2.scores = [0, 0]; g2.scores[1 - (g2.turn % 2)] = 150;
  g2.act('p' + g2.turn, 'look');
  assert(g2.act('p' + g2.turn, 'bid', { bid: 'blind' }), 'already looked');
});

test('game ends at the target; a tie keeps playing', () => {
  const g = fresh({ target: 250 });
  g.start('p0');
  g.scores = [200, 230];
  g.bids = [3, 1, 3, 1]; g.tricks = [4, 2, 3, 4];   // team 0 +61 -> 261, team 1 +24 -> 254
  g.scoreHand();
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winnerTeam, 0);
  const t = fresh({ target: 250 });
  t.start('p0');
  t.scores = [221, 220];
  t.bids = [3, 3, 3, 3]; t.tricks = [3, 3, 3, 4];   // +60 and +61: 281 vs 281
  t.scoreHand();
  assert.strictEqual(t.phase, 'handOver', 'tied above the target: play on');
});

test('a team at −200 or below loses', () => {
  const g = fresh();
  g.start('p0');
  g.scores = [-150, 40];
  g.bids = [5, 2, 5, 2]; g.tricks = [2, 4, 3, 4];   // team 0 set for −100
  g.scoreHand();
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winnerTeam, 1);
});

test('bots bid and play legal cards for a whole game', () => {
  const g = new Game('T', { botMs: 0, trickMs: 0, turnTime: 0, target: 250 });
  g.addPlayer('h', 'Human');
  for (let s = 1; s < 4; s++) g.addBot('h', s);
  g.start('h');
  // the human is also played by the bot logic (as if they kept timing out)
  for (let k = 0; k < 2000 && g.phase !== 'over'; k++) {
    if (g.phase === 'handOver') g.act('h', 'next');
    else if (g.actorSeat() === 0) g.onTimeout();
  }
  assert.strictEqual(g.phase, 'over');
  g.destroy();
});

console.log(`spades rules: ${passed} tests passed`);
