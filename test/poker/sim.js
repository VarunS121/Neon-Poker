// Engine stress test: random bots play many hands; checks chip conservation and rule invariants.
const assert = require('assert');
const { Table } = require('../../src/poker/table');

// Make timers instant so the sim runs fast.
const queue = [];
global.setTimeout = (fn) => { queue.push(fn); return queue.length; };
global.clearTimeout = () => {};

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function run(numPlayers, hands, stacks) {
  const t = new Table('TEST', { smallBlind: 5, bigBlind: 10, startingStack: 1000, turnTime: 0 }, {});
  const ids = [];
  for (let i = 0; i < numPlayers; i++) { ids.push('p' + i); t.addPlayer('p' + i, 'P' + i); }
  if (stacks) stacks.forEach((s, i) => (t.players[i].chips = s));
  const total = () => t.players.reduce((s, p) => s + p.chips + p.totalBet * (t.phase === 'complete' ? 0 : 1), 0);
  const buyIns = () => t.players.reduce((s, p) => s + p.buyIns * 1000, 0) - (stacks ? stacks.reduce((a, s) => a + 1000 - s, 0) : 0);
  t.startGame('p0');
  let actions = 0, showdowns = 0, sidePots = 0;
  while (t.handNumber <= hands) {
    if (t.isBetting() && t.currentSeat >= 0) {
      const p = t.seats[t.currentSeat];
      const v = t.view(p.id).actions;
      const r = rand();
      let err;
      if (r < 0.15) err = t.act(p.id, 'fold');
      else if (r < 0.55) err = t.act(p.id, v.canCheck ? 'check' : 'call');
      else if (r < 0.65) err = t.act(p.id, 'allin');
      else if (v.canRaise) {
        const amt = v.minRaiseTo + Math.floor(rand() * (v.maxRaiseTo - v.minRaiseTo + 1));
        err = t.act(p.id, 'raise', amt);
      } else err = t.act(p.id, 'call');
      assert(!err, 'legal action rejected: ' + err);
      actions++;
      // illegal action should be rejected
      const other = t.players.find(o => o.seat !== t.currentSeat);
      if (other && t.isBetting()) assert(t.act(other.id, 'check'), 'out of turn accepted');
    } else if (queue.length) {
      const fn = queue.shift();
      if (t.phase === 'complete' && t.result) {
        if (!t.result.uncontested) showdowns++;
        if (t.result.pots && t.result.pots.length > 1) sidePots++;
        assert.strictEqual(total(), buyIns(), 'chip conservation after hand ' + t.handNumber);
        // rebuy busted players to keep things going
        for (const p of t.players) if (p.chips === 0) { p.chips = 1000; p.buyIns++; }
      }
      fn();
    } else break;
    if (t.isBetting()) {
      assert.strictEqual(total(), buyIns(), 'chip conservation mid-hand');
      for (const p of t.players) assert(p.chips >= 0, 'negative chips');
    }
  }
  return { hands: t.handNumber - 1, actions, showdowns, sidePots };
}

for (const n of [2, 3, 6, 9]) {
  const r = run(n, 400);
  console.log(`${n} players: ${r.hands} hands, ${r.actions} actions, ${r.showdowns} showdowns, ${r.sidePots} with side pots`);
}
// short stacks to force blinds-all-in and many side pots
const r = run(5, 300, [7, 3, 1000, 40, 15]);
console.log(`short stacks: ${r.hands} hands, ${r.sidePots} with side pots`);
console.log('sim: all invariants held');
