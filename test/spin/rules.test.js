// UNO Spin rule checks on hand-built positions, for both wheel editions.
const assert = require('assert');
const { Game, buildDeck, WHEELS } = require('../../src/spin/game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}

let nextId = 5000;
const card = (type, color = null, value, spin = false) => ({ id: nextId++, type, color, value, spin });
const num = (color, value, spin = false) => card('number', color, value, spin);

function fresh(n = 3, settings = {}) {
  const g = new Game('T', { turnTime: 0, spinMs: 0, ...settings });
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
// force the wheel onto a space
function spinTo(g, i, space) {
  g.phase = 'spin';
  g.spin = { spinner: 'p' + i, by: 'p' + i };
  g.current = i;
  const wheel = WHEELS[g.settings.edition];
  const real = require('crypto').randomInt;
  require('crypto').randomInt = () => wheel.indexOf(space);
  try { assert.strictEqual(g.act('p' + i, 'spin'), null); } finally { require('crypto').randomInt = real; }
}

test('deck has the 112 UNO Spin cards', () => {
  const d = buildDeck();
  assert.strictEqual(d.length, 112);
  const n = f => d.filter(f).length;
  assert.strictEqual(n(c => c.type === 'number' && !c.spin), 56);
  assert.strictEqual(n(c => c.type === 'number' && c.spin), 20);
  assert(d.filter(c => c.spin && c.type === 'number').every(c => c.value >= 1 && c.value <= 5));
  assert.deepStrictEqual([n(c => c.type === 'draw2'), n(c => c.type === 'reverse'), n(c => c.type === 'skip')], [8, 8, 8]);
  assert.deepStrictEqual([n(c => c.type === 'wild' && !c.spin), n(c => c.type === 'wild' && c.spin), n(c => c.type === 'wild4')], [4, 4, 4]);
});

test('classic UNO: matching, draw one, skip, reverse, draw two', () => {
  const g = fresh(3);
  assert(play(g, 0, give(g, 0, num('green', 9))), 'no match');
  g.deck.push(num('yellow', 7));
  assert.strictEqual(g.act('p0', 'draw'), null);
  assert.strictEqual(g.cur().id, 'p1', 'an unplayable draw ends the turn');
  play(g, 1, give(g, 1, card('skip', 'red')));
  assert.strictEqual(g.cur().id, 'p0', 'p2 was skipped');
  play(g, 0, give(g, 0, card('reverse', 'red')));
  assert.strictEqual(g.cur().id, 'p2');
  const before = P(g, 1).hand.length;
  play(g, 2, give(g, 2, card('draw2', 'red')));
  assert.strictEqual(P(g, 1).hand.length, before + 2);
  assert.strictEqual(g.cur().id, 'p0', 'the drawer loses their turn');
  assert(play(g, 0, give(g, 0, card('wild'))), 'wild needs a color');
});

test('draw one and play it, or keep it', () => {
  const g = fresh(3);
  g.deck.push(num('red', 8));
  g.act('p0', 'draw');
  assert.strictEqual(g.cur().id, 'p0');
  assert(play(g, 0, P(g, 0).hand[0]), 'only the drawn card');
  assert.strictEqual(g.act('p0', 'pass'), null);
  assert.strictEqual(g.cur().id, 'p1');
});

test('wild draw four challenge: accept, win, lose', () => {
  for (const [guilty, challenge] of [[false, false], [true, true], [false, true]]) {
    const g = fresh(3);
    P(g, 0).hand = guilty ? [num('red', 1), num('blue', 2)] : [num('blue', 1), num('blue', 2)];
    play(g, 0, give(g, 0, card('wild4')), { color: 'green' });
    assert.strictEqual(g.phase, 'challenge');
    const a = P(g, 0).hand.length, b = P(g, 1).hand.length;
    g.act('p1', 'challenge', { challenge });
    if (!challenge) { assert.strictEqual(P(g, 1).hand.length, b + 4); assert.strictEqual(g.cur().id, 'p2'); }
    else if (guilty) { assert.strictEqual(P(g, 0).hand.length, a + 4); assert.strictEqual(g.cur().id, 'p1', 'challenger plays on'); }
    else { assert.strictEqual(P(g, 1).hand.length, b + 6); assert.strictEqual(g.cur().id, 'p2'); }
    assert.strictEqual(g.color, 'green');
  }
});

test('spin cards: classic — the next player spins; new — you spin', () => {
  const c = fresh(3);
  play(c, 0, give(c, 0, num('red', 3, true)));
  assert.strictEqual(c.phase, 'spin');
  assert.strictEqual(c.spin.spinner, 'p1');
  assert(c.act('p1', 'draw'), 'spinning replaces your turn');
  const n = fresh(3, { edition: 'new' });
  play(n, 0, give(n, 0, num('red', 3, true)));
  assert.strictEqual(n.spin.spinner, 'p0');
  const w = fresh(3);
  play(w, 0, give(w, 0, card('wild', null, undefined, true)), { color: 'blue' });
  assert.strictEqual(w.phase, 'spin', 'wild spin cards spin too');
});

test('classic: Draw Red / Draw Blue draw until that color or a wild', () => {
  const g = fresh(3);
  g.deck.push(num('red', 4), num('green', 1), num('blue', 9));
  spinTo(g, 1, 'drawRed');
  assert.strictEqual(P(g, 1).hand.length, 6);
  assert.strictEqual(g.cur().id, 'p2', 'the spinner loses their turn');
  g.deck.push(card('wild'), num('red', 1));
  spinTo(g, 2, 'drawBlue');
  assert.strictEqual(P(g, 2).hand.length, 5, 'a wild stops it');
});

test('classic: Almost UNO, Discard Number, Discard Color', () => {
  const g = fresh(3);
  P(g, 1).hand = [num('red', 1), num('blue', 7), num('green', 7), num('yellow', 2), num('red', 9)];
  spinTo(g, 1, 'almostUno');
  assert.strictEqual(g.phase, 'pick');
  const [a, b, c] = P(g, 1).hand;
  assert(g.act('p1', 'discard', { cards: [a.id] }), 'must leave exactly two');
  assert.strictEqual(g.act('p1', 'discard', { cards: [a.id, b.id, c.id] }), null);
  assert.strictEqual(P(g, 1).hand.length, 2);
  assert.strictEqual(g.top().id, c.id, 'last discarded is on top');
  assert.strictEqual(g.cur().id, 'p2');

  const h = fresh(3);
  P(h, 1).hand = [num('red', 7), num('blue', 7), num('green', 3), num('yellow', 7)];
  spinTo(h, 1, 'discardNumber');
  const sevens = P(h, 1).hand.filter(x => x.value === 7);
  assert(h.act('p1', 'discard', { cards: [sevens[0].id, P(h, 1).hand[2].id] }), 'one number only');
  assert.strictEqual(h.act('p1', 'discard', { cards: [sevens[0].id, sevens[1].id] }), null, 'you may keep some');
  assert.strictEqual(P(h, 1).hand.length, 2);

  const k = fresh(3);
  P(k, 1).hand = [num('red', 7), num('red', 2), card('wild'), num('green', 3)];
  spinTo(k, 1, 'discardColor');
  const reds = P(k, 1).hand.filter(x => x.color === 'red');
  assert(k.act('p1', 'discard', { cards: [reds[0].id, P(k, 1).hand[2].id] }), 'no wilds');
  assert.strictEqual(k.act('p1', 'discard', { cards: reds.map(x => x.id) }), null);
  assert.strictEqual(k.color, 'red');
});

test('classic: War — highest number is played, ties go deeper, play continues after the winner', () => {
  const g = fresh(4);
  P(g, 0).hand = [num('red', 9), num('red', 2), num('blue', 1)];
  P(g, 1).hand = [num('blue', 9), num('red', 5), num('red', 1)];
  P(g, 2).hand = [num('green', 4), card('wild')];
  P(g, 3).hand = [card('skip', 'red'), card('wild')];
  spinTo(g, 2, 'war');
  assert.strictEqual(P(g, 1).hand.length, 2, 'p1 wins on the tie-break (5 beats 2)');
  assert.strictEqual(g.top().value, 9);
  assert.strictEqual(g.cur().id, 'p2', 'play continues after the discarder');
});

test('classic: Show Hand, Trade Hands', () => {
  const g = fresh(3);
  spinTo(g, 1, 'showHand');
  assert.strictEqual(g.view('p0').shown.id, 'p1');
  assert.strictEqual(g.view('p0').shown.cards.length, 3);
  const h = fresh(3);
  const hands = h.players.map(p => p.hand);
  spinTo(h, 0, 'tradeHands');
  assert.deepStrictEqual(h.players.map(p => p.hand), [hands[2], hands[0], hands[1]]);
});

test('classic: UNO Spin race — first to hit it discards any one card', () => {
  const g = fresh(3);
  spinTo(g, 0, 'unoSpin');
  assert.strictEqual(g.phase, 'race');
  assert.strictEqual(g.act('p2', 'unoSpin'), null);
  assert(g.act('p1', 'unoSpin'), 'too late');
  const any = give(g, 2, card('wild'));
  assert(g.act('p2', 'discard', { cards: [any.id] }), 'a wild on top needs a color');
  assert.strictEqual(g.act('p2', 'discard', { cards: [any.id], color: 'yellow' }), null);
  assert.strictEqual(g.color, 'yellow');
  assert.strictEqual(g.cur().id, 'p0', 'play continues after the racer');
});

test('new: color draws, wild color draw, color discard, swap hands', () => {
  const g = fresh(3, { edition: 'new' });
  g.deck.push(num('green', 4), card('wild'), num('blue', 9));
  spinTo(g, 0, 'colorDraw:green');
  assert.strictEqual(P(g, 0).hand.length, 6, 'wilds do not count as the color');
  assert.strictEqual(g.cur().id, 'p1');

  const h = fresh(3, { edition: 'new' });
  h.deck.push(num('yellow', 1), num('red', 2));
  spinTo(h, 0, 'wildColorDraw');
  assert.strictEqual(h.act('p0', 'chooseColor', { color: 'yellow' }), null);
  assert.strictEqual(P(h, 0).hand.length, 5);

  const k = fresh(3, { edition: 'new' });
  spinTo(k, 0, 'colorDiscard');
  const top = k.top().id;
  k.act('p0', 'chooseColor', { color: 'blue' });
  assert.strictEqual(P(k, 0).hand.length, 1);
  assert.strictEqual(k.top().id, top, 'discards go under the pile');

  const m = fresh(3, { edition: 'new' });
  P(m, 2).hand = [num('red', 1)];
  spinTo(m, 0, 'swapHands');
  m.act('p0', 'swap', { target: 'p2' });
  assert.strictEqual(P(m, 0).hand.length, 1);
  assert.deepStrictEqual(m.unoPending.has('p0'), true, 'a one-card hand must call UNO');
});

test('new: 2X lets everyone play two cards until someone spins', () => {
  const g = fresh(3, { edition: 'new' });
  spinTo(g, 0, 'twoX');
  assert(g.twoX);
  const a = give(g, 1, num('red', 7)), b = give(g, 1, num('blue', 7));
  play(g, 1, a);
  assert.strictEqual(g.phase, 'second');
  assert.strictEqual(g.cur().id, 'p1');
  assert.strictEqual(play(g, 1, b), null, 'second card matches the first');
  assert.strictEqual(g.cur().id, 'p2');
  play(g, 2, give(g, 2, num('blue', 4)));
  assert.strictEqual(g.act('p2', 'pass'), null, 'you can stop after one');
  play(g, 0, give(g, 0, num('blue', 2, true)));
  assert(!g.twoX, 'a spin ends 2X');
});

test('UNO call and catch', () => {
  const g = fresh(3);
  P(g, 0).hand = [num('red', 1), num('red', 2)];
  play(g, 0, P(g, 0).hand[0]);
  assert.strictEqual(g.act('p1', 'catch', { target: 'p0' }), null);
  assert.strictEqual(P(g, 0).hand.length, 3);
  const h = fresh(3);
  P(h, 0).hand = [num('red', 1), num('red', 2)];
  h.act('p0', 'uno');
  play(h, 0, P(h, 0).hand[0]);
  assert(h.act('p1', 'catch', { target: 'p0' }));
});

test('scoring: winner collects card points; first to the target wins the game', () => {
  const g = fresh(3, { target: 250 });
  P(g, 0).hand = [num('red', 9)];
  P(g, 1).hand = [num('blue', 7), card('skip', 'blue')];   // 27
  P(g, 2).hand = [card('wild4'), num('green', 3)];          // 53
  play(g, 0, P(g, 0).hand[0]);
  assert.strictEqual(g.phase, 'roundOver');
  assert.strictEqual(P(g, 0).score, 80);
  g.start(g.hostId);
  assert.strictEqual(g.round, 2);
  assert.strictEqual(P(g, 0).score, 80, 'scores carry over between rounds');
  P(g, 0).hand = [num(g.color, 9)];
  g.current = g.players.indexOf(P(g, 0));
  P(g, 1).hand = Array.from({ length: 4 }, () => card('wild'));
  play(g, 0, P(g, 0).hand[0]);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.champion, 'p0');
  g.destroy();
});

test('a final Draw Two still makes the next player draw before scoring', () => {
  const g = fresh(3);
  P(g, 0).hand = [card('draw2', 'red')];
  P(g, 1).hand = [];
  P(g, 2).hand = [];
  play(g, 0, P(g, 0).hand[0]);
  assert.strictEqual(P(g, 1).hand.length, 2);
  assert(P(g, 0).score > 0);
});

test('timeouts always move the game on (both editions)', () => {
  for (const edition of ['classic', 'new']) {
    const g = new Game('T', { turnTime: 15, spinMs: 0, edition });
    for (let i = 0; i < 4; i++) g.addPlayer('p' + i, 'P' + i);
    g.start('p0');
    const seen = new Set();
    for (let step = 0; step < 6000 && !g.between; step++) {
      seen.add(g.phase);
      const before = g.timerKey();
      g.onTimeout();
      assert.notStrictEqual(g.timerKey(), before, 'stuck at ' + before);
    }
    g.destroy();
    assert(seen.has('spin'), edition + ': spins happened');
  }
});

console.log(`spin rules: ${passed} tests passed`);
