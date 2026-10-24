// Texas Hold'em hand evaluator. Works in Node (require) and the browser (window.HandEval).
(function (root) {
  const RANKS = '23456789TJQKA';
  const VAL = {};
  for (let i = 0; i < RANKS.length; i++) VAL[RANKS[i]] = i + 2;

  const SINGULAR = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
  const PLURAL = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };

  // Score a 5-card hand. Returns an array compared lexicographically: [category, ...tiebreakers]
  function score5(cards) {
    const vals = cards.map(c => VAL[c[0]]).sort((a, b) => b - a);
    const flush = cards.every(c => c[1] === cards[0][1]);
    const uniq = [...new Set(vals)];
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (vals[0] - vals[4] === 4) straightHigh = vals[0];
      else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
    }
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const groups = Object.entries(counts)
      .map(([v, c]) => [c, +v])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const ordered = groups.map(g => g[1]);

    if (straightHigh && flush) return [8, straightHigh];
    if (groups[0][0] === 4) return [7, ...ordered];
    if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...ordered];
    if (flush) return [5, ...vals];
    if (straightHigh) return [4, straightHigh];
    if (groups[0][0] === 3) return [3, ...ordered];
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...ordered];
    if (groups[0][0] === 2) return [1, ...ordered];
    return [0, ...vals];
  }

  function compare(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  function describe(s) {
    switch (s[0]) {
      case 8: return s[1] === 14 ? 'Royal Flush' : `Straight Flush, ${SINGULAR[s[1]]} high`;
      case 7: return `Four ${PLURAL[s[1]]}`;
      case 6: return `Full House, ${PLURAL[s[1]]} over ${PLURAL[s[2]]}`;
      case 5: return `Flush, ${SINGULAR[s[1]]} high`;
      case 4: return `Straight, ${SINGULAR[s[1]]} high`;
      case 3: return `Three ${PLURAL[s[1]]}`;
      case 2: return `Two Pair, ${PLURAL[s[1]]} & ${PLURAL[s[2]]}`;
      case 1: return `Pair of ${PLURAL[s[1]]}`;
      default: return `${SINGULAR[s[1]]} High`;
    }
  }

  // Best 5 of any 5–7 cards.
  function evaluate(cards) {
    if (!cards || cards.length < 5) return null;
    let best = null, bestCards = null;
    const n = cards.length;
    const pick = [];
    (function rec(start) {
      if (pick.length === 5) {
        const hand = pick.map(i => cards[i]);
        const s = score5(hand);
        if (!best || compare(s, best) > 0) { best = s; bestCards = hand; }
        return;
      }
      for (let i = start; i <= n - (5 - pick.length); i++) {
        pick.push(i); rec(i + 1); pick.pop();
      }
    })(0);
    return { score: best, cards: bestCards, name: describe(best), category: best[0] };
  }

  // Rough name for 2–4 cards (e.g. preflop pair) — used by the client helper only.
  function describePartial(cards) {
    if (!cards || cards.length === 0) return '';
    if (cards.length >= 5) return evaluate(cards).name;
    const vals = cards.map(c => VAL[c[0]]).sort((a, b) => b - a);
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const groups = Object.entries(counts).map(([v, c]) => [c, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    if (groups[0][0] === 4) return `Four ${PLURAL[groups[0][1]]}`;
    if (groups[0][0] === 3) return `Three ${PLURAL[groups[0][1]]}`;
    if (groups[0][0] === 2 && groups[1] && groups[1][0] === 2) return `Two Pair, ${PLURAL[groups[0][1]]} & ${PLURAL[groups[1][1]]}`;
    if (groups[0][0] === 2) return `Pair of ${PLURAL[groups[0][1]]}`;
    return `${SINGULAR[vals[0]]} High`;
  }

  const api = { evaluate, compare, score5, describePartial };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HandEval = api;
})(typeof window !== 'undefined' ? window : globalThis);
