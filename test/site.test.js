// Site routing: home page, each game's client and assets, redirects, health and WebSocket paths.
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3998;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT } });

const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => {
  let body = '';
  r.on('data', c => (body += c));
  r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'] || '', location: r.headers.location, body }));
}).on('error', rej));
const wsOpens = p => new Promise(res => {
  const ws = new WebSocket(`ws://localhost:${PORT}${p}`);
  ws.on('open', () => { ws.close(); res(true); });
  ws.on('error', () => res(false));
});

(async () => {
  await new Promise(res => srv.stdout.on('data', res));
  const home = await get('/');
  assert(home.body.includes('<title>Game Night</title>'), 'home page');
  assert((await get('/poker/')).body.includes("NEON <em>HOLD'EM</em>"), 'poker page');
  assert((await get('/catan/')).body.includes('<title>Catan Online</title>'), 'catan page');
  assert((await get('/uno/')).body.includes('<title>UNO No Mercy</title>'), 'uno page');
  assert(home.body.includes('href="/uno/"'), 'home links to uno');
  for (const asset of ['/net.js', '/poker/app.js', '/poker/style.css', '/poker/handEval.js', '/catan/app.js', '/catan/art.js', '/catan/style.css', '/uno/app.js', '/uno/style.css']) {
    const r = await get(asset);
    assert.strictEqual(r.status, 200, asset);
    assert(!r.type.includes('html'), asset + ' should not fall back to a page');
  }
  assert.deepStrictEqual([(await get('/poker')).status, (await get('/poker')).location], [301, '/poker/']);
  assert.deepStrictEqual([(await get('/catan?room=AB')).status, (await get('/catan?room=AB')).location], [301, '/catan/?room=AB']);
  const old = await get('/?room=XYZ12');
  assert.deepStrictEqual([old.status, old.location], [302, '/poker/?room=XYZ12'], 'old poker invite links still work');
  assert((await get('/catan/some/deep/link')).body.includes('Catan Online'), 'unknown game paths load that game');
  assert.strictEqual((await get('/../server.js')).body.includes('require('), false, 'no path traversal');
  assert.deepStrictEqual(JSON.parse((await get('/health')).body), { ok: true, rooms: { poker: 0, catan: 0, uno: 0 } });
  assert(await wsOpens('/poker/ws'));
  assert(await wsOpens('/catan/ws'));
  assert(await wsOpens('/uno/ws'));
  assert(!(await wsOpens('/ws')), 'unknown socket path refused');
  console.log('site: pages, assets, redirects, health and socket routing OK');
  srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
