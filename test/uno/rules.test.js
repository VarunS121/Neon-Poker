// UNO No Mercy rule checks on hand-built positions.
const assert = require('assert');
const { Game, buildDeck, MERCY_LIMIT } = require('../../src/uno/game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}

let nextId = 1000;
const card = (type, color = null, value) => ({ id: nextId++, type, color, value });
const num = (color, value) => card('number', color, value);

// A started game with known hands; p0 to play onto `top`.
function fresh(n = 3, settings = {}) {
  const g = new Game('T', { turnTime: 0, ...settings });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  g.players.sort((a, b) => a.id.localeCompare(b.id));
  g.current = 0;
  g.direction = 1;
  g.discard = [num('red', 5)];
  g.color = 'red';
  for (const p of g.players) p.hand = [num('blue', 1), num('blue', 2), num('green', 3)];
  return g;
}
const P = (g, i) => g.players[i];
const give = (g, i, ...cards) => { P(g, i).hand.push(...cards); return cards[0]; };
const play = (g, i, c, extra = {}) => g.act('p' + i, 'play', { cardId: c.id, ...extra });

test('deck has the 168 No Mercy cards', () => {
  const d = buildDeck();
  assert.strictEqual(d.length, 168);
  const count = t => d.filter(c => c.type === t).length;
  assert.deepStrictEqual(
    [count('number'), count('draw2'), count('draw4'), count('skip'), count('skipAll'), count('reverse'), count('discardAll'), count('wildRev4'), count('wild6'), count('wild10'), count('roulette')],
    [80, 12, 8, 12, 8, 12, 12, 8, 4, 4, 8]);
  assert.strictEqual(new Set(d.map(c => c.id)).size, 168);
});

test('deal: 7 cards each and a number card to start', () => {
  const g = new Game('T', {});
  for (let i = 0; i < 4; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  assert(g.players.every(p => p.hand.length === 7));
  assert.strictEqual(g.top().type, 'number');
  assert.strictEqual(g.deck.length + g.discard.length + 28, 168);
  g.destroy();
});

test('matching: color, number, symbol; wilds need a color', () => {
  const g = fresh();
  const blue5 = give(g, 0, num('blue', 5));
  const green9 = give(g, 0, num('green', 9));
  assert(play(g, 0, green9), 'no match');
  assert.strictEqual(play(g, 0, blue5), null, 'same number');
  assert.strictEqual(g.color, 'blue');
  const w = give(g, 1, card('wild6'));
  assert(play(g, 1, w), 'wild needs a color');
  assert.strictEqual(play(g, 1, w, { color: 'green' }), null);
  assert.strictEqual(g.color, 'green');
});

test('stacking: equal or higher only, then the next player takes the lot', () => {
  const g = fresh(3);
  const d2 = give(g, 0, card('draw2', 'red'));
  play(g, 0, d2);
  assert.strictEqual(g.pending, 2);
  const lower = give(g, 1, card('draw2', 'blue'));
  assert.strictEqual(play(g, 1, lower), null, 'draw 2 on draw 2 ignores color');
  const d4 = give(g, 2, card('draw4', 'green'));
  assert.strictEqual(play(g, 2, d4), null);
  assert.strictEqual(g.pending, 8);
  const small = give(g, 0, card('draw2', 'green'));
  const normal = give(g, 0, num('green', 4));
  assert(play(g, 0, small), 'cannot stack +2 on +4');
  assert(play(g, 0, normal), 'only draw cards while a stack is pending');
  const w10 = give(g, 0, card('wild10'));
  assert.strictEqual(play(g, 0, w10, { color: 'red' }), null);
  assert.strictEqual(g.pending, 18);
  const before = P(g, 1).hand.length;
  assert.strictEqual(g.act('p1', 'draw'), null);
  assert.strictEqual(P(g, 1).hand.length, before + 18);
  assert.strictEqual(g.pending, 0);
  assert.strictEqual(g.cur().id, 'p2', 'taking the stack ends your turn');
});

test('wild reverse draw 4 sends the penalty back the other way', () => {
  const g = fresh(4);
  const w = give(g, 0, card('wildRev4'));
  play(g, 0, w, { color: 'blue' });
  assert.strictEqual(g.direction, -1);
  assert.strictEqual(g.cur().id, 'p3');
  assert.strictEqual(g.pending, 4);
});

test('skip, skip everyone, reverse (and reverse = skip with two players)', () => {
  const g = fresh(4);
  play(g, 0, give(g, 0, card('skip', 'red')));
  assert.strictEqual(g.cur().id, 'p2');
  play(g, 2, give(g, 2, card('skipAll', 'red')));
  assert.strictEqual(g.cur().id, 'p2', 'skip everyone: play again');
  play(g, 2, give(g, 2, card('reverse', 'red')));
  assert.strictEqual(g.cur().id, 'p1');
  const two = fresh(2);
  play(two, 0, give(two, 0, card('reverse', 'red')));
  assert.strictEqual(two.cur().id, 'p0');
});

test('discard all throws away every card of that color', () => {
  const g = fresh();
  give(g, 0, num('red', 1), num('red', 8));
  const da = give(g, 0, card('discardAll', 'red'));
  assert.strictEqual(play(g, 0, da), null);
  assert(P(g, 0).hand.every(c => c.color !== 'red'));
  assert.strictEqual(P(g, 0).hand.length, 3);
});

test('7 swaps hands with a chosen player; 0 passes every hand along', () => {
  const g = fresh(3);
  const seven = give(g, 0, num('red', 7));
  P(g, 2).hand = [num('yellow', 1)];
  assert(play(g, 0, seven), 'needs a target');
  const mine = P(g, 0).hand.filter(c => c !== seven);
  assert.strictEqual(play(g, 0, seven, { target: 'p2' }), null);
  assert.deepStrictEqual(P(g, 2).hand, mine);
  assert.strictEqual(P(g, 0).hand.length, 1);
  const h = fresh(3);
  const zero = give(h, 0, num('red', 0));
  const before = h.players.map(p => p.hand.filter(c => c !== zero).map(c => c.id).join());
  play(h, 0, zero);
  const after = h.players.map(p => p.hand.map(c => c.id).join());
  assert.deepStrictEqual(after, [before[2], before[0], before[1]], 'each hand moves one seat along');
  const off = fresh(3, { sevenZero: false });
  const s = give(off, 0, num('red', 7));
  assert.strictEqual(play(off, 0, s), null, '7-0 off: a 7 is just a 7');
});

test('draw until playable, then play that card or pass', () => {
  const g = fresh();
  g.deck = [num('red', 2), num('blue', 9), num('green', 8)]; // popped from the end
  assert(g.act('p0', 'pass'), 'must draw before passing');
  assert.strictEqual(g.act('p0', 'draw'), null);
  assert.strictEqual(P(g, 0).hand.length, 6);
  assert.strictEqual(g.drawn, P(g, 0).hand[5].id);
  const other = P(g, 0).hand[0];
  assert(play(g, 0, other), 'only the drawn card');
  assert.strictEqual(g.act('p0', 'pass'), null);
  assert.strictEqual(g.cur().id, 'p1');
});

test('color roulette: next player picks a color and flips until it shows', () => {
  const g = fresh(3);
  play(g, 0, give(g, 0, card('roulette')));
  assert.strictEqual(g.phase, 'roulette');
  assert.strictEqual(g.cur().id, 'p1');
  g.deck = [num('green', 1), card('wild6'), num('red', 3), num('blue', 4)];
  const before = P(g, 1).hand.length;
  assert.strictEqual(g.act('p1', 'rouletteColor', { color: 'green' }), null);
  assert.strictEqual(P(g, 1).hand.length, before + 4);
  assert.strictEqual(g.color, 'green');
  assert.strictEqual(g.cur().id, 'p2', 'the victim loses their turn');
});

test('mercy rule: reaching 25 cards knocks you out; last one standing wins', () => {
  const g = fresh(3);
  for (let k = 0; k < 21; k++) P(g, 1).hand.push(num('yellow', k % 10));
  g.pending = 4; g.pendingMin = 4;
  g.current = 1;
  g.act('p1', 'draw');
  assert(P(g, 1).out);
  assert.strictEqual(P(g, 1).hand.length, 0);
  assert.strictEqual(g.cur().id, 'p2');
  assert.strictEqual(g.nextIndex(2), 0, 'knocked-out players are skipped');
  for (let k = 0; k < MERCY_LIMIT; k++) P(g, 2).hand.push(num('yellow', 1));
  g.mercyCheck(P(g, 2));
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, 'p0');
});

test('UNO: call it or get caught for +2', () => {
  const g = fresh(3);
  P(g, 0).hand = [num('red', 1), num('red', 2)];
  play(g, 0, P(g, 0).hand[0]);
  assert.strictEqual(g.unoPending, 'p0');
  assert.strictEqual(g.act('p2', 'catch', { target: 'p0' }), null);
  assert.strictEqual(P(g, 0).hand.length, 3);
  const h = fresh(3);
  P(h, 0).hand = [num('red', 1), num('red', 2)];
  assert.strictEqual(h.act('p0', 'uno'), null);
  play(h, 0, P(h, 0).hand[0]);
  assert.strictEqual(h.unoPending, null);
  assert(h.act('p1', 'catch', { target: 'p0' }), 'called in time');
  // the window closes once the next player moves
  const k = fresh(3);
  P(k, 0).hand = [num('red', 1), num('red', 2)];
  play(k, 0, P(k, 0).hand[0]);
  k.act('p1', 'draw');
  assert(k.act('p2', 'catch', { target: 'p0' }), 'too late');
});

test('the host stays the creator after seats are shuffled', () => {
  for (let k = 0; k < 20; k++) {
    const g = new Game('T', { turnTime: 0 });
    for (let i = 0; i < 5; i++) g.addPlayer('p' + i, 'P' + i);
    g.start('p0');
    assert.strictEqual(g.hostId, 'p0');
    g.destroy();
  }
});

test('emptying your hand wins the round, and the next round redeals', () => {
  const g = fresh(3);
  P(g, 0).hand = [num('red', 9)];
  play(g, 0, P(g, 0).hand[0]);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(P(g, 0).wins, 1);
  g.addPlayer('late', 'Late');
  assert.strictEqual(g.players.length, 4, 'join between rounds');
  assert.strictEqual(g.start('p0'), null);
  assert(g.players.every(p => p.hand.length === 7 && !p.out));
  g.destroy();
});

test('timeouts always move the game on', () => {
  const g = new Game('T', { turnTime: 15 });
  for (let i = 0; i < 5; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  for (let step = 0; step < 4000 && g.phase !== 'over'; step++) {
    const before = g.timerKey();
    g.onTimeout();
    assert.notStrictEqual(g.timerKey(), before, 'stuck at ' + before);
  }
  g.destroy();
});

console.log(`uno rules: ${passed} tests passed`);
