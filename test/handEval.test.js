const assert = require('assert');
const { evaluate, compare } = require('../src/handEval');

const e = s => evaluate(s.split(' '));
const cases = [
  ['As Ks Qs Js Ts 2d 3c', 'Royal Flush'],
  ['9h 8h 7h 6h 5h Ad Ac', 'Straight Flush, Nine high'],
  ['Ah 2h 3h 4h 5h Kd Kc', 'Straight Flush, Five high'],
  ['Kd Kc Ks Kh 2c 3d 4s', 'Four Kings'],
  ['Qd Qc Qs 9h 9c 3d 4s', 'Full House, Queens over Nines'],
  ['2d 7d 9d Jd Kd Ac As', 'Flush, King high'],
  ['Ad 2c 3h 4s 5d Kc Kd', 'Pair of Kings'.replace('Pair of Kings', 'Straight, Five high')],
  ['Td Jc Qh Ks Ad 2c 2d', 'Straight, Ace high'],
  ['7d 7c 7s Ah 2c 9d 4s', 'Three Sevens'],
  ['8d 8c 3s 3h Ac 9d 4s', 'Two Pair, Eights & Threes'],
  ['Jd Jc 3s 5h Ac 9d 4s', 'Pair of Jacks'],
  ['Ad Jc 3s 5h 7c 9d 4s', 'Ace High'],
];
for (const [hand, name] of cases) assert.strictEqual(e(hand).name, name, hand);

// kicker comparisons
assert(compare(e('Ah Ad Kc 7s 2d 3c 9h').score, e('As Ac Qc 7d 2s 3d 9c').score) > 0, 'kicker K beats Q');
assert(compare(e('Ah Kd Qc Js 9d 2c 3h').score, e('As Kc Qd Jh 9s 2d 3c').score) === 0, 'split');
assert(compare(e('Ah 2d 3c 4s 5d 9c 9h').score, e('6s 2c 3d 4h 5s 9d Kc').score) < 0, 'wheel < six-high straight');
assert(compare(e('Kh Kd Kc 2s 2d 9c 8h').score, e('Qs Qc Qd As Ad 9d 8c').score) > 0, 'full house trips rank');
console.log('handEval: all', cases.length + 4, 'checks passed');
