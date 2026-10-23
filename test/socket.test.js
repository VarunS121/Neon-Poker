// End-to-end check over real sockets: create, join, start, act, privacy, chat, reconnect.
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3999;
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT }, stdio: 'pipe' });
const url = `http://localhost:${PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise(r => s.emit(ev, data, r));

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const s = { ws, last: null, chats: [], acks: {}, id: 1 };
  s.ready = new Promise(r => ws.on('open', r));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.ack != null) { s.acks[m.ack](m.d); delete s.acks[m.ack]; }
    else if (m.e === 'state') s.last = m.d;
    else if (m.e === 'chat') s.chats.push(m.d);
  });
  s.emit = (e, d, cb) => {
    const msg = { e, d };
    if (cb) { msg.id = s.id++; s.acks[msg.id] = cb; }
    ws.send(JSON.stringify(msg));
  };
  s.close = () => ws.close();
  s.disconnect = () => ws.close();
  return s;
}

(async () => {
  await wait(700);
  const a = client(), b = client(), c = client();
  await Promise.all([a.ready, b.ready, c.ready]);
  const r1 = await emit(a, 'create', { name: 'Alice', playerId: 'pa', settings: { smallBlind: 10, bigBlind: 20, startingStack: 2000, turnTime: 15 } });
  assert(r1.ok, 'create');
  const code = r1.code;
  assert((await emit(b, 'join', { code, name: 'Bob', playerId: 'pb' })).ok);
  assert((await emit(c, 'join', { code: 'ZZZZZ', name: 'X', playerId: 'px' })).error, 'bad code rejected');
  assert((await emit(b, 'start')).error, 'non-host cannot start');
  assert((await emit(a, 'start')).ok, 'host starts');
  await wait(150);

  const sa = a.last, sb = b.last;
  assert.strictEqual(sa.phase, 'preflop');
  assert(sa.seats[sa.mySeat].cards.length === 2, 'alice sees own cards');
  assert.strictEqual(sa.seats[sb.mySeat].cards, null, 'alice cannot see bob cards');
  assert.strictEqual(sb.seats[sa.mySeat].cards, null, 'bob cannot see alice cards');
  assert(!JSON.stringify(sa).includes('"pb"'), 'player ids not leaked');

  // play the hand out with check/call
  for (let i = 0; i < 20 && a.last.phase !== 'complete'; i++) {
    const cur = a.last.currentSeat;
    const s = cur === a.last.mySeat ? a : b;
    const acts = s.last.actions;
    if (!acts) { await wait(100); continue; }
    const r = await emit(s, 'action', { type: acts.canCheck ? 'check' : 'call' });
    assert(r.ok, 'action ok: ' + JSON.stringify(r));
    await wait(60);
  }
  assert.strictEqual(a.last.phase, 'complete', 'hand completes');
  assert.strictEqual(a.last.board.length, 5);
  assert(a.last.seats[b.last.mySeat].cards, 'showdown reveals cards');
  const chips = a.last.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0);
  assert.strictEqual(chips, 4000, 'chips conserved');

  // chat + reconnect keeps seat
  b.emit('chat', 'nice hand');
  await wait(150);
  assert(a.chats.some(m => m.text === 'nice hand' && m.name === 'Bob'), 'chat delivered');
  const bobSeat = b.last.mySeat;
  b.disconnect();
  await wait(200);
  assert.strictEqual(a.last.seats[bobSeat].connected, false, 'bob marked offline');
  const b2 = client();
  await b2.ready;
  const rj = await emit(b2, 'join', { code, name: 'Bob', playerId: 'pb' });
  assert(rj.ok);
  await wait(150);
  assert.strictEqual(b2.last.mySeat, bobSeat, 'same seat after reconnect');
  assert.strictEqual(a.last.seats[bobSeat].connected, true);

  console.log('socket e2e: all checks passed (table', code + ')');
  a.close(); b2.close(); c.close(); srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
