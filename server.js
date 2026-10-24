// Game Night server: one site, several games. Serves the home page and each game's client,
// and routes WebSocket upgrades to the right game. Single dependency: ws.
const path = require('path');
const fs = require('fs');
const http = require('http');

const GAMES = {
  poker: require('./games/poker'),
  catan: require('./games/catan'),
};

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveFile(res, file, status = 200) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(status, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [k, g.rooms.size])) }));
  }
  // invite links from before the merge were /?room=CODE and always meant poker
  if (p === '/' && url.searchParams.has('room')) {
    res.writeHead(302, { location: '/poker/' + url.search });
    return res.end();
  }
  const game = Object.keys(GAMES).find(g => p === '/' + g);
  if (game) { res.writeHead(301, { location: `/${game}/${url.search}` }); return res.end(); }
  if (p === '/poker/handEval.js') return serveFile(res, path.join(__dirname, 'src', 'poker', 'handEval.js'));

  const rel = decodeURIComponent(p).replace(/^\/+/, '') || 'index.html';
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (rel.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) return serveFile(res, file);
    // unknown paths fall back to that game's app (or the home page), so ?room=CODE links always work
    const inGame = Object.keys(GAMES).find(g => p.startsWith(`/${g}/`));
    serveFile(res, path.join(PUBLIC, inGame || '', 'index.html'));
  });
});

// ---------- WebSocket: /poker/ws and /catan/ws ----------
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  const game = Object.keys(GAMES).find(g => p === `/${g}/ws`);
  if (!game) return socket.destroy();
  const { wss } = GAMES[game];
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// drop dead connections so players show as offline quickly
setInterval(() => {
  for (const { wss } of Object.values(GAMES)) {
    for (const ws of wss.clients) {
      if (ws._dead) { ws.terminate(); continue; }
      ws._dead = true;
      try { ws.ping(); } catch {}
    }
  }
}, 15000);

server.listen(PORT, () => console.log(`Game Night running on http://localhost:${PORT}`));
