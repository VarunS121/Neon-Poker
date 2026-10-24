// UNO end-to-end over real WebSockets: create, join, configure, start, private hands, play, reconnect.
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3997;
const srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { env: { ...process.env, PORT } });

function client(pid) {
  const ws = new WebSocket(`ws://localhost:${PORT}/uno/ws`);
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
  const cs = ['a', 'b', 'c'].map(client);
  await Promise.all(cs.map(c => c.ready));
  const created = await cs[0].emit('create', { name: 'Ann', playerId: 'a', settings: { turnTime: 0 } });
  assert(created.ok);
  for (const c of cs.slice(1)) assert((await c.emit('join', { name: c.pid.toUpperCase(), playerId: c.pid, code: created.code })).ok);
  assert((await cs[1].emit('start')).error, 'only the host starts');
  assert((await cs[0].emit('configure', { sevenZero: false })).ok);
  assert((await cs[0].emit('start')).ok);
  await wait(60);
  const s = cs[0].state;
  assert.strictEqual(s.phase, 'play');
  assert.strictEqual(s.hand.length, 7);
  assert.strictEqual(s.settings.sevenZero, false);
  const raw = JSON.stringify({ ...s, log: [] }); // log entries have numeric ids too
  for (const c of cs.slice(1)) for (const card of c.state.hand) assert(!raw.includes(`"id":${card.id},`), 'other hands are hidden');
  assert(!('deck' in s), 'the draw pile is hidden');

  // whoever is up plays a legal card, or draws
  const turn = cs.find(c => c.pid === s.current);
  const before = turn.state.hand.length;
  const id = turn.state.playable[0];
  const res = id != null ? await turn.emit('action', { type: 'play', data: { cardId: id, color: 'red' } }) : await turn.emit('action', { type: 'draw' });
  assert(res.ok, JSON.stringify(res));
  await wait(60);
  assert.notStrictEqual(turn.state.hand.length, before);
  assert((await turn.emit('action', { type: 'play', data: { cardId: 99999 } })).error, 'bogus card rejected');

  // reconnect keeps the seat and the hand
  const hand = cs[2].state.hand.map(c => c.id).sort().join();
  cs[2].ws.close();
  const again = client('c'); await again.ready;
  assert((await again.emit('join', { name: 'C', playerId: 'c', code: created.code })).ok);
  await wait(60);
  assert.strictEqual(again.state.hand.map(c => c.id).sort().join(), hand);
  console.log('uno socket: create/join/configure/start/privacy/play/reconnect all OK');
  srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
