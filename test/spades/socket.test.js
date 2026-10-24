// Spades end-to-end over real WebSockets: create, join, seats, bots, start, private hands, bidding, reconnect.
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3995;
const srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { env: { ...process.env, PORT } });

function client(pid) {
  const ws = new WebSocket(`ws://localhost:${PORT}/spades/ws`);
  const c = { ws, pid, state: null, acks: {}, id: 1 };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.ack != null) { c.acks[m.ack](m.d); delete c.acks[m.ack]; } else if (m.e === 'state') c.state = m.d;
  });
  c.emit = (e, d) => new Promise(res => { const id = c.id++; c.acks[id] = res; ws.send(JSON.stringify({ e, d, id })); });
  c.ready = new Promise(res => ws.on('open', res));
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(res => srv.stdout.on('data', res));
  const [a, b] = ['a', 'b'].map(client);
  await Promise.all([a.ready, b.ready]);
  const created = await a.emit('create', { name: 'Ann', playerId: 'a', settings: { turnTime: 0, target: 250 } });
  assert(created.ok);
  assert((await b.emit('join', { name: 'Bob', playerId: 'b', code: created.code })).ok);
  assert((await a.emit('start')).error, 'needs four players');
  assert((await b.emit('addBot', 1)).error, 'only the host adds bots');
  assert((await b.emit('sit', 2)).ok, 'Bob moves to sit opposite Ann');
  assert((await a.emit('addBot', 1)).ok);
  assert((await a.emit('addBot', 3)).ok);
  await wait(50);
  assert.deepStrictEqual(a.state.seats.map(s => s && (s.bot ? 'bot' : s.id)), ['a', 'bot', 'b', 'bot']);
  assert((await a.emit('start')).ok);
  await wait(60);
  const s = a.state;
  assert.strictEqual(s.hand.length, 13);
  const raw = JSON.stringify({ ...s, log: [] });
  for (const card of b.state.hand) assert(!raw.includes(`"id":"${card.id}"`), 'partner hand hidden');
  assert(!('hands' in s), 'no hands in the view');

  // play the bidding: the humans bid when it's their turn, bots answer on their own
  for (let k = 0; k < 40 && (a.state.phase === 'bidding'); k++) {
    const turn = a.state.turn;
    if (turn === 0) assert((await a.emit('action', { type: 'bid', data: { bid: 3 } })).ok);
    else if (turn === 2) {
      assert((await b.emit('action', { type: 'bid', data: { bid: 99 } })).error, 'bad bid');
      assert((await b.emit('action', { type: 'bid', data: { bid: 'nil' } })).ok);
    }
    await wait(300);
  }
  assert.strictEqual(a.state.phase, 'playing');
  assert.strictEqual(a.state.bids[0], 3);
  assert.strictEqual(a.state.bids[2], 'nil');

  // reconnecting keeps the seat and the cards
  const hand = b.state.hand.map(c => c.id).join();
  b.ws.close();
  const again = client('b'); await again.ready;
  assert((await again.emit('join', { name: 'Bob', playerId: 'b', code: created.code })).ok);
  await wait(60);
  assert.strictEqual(again.state.mySeat, 2);
  assert.strictEqual(again.state.hand.map(c => c.id).join(), hand);
  console.log('spades socket: seats/bots/start/privacy/bidding/reconnect all OK');
  srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
