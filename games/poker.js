// Neon Hold'em game server: WebSocket poker rooms. Mounted by ../server.js at /poker/ws.
const { WebSocketServer } = require('ws');
const { Table } = require('../src/poker/table');

const rooms = new Map(); // code -> { table, members: Set<conn>, chat: [], cleanup, pending }

// ---------- helpers ----------
const EMOJIS = ['😂', '🔥', '😱', '👏', '😎', '🤡', '💀', '🙏', '😤', '🍀', '💸', '🫡'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code;
  do code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}
const clampInt = (v, min, max, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';

function send(conn, e, d) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify({ e, d }));
}
function toRoom(room, e, d) {
  const msg = JSON.stringify({ e, d });
  for (const c of room.members) if (c.ws.readyState === 1) c.ws.send(msg);
}
function broadcast(room) {
  for (const c of room.members) send(c, 'state', room.table.view(c.playerId));
}
function pushChat(room, msg) {
  msg.ts = Date.now();
  room.chat.push(msg);
  if (room.chat.length > 80) room.chat.shift();
  toRoom(room, 'chat', msg);
}

function createRoom(settings) {
  const code = genCode();
  const room = { members: new Set(), chat: [], cleanup: null, pending: false };
  room.table = new Table(code, settings, {
    changed: () => {
      if (room.pending) return; // coalesce several changes in one tick
      room.pending = true;
      setImmediate(() => { room.pending = false; broadcast(room); });
    },
    fx: fx => toRoom(room, 'fx', fx),
    log: text => pushChat(room, { system: true, text }),
  });
  rooms.set(code, room);
  return room;
}

function scheduleCleanup(room) {
  clearTimeout(room.cleanup);
  if (room.members.size > 0) return;
  room.cleanup = setTimeout(() => {
    if (room.members.size === 0) { room.table.destroy(); rooms.delete(room.table.code); }
  }, 30 * 60 * 1000);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

wss.on('connection', ws => {
  const conn = { ws, code: null, playerId: null, lastChat: 0, lastEmoji: 0 };
  ws.on('pong', () => (ws._dead = false));
  const room = () => rooms.get(conn.code);

  function joinRoom(r, name, playerId) {
    const seat = r.table.addPlayer(playerId, name);
    if (seat === -1) return { error: 'This table is full (9 players max)' };
    if (conn.code && conn.code !== r.table.code) leaveCurrent(false);
    conn.code = r.table.code;
    conn.playerId = playerId;
    r.members.add(conn);
    clearTimeout(r.cleanup);
    send(conn, 'chatHistory', r.chat);
    broadcast(r);
    return { ok: true, code: r.table.code };
  }

  function leaveCurrent(removeSeat) {
    const r = room();
    if (!r) return;
    r.members.delete(conn);
    const stillHere = [...r.members].some(c => c.playerId === conn.playerId);
    if (removeSeat) r.table.removePlayer(conn.playerId);
    else if (!stillHere) r.table.setConnected(conn.playerId, false);
    conn.code = null;
    scheduleCleanup(r);
  }

  const handlers = {
    create(data = {}) {
      const playerId = String(data.playerId || '').slice(0, 64);
      if (!playerId) return { error: 'Missing player id' };
      const s = data.settings || {};
      const smallBlind = clampInt(s.smallBlind, 1, 1e6, 10);
      const bigBlind = clampInt(s.bigBlind, smallBlind, 2e6, smallBlind * 2);
      const settings = {
        smallBlind,
        bigBlind,
        startingStack: clampInt(s.startingStack, bigBlind * 10, 1e9, bigBlind * 100),
        turnTime: [0, 15, 20, 30, 45, 60].includes(+s.turnTime) ? +s.turnTime : 30,
      };
      return joinRoom(createRoom(settings), cleanName(data.name), playerId);
    },
    join(data = {}) {
      const r = rooms.get(String(data.code || '').toUpperCase().trim());
      if (!r) return { error: 'Table not found — check the code' };
      const playerId = String(data.playerId || '').slice(0, 64);
      if (!playerId) return { error: 'Missing player id' };
      return joinRoom(r, cleanName(data.name), playerId);
    },
    action(data = {}) {
      const r = room(); if (!r) return { error: 'Not at a table' };
      const err = r.table.act(conn.playerId, String(data.type), data.amount);
      return err ? { error: err } : { ok: true };
    },
    start() {
      const r = room(); if (!r) return { error: 'Not at a table' };
      const err = r.table.startGame(conn.playerId);
      return err ? { error: err } : { ok: true };
    },
    sitout(value) {
      const r = room(); if (!r) return;
      r.table.setSittingOut(conn.playerId, !!value);
      return { ok: true };
    },
    rebuy() {
      const r = room(); if (!r) return { error: 'Not at a table' };
      const err = r.table.rebuy(conn.playerId);
      return err ? { error: err } : { ok: true };
    },
    leave() { leaveCurrent(true); return { ok: true }; },
    chat(text) {
      const r = room(); if (!r) return;
      const now = Date.now();
      if (now - conn.lastChat < 400) return;
      conn.lastChat = now;
      const p = r.table.findPlayer(conn.playerId);
      const clean = String(text || '').trim().slice(0, 300);
      if (clean && p) pushChat(r, { name: p.name, color: p.color, text: clean });
    },
    emoji(e) {
      const r = room(); if (!r || !EMOJIS.includes(e)) return;
      const now = Date.now();
      if (now - conn.lastEmoji < 700) return;
      conn.lastEmoji = now;
      const p = r.table.findPlayer(conn.playerId);
      if (p) toRoom(r, 'emoji', { seat: p.seat, emoji: e });
    },
  };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const h = msg && handlers[msg.e];
    if (!h) return;
    let result;
    try { result = h(msg.d); } catch (err) { console.error(err); result = { error: 'Server error' }; }
    if (msg.id != null && ws.readyState === 1) ws.send(JSON.stringify({ ack: msg.id, d: result || { ok: true } }));
  });
  ws.on('close', () => leaveCurrent(false));
  ws.on('error', () => {});
});

module.exports = { wss, rooms };
