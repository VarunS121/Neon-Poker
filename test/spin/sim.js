// Plays many full UNO Spin games with random-but-legal players on both wheels, checking invariants.
const assert = require('assert');
const { Game, COLORS } = require('../../src/spin/game');

const pick = a => a[Math.floor(Math.random() * a.length)];

function check(g) {
  const ids = [...g.deck, ...g.discard, ...g.players.flatMap(p => p.hand)].map(c => c.id);
  assert.strictEqual(ids.length, 112, 'cards created or lost');
  assert.strictEqual(new Set(ids).size, 112, 'duplicate card');
  if (!g.between) assert(g.players.every(p => p.hand.length > 0) || g.phase === 'pick', 'empty hand without a win');
}

// a legal random move for whoever the game is waiting on
function move(g, stats) {
  const ph = g.phase;
  if (ph === 'race') { const p = pick(g.players); stats.races++; return g.act(p.id, 'unoSpin'); }
  if (ph === 'challenge') return g.act(g.challenge.target, 'challenge', { challenge: Math.random() < 0.5 });
  if (ph === 'spin') { stats.spins++; return g.act(g.spin.spinner, 'spin'); }
  if (ph === 'pick') {
    const p = g.findPlayer(g.pick.player), h = p.hand;
    stats.picks[g.pick.mode] = (stats.picks[g.pick.mode] || 0) + 1;
    switch (g.pick.mode) {
      case 'almostUno': return g.act(p.id, 'discard', { cards: h.slice(0, h.length - 2).map(c => c.id), color: pick(COLORS) });
      case 'unoSpin': return g.act(p.id, 'discard', { cards: [pick(h).id], color: pick(COLORS) });
      case 'discardNumber': { const v = pick(h.filter(c => c.type === 'number')).value; return g.act(p.id, 'discard', { cards: h.filter(c => c.type === 'number' && c.value === v && Math.random() < 0.8).map(c => c.id) }); }
      case 'discardColor': { const col = pick(h.filter(c => c.color)).color; return g.act(p.id, 'discard', { cards: h.filter(c => c.color === col).map(c => c.id) }); }
      case 'wildColorDraw': case 'colorDiscard': return g.act(p.id, 'chooseColor', { color: pick(COLORS) });
      case 'swapHands': return g.act(p.id, 'swap', { target: pick(g.players.filter(x => x !== p)).id });
    }
  }
  const p = g.cur();
  if (p.hand.length <= 2 && Math.random() < 0.6) g.act(p.id, 'uno');
  const others = g.players.filter(x => x !== p && g.unoPending.has(x.id));
  if (others.length && Math.random() < 0.3) g.act(p.id, 'catch', { target: others[0].id });
  const v = g.view(p.id);
  if (v.playable.length && Math.random() < 0.9) {
    const id = pick(v.playable);
    return g.act(p.id, 'play', { cardId: id, color: pick(COLORS) });
  }
  if (ph === 'second' || g.drawn != null) return g.act(p.id, 'pass');
  return g.act(p.id, 'draw');
}

function playGame(edition, n, stats) {
  const g = new Game('S', { turnTime: 0, spinMs: 0, edition, target: 250 });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  let steps = 0;
  while (g.phase !== 'over' && steps++ < 60000) {
    if (g.phase === 'roundOver') { stats.rounds++; assert.strictEqual(g.start(g.hostId), null); continue; }
    const err = move(g, stats);
    assert.strictEqual(err, null, `legal move rejected in ${g.phase}: ${err}`);
    check(g);
    JSON.stringify(g.view('p0'));
  }
  assert.strictEqual(g.phase, 'over', 'game did not finish');
  assert(g.findPlayer(g.champion).score >= 250);
  stats.games++;
  stats.rounds++;
  g.destroy();
}

const stats = { games: 0, rounds: 0, spins: 0, races: 0, picks: {} };
for (const edition of ['classic', 'new']) for (const n of [2, 3, 5, 8, 10]) for (let k = 0; k < 6; k++) playGame(edition, n, stats);
console.log(`spin sim: ${stats.games} games / ${stats.rounds} rounds, ${stats.spins} spins (${Object.entries(stats.picks).map(([k, v]) => `${k} ${v}`).join(', ')}) — all invariants held`);
