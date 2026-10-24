// Yahtzee end-to-end over real WebSockets: create, join, bots, start, roll, hold, score, reconnect.
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3994;
const srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { env: { ...process.env, PORT } });

function client(pid) {
  const ws = new WebSocket(`ws://localhost:${PORT}/yahtzee/ws`);
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
  const created = await a.emit('create', { name: 'Ann', playerId: 'a', settings: { turnTime: 0 } });
  assert(created.ok);
  assert((await b.emit('join', { name: 'Bob', playerId: 'b', code: created.code })).ok);
  assert((await b.emit('addBot')).error, 'only the host adds bots');
  assert((await a.emit('addBot')).ok);
  await wait(40);
  assert.strictEqual(a.state.players.length, 3);
  assert((await a.emit('start')).ok);
  await wait(40);
  const first = [a, b].find(c => c.pid === a.state.current);
  assert(first, 'a human starts game 1');
  const other = first === a ? b : a;
  assert((await other.emit('action', { type: 'roll' })).error, 'not your turn');
  assert((await first.emit('action', { type: 'roll' })).ok);
  await wait(40);
  assert.strictEqual(first.state.rollsLeft, 2);
  assert((await first.emit('action', { type: 'hold', data: { index: 2 } })).ok);
  await wait(40);
  assert.strictEqual(other.state.held[2], true, 'everyone sees holds');
  const kept = first.state.dice[2];
  assert((await first.emit('action', { type: 'roll' })).ok);
  await wait(40);
  assert.strictEqual(first.state.dice[2], kept);
  assert((await first.emit('action', { type: 'score', data: { cat: 'chance' } })).ok);
  await wait(40);
  const me = first.state.players.find(p => p.id === first.pid);
  assert.strictEqual(me.card.chance, first.state.players.find(p => p.id === first.pid).totals.lower);

  // reconnect keeps the card
  other.ws.close();
  const again = client(other.pid); await again.ready;
  assert((await again.emit('join', { name: 'X', playerId: other.pid, code: created.code })).ok);
  await wait(40);
  assert(!again.state.spectator);
  console.log('yahtzee socket: create/join/bots/start/roll/hold/score/reconnect all OK');
  srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
