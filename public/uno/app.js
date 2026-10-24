// UNO No Mercy client: renders server state, sends actions. All rules live on the server.
(function () {
  const $ = id => document.getElementById(id);
  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const SYM = { skip: '⊘', reverse: '⇄', draw2: '+2', draw4: '+4', skipAll: '⊘', discardAll: '✕', wildRev4: '+4', wild6: '+6', wild10: '+10', roulette: '?' };
  const CAP = { skip: 'SKIP', reverse: 'REVERSE', skipAll: 'EVERYONE', discardAll: 'DISCARD ALL', wildRev4: 'REVERSE', roulette: 'ROULETTE', wild6: 'WILD', wild10: 'WILD' };
  const DRAWS = { draw2: 2, draw4: 4, wildRev4: 4, wild6: 6, wild10: 10 };
  const ORDER = { red: 0, yellow: 1, green: 2, blue: 3, null: 4 };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let playerId = store.get('uno.pid');
  if (!playerId) { playerId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('uno.pid', playerId); }
  // borrow the name from the other games if this is the first visit
  $('name').value = store.get('uno.name') || store.get('catan.name') || store.get('nh_name') || '';

  const net = new Net('/uno/ws');
  window.__net = net;
  let state = null;
  let modal = null;        // { kind, card } while choosing a color / swap target
  let tab = 'log';
  let unread = 0;
  let lastLogId = 0;
  let prevTop = null, prevHand = null, lastTurnKey = null;
  let soundOn = store.get('uno.sound') !== '0';

  // ---------- utils ----------
  function toast(msg, ok) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (ok ? ' ok' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function emit(e, d, cb) { net.emit(e, d, res => { if (res && res.error) toast(res.error); if (cb) cb(res || {}); }); }
  function act(type, data, cb) { emit('action', { type, data }, cb); }
  function show(screen) { for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== screen); }
  const player = id => state.players.find(p => p.id === id);
  const nameOf = id => { const p = player(id); return p ? esc(p.name) : '?'; };
  const myTurn = () => state && state.current === state.you && !state.spectator;

  function cardHtml(c, cls = '') {
    const s = c.type === 'number' ? c.value : SYM[c.type];
    const cap = CAP[c.type] || '';
    const u = c.type === 'number' && (c.value === 6 || c.value === 9) ? ' u' : '';
    return `<div class="ucard c-${c.color || 'wild'} t-${c.type} ${cls}" data-id="${c.id}">
      <span class="corner tl${u}">${s}</span>
      <div class="oval"><span class="big${u}${String(s).length > 2 ? ' long' : String(s).length > 1 ? ' mid' : ''}">${s}</span>${cap ? `<span class="cap">${cap}</span>` : ''}</div>
      <span class="corner br${u}">${s}</span></div>`;
  }

  // ---------- sound ----------
  let actx = null;
  function beep(freq, dur, type = 'sine', vol = 0.07, delay = 0) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, actx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + delay + dur);
      o.connect(g).connect(actx.destination);
      o.start(actx.currentTime + delay); o.stop(actx.currentTime + delay + dur);
    } catch {}
  }
  const sounds = {
    play() { beep(520, 0.07, 'triangle'); beep(780, 0.08, 'triangle', 0.05, 0.05); },
    draw(n) { for (let i = 0; i < Math.min(n, 8); i++) beep(300 - i * 15, 0.05, 'square', 0.03, i * 0.05); },
    turn() { beep(660, 0.12); beep(990, 0.18, 'sine', 0.07, 0.12); },
    big() { beep(140, 0.35, 'sawtooth', 0.06); beep(90, 0.45, 'sawtooth', 0.05, 0.1); },
    uno() { [880, 1175, 1568].forEach((f, i) => beep(f, 0.12, 'square', 0.05, i * 0.08)); },
    win() { [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.3, 'triangle', 0.08, i * 0.15)); },
  };

  // ---------- home & lobby ----------
  function myName() {
    const n = $('name').value.trim();
    if (!n) { toast('Enter your name first'); $('name').focus(); return null; }
    store.set('uno.name', n);
    return n;
  }
  function enterRoom(code) { store.set('uno.room', code); history.replaceState(null, '', '?room=' + code); }
  $('create').onclick = () => { const name = myName(); if (name) emit('create', { name, playerId, settings: { turnTime: 30 } }, r => { if (r.ok) enterRoom(r.code); }); };
  $('join').onclick = () => {
    const name = myName(); if (!name) return;
    const code = $('code').value.trim().toUpperCase();
    if (!code) return toast('Enter a game code');
    emit('join', { name, playerId, code }, r => { if (r.ok) enterRoom(r.code); });
  };
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });

  net.on('connect', () => {
    const url = new URLSearchParams(location.search).get('room');
    const code = (url || store.get('uno.room') || '').toUpperCase();
    if (url) $('code').value = url.toUpperCase();
    const name = store.get('uno.name');
    if (code && name) {
      net.emit('join', { name, playerId, code }, res => {
        if (res && res.ok) enterRoom(res.code);
        else { store.del('uno.room'); if (url) toast(res.error || 'Could not join'); show('home'); }
      });
    }
  });
  net.on('disconnect', () => toast('Connection lost — reconnecting…'));

  function invite() {
    const link = location.origin + '/uno/?room=' + state.code;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied', true), () => prompt('Copy this link:', link));
  }
  $('invite').onclick = invite;
  $('invite2').onclick = invite;
  $('lobby-time').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { turnTime: +b.dataset.time }); };
  $('lobby-70').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { sevenZero: b.dataset.on === '1' }); };
  $('start').onclick = () => emit('start');
  function leave() { emit('leave'); store.del('uno.room'); history.replaceState(null, '', '/uno/'); state = null; show('home'); }
  $('leave-lobby').onclick = leave;
  $('leave').onclick = () => { if (confirm('Leave this game?')) leave(); };
  $('sound').onclick = () => { soundOn = !soundOn; store.set('uno.sound', soundOn ? '1' : '0'); $('sound').textContent = soundOn ? '🔊' : '🔇'; };
  $('sound').textContent = soundOn ? '🔊' : '🔇';

  function renderLobby() {
    const s = state, host = s.hostId === s.you;
    $('lobby-code').textContent = s.code;
    $('lobby-players').innerHTML = s.players.map(p => `<li><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span> ${esc(p.name)}${p.id === s.hostId ? ' <em>host</em>' : ''}${p.id === s.you ? ' <em>you</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}</li>`).join('');
    for (const b of $('lobby-time').children) { b.classList.toggle('on', +b.dataset.time === s.settings.turnTime); b.disabled = !host; }
    for (const b of $('lobby-70').children) { b.classList.toggle('on', (b.dataset.on === '1') === s.settings.sevenZero); b.disabled = !host; }
    const n = s.players.length;
    $('lobby-note').textContent = n < 2 ? 'Waiting for players… (2–10)' : host ? 'Ready when you are! Share the invite link.' : 'Waiting for the host to start…';
    $('start').classList.toggle('hidden', !host);
    $('start').disabled = n < 2;
  }

  // ---------- table ----------
  function seatOrder() {
    // opponents in turn order, starting after you
    const ps = state.players, i = ps.findIndex(p => p.id === state.you);
    return i < 0 ? ps : ps.slice(i + 1).concat(ps.slice(0, i));
  }

  function renderOpponents() {
    const s = state;
    $('opponents').innerHTML = seatOrder().map(p => {
      const turn = p.id === s.current && s.phase !== 'over';
      const danger = p.cards / s.mercyLimit;
      const backs = Math.min(p.cards, 12);
      const canCatch = s.unoPending === p.id && !s.spectator && s.you !== p.id && !(player(s.you) || {}).out;
      return `<div class="opp${turn ? ' turn' : ''}${p.out ? ' out' : ''}${p.connected ? '' : ' off'}${p.id === s.winner ? ' won' : ''}" style="--c:${p.color}">
        <div class="opp-top"><span class="av">${esc(p.name[0].toUpperCase())}</span><b>${esc(p.name)}</b>${p.wins ? `<span class="wins" title="Rounds won">🏆${p.wins}</span>` : ''}</div>
        <div class="fan">${p.out ? '<span class="skull">💀 OUT</span>' : Array.from({ length: backs }, (_, k) => `<i style="--k:${k - (backs - 1) / 2}"></i>`).join('')}</div>
        <div class="opp-count">${p.out ? 'Mercy!' : `${p.cards} card${p.cards === 1 ? '' : 's'}`}</div>
        <div class="mercy" title="${p.cards}/${s.mercyLimit} — 25 cards and you're out"><i style="width:${Math.min(100, danger * 100)}%" class="${danger > 0.7 ? 'hot' : ''}"></i></div>
        ${canCatch ? `<button class="catch" data-catch="${p.id}">Catch! +2</button>` : ''}
        ${s.unoPending === p.id ? '' : (p.cards === 1 && !p.out ? '<span class="uno-tag">UNO</span>' : '')}
      </div>`;
    }).join('');
  }
  $('opponents').addEventListener('click', e => { const b = e.target.closest('[data-catch]'); if (b) act('catch', { target: b.dataset.catch }); });

  function renderCenter() {
    const s = state, top = s.top;
    const fresh = prevTop !== null && prevTop !== top.id;
    $('discard').innerHTML = cardHtml(top, fresh ? 'slam' : '');
    $('discard').style.setProperty('--cur', `var(--${s.color})`);
    $('discard').dataset.color = s.color;
    prevTop = top.id;
    $('deck-count').textContent = s.deckCount;
    $('dir').classList.toggle('ccw', s.direction === -1);
    $('dir').style.color = `var(--${s.color})`;
    const pend = $('pending');
    pend.classList.toggle('hidden', !s.pending);
    if (s.pending) pend.innerHTML = `<b>+${s.pending}</b><span>stack +${s.pendingMin} or more</span>`;
    const canDraw = myTurn() && s.phase === 'play' && s.drawn == null;
    $('deck').disabled = !canDraw;
    $('deck').classList.toggle('glow', canDraw && !s.playable.length);
  }
  $('deck').onclick = () => draw();

  function renderHand() {
    const s = state, el = $('hand');
    if (s.spectator) { el.innerHTML = '<p class="sub">You are watching this round.</p>'; return; }
    const me = player(s.you);
    if (me && me.out) { el.innerHTML = '<p class="out-msg">💀 You hit 25 cards — knocked out by the Mercy rule. Watch the rest of the round!</p>'; return; }
    const hand = (s.hand || []).slice().sort((a, b) => ORDER[a.color] - ORDER[b.color] || (a.type === 'number' ? a.value : 20) - (b.type === 'number' ? b.value : 20) || a.type.localeCompare(b.type));
    const playable = new Set(s.playable);
    const mine = myTurn() && s.phase === 'play';
    const seen = prevHand && prevHand.round === s.round ? prevHand.ids : null;
    el.innerHTML = hand.map(c => cardHtml(c, [
      mine && playable.has(c.id) ? 'ok' : '', mine && !playable.has(c.id) ? 'dim' : '',
      seen && !seen.has(c.id) ? 'new' : '', s.drawn === c.id ? 'drawn' : '',
    ].join(' '))).join('');
    prevHand = { round: s.round, ids: new Set(hand.map(c => c.id)) };
    fitHand();
  }
  // overlap cards so the whole hand fits; very large hands scroll
  function fitHand() {
    const el = $('hand'), n = el.children.length;
    if (!n) return;
    const w = el.clientWidth - 16, cw = el.children[0].offsetWidth || 80;
    const overlap = n > 1 ? Math.min(cw - 22, Math.max(0, (n * cw - w) / (n - 1))) : 0;
    el.style.setProperty('--ov', overlap + 'px');
  }
  window.addEventListener('resize', () => state && state.phase !== 'lobby' && fitHand());

  $('hand').addEventListener('click', e => {
    const el = e.target.closest('.ucard'); if (!el || !state) return;
    const card = state.hand.find(c => c.id === +el.dataset.id);
    if (!card || !state.playable.includes(card.id)) {
      if (myTurn() && state.phase === 'play') toast(state.pending ? `Stack +${state.pendingMin} or more, or take the cards` : state.drawn != null ? 'Play the card you drew, or pass' : "That card doesn't match");
      return;
    }
    if (['wildRev4', 'wild6', 'wild10'].includes(card.type)) return openModal({ kind: 'color', card });
    if (card.type === 'number' && card.value === 7 && state.settings.sevenZero && state.hand.length > 1) return openModal({ kind: 'swap', card });
    act('play', { cardId: card.id });
  });

  function draw() {
    if (!myTurn() || state.phase !== 'play' || state.drawn != null) return;
    act('draw');
  }

  function renderControls() {
    const s = state, me = player(s.you);
    const inPlay = s.phase === 'play' && me && !me.out;
    const unoBtn = $('b-uno');
    unoBtn.disabled = !inPlay || !s.hand || s.hand.length > 2 || s.saidUno;
    unoBtn.classList.toggle('urgent', s.unoPending === s.you);
    const d = $('b-draw');
    d.disabled = !(myTurn() && s.phase === 'play' && s.drawn == null);
    d.textContent = s.pending && myTurn() ? `Take +${s.pending}` : 'Draw';
    d.classList.toggle('danger', !!(s.pending && myTurn()));
    $('b-pass').disabled = !(myTurn() && s.drawn != null);
    $('my-count').innerHTML = me && !me.out && s.hand ? `<span>${s.hand.length} card${s.hand.length === 1 ? '' : 's'}</span><span class="mercy"><i style="width:${Math.min(100, (s.hand.length / s.mercyLimit) * 100)}%" class="${s.hand.length / s.mercyLimit > 0.7 ? 'hot' : ''}"></i></span>` : '';
  }
  $('b-uno').onclick = () => act('uno');
  $('b-draw').onclick = draw;
  $('b-pass').onclick = () => act('pass');

  function statusText() {
    const s = state, cur = nameOf(s.current);
    if (s.phase === 'over') return `🏆 ${nameOf(s.winner)} wins round ${s.round}!`;
    if (s.phase === 'roulette') return s.current === s.you ? '🎯 Color Roulette — pick a color' : `🎯 ${cur} is spinning the Color Roulette…`;
    if (!myTurn()) return s.pending ? `${cur} must stack or take +${s.pending}…` : `${cur}'s turn`;
    if (s.pending) return s.playable.length ? `Stack a +${s.pendingMin} or higher — or take ${s.pending}` : `No stack — take ${s.pending} cards`;
    if (s.drawn != null) return 'Play the card you drew, or pass';
    return s.playable.length ? 'Your turn — play a card' : 'Nothing to play — draw until you can';
  }

  // ---------- modals ----------
  function openModal(m) { modal = m; renderModal(); }
  function closeModal() { modal = null; $('modal').classList.add('hidden'); }
  function renderModal() {
    const s = state;
    let m = modal;
    if (s.phase === 'roulette' && s.current === s.you) m = { kind: 'roulette' };
    else if (s.phase === 'over') m = m && m.kind === 'over-hidden' ? m : { kind: 'over' };
    else if (m && (m.kind === 'roulette' || m.kind === 'over' || m.kind === 'over-hidden')) m = null;
    modal = m;
    if (!m || m.kind === 'over-hidden') { $('modal').classList.add('hidden'); return; }
    let html = '';
    const colorButtons = COLORS.map(c => `<button class="pick c-${c}" data-color="${c}">${c}</button>`).join('');
    if (m.kind === 'color') html = `<h3>Choose a color</h3>${cardHtml(m.card, 'preview')}<div class="colors">${colorButtons}</div><button class="ghost" data-cancel>Cancel</button>`;
    else if (m.kind === 'roulette') html = `<h3>🎯 Color Roulette!</h3><p class="sub">Name a color. Cards flip from the pile until it comes up, and you keep every one.</p><div class="colors">${colorButtons}</div>`;
    else if (m.kind === 'swap') {
      const others = s.players.filter(p => p.id !== s.you && !p.out);
      html = `<h3>🔁 Swap hands with…</h3><div class="targets">${others.map(p => `<button data-target="${p.id}"><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}<small>${p.cards} card${p.cards === 1 ? '' : 's'}</small></button>`).join('')}</div><button class="ghost" data-cancel>Cancel</button>`;
    } else if (m.kind === 'over') {
      const ranked = s.players.slice().sort((a, b) => b.wins - a.wins);
      const host = s.hostId === s.you;
      html = `<h3 class="win-title">🏆 ${nameOf(s.winner)} wins!</h3>
        <table class="scores">${ranked.map(p => `<tr class="${p.id === s.winner ? 'top' : ''}"><td><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}</td><td>${p.out ? '💀 out' : `${(s.hands[p.id] || []).length} left`}</td><td><b>${p.wins}</b> win${p.wins === 1 ? '' : 's'}</td></tr>`).join('')}</table>
        ${host ? '<button class="primary" data-next>Next round</button>' : '<p class="sub">Waiting for the host to start the next round…</p>'}
        <button class="ghost" data-hide>View table</button>`;
    }
    $('modal-card').innerHTML = html;
    $('modal').classList.remove('hidden');
  }
  $('modal-card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.cancel != null) closeModal();
    else if (d.hide != null) { modal = { kind: 'over-hidden' }; $('modal').classList.add('hidden'); }
    else if (d.next != null) emit('start');
    else if (d.color) {
      if (modal.kind === 'roulette') act('rouletteColor', { color: d.color });
      else act('play', { cardId: modal.card.id, color: d.color });
      closeModal();
    } else if (d.target) { act('play', { cardId: modal.card.id, target: d.target }); closeModal(); }
  });

  // ---------- splash effects ----------
  function splash(text, color, big) {
    const el = $('splash');
    el.innerHTML = `<span style="--sc:${color || '#fff'}">${text}</span>`;
    el.className = 'splash' + (big ? ' big' : '');
    void el.offsetWidth;
    el.classList.add('go');
  }
  function shake() { const t = document.querySelector('.table'); t.classList.remove('shake'); void t.offsetWidth; t.classList.add('shake'); }
  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const cols = ['#e8262f', '#f6c21a', '#22a447', '#1f6fd6', '#fff'];
    for (let i = 0; i < 140; i++) {
      const c = document.createElement('i');
      c.style.cssText = `left:${Math.random() * 100}%;background:${cols[i % cols.length]};animation-delay:${Math.random() * 1.2}s;animation-duration:${2.4 + Math.random() * 2}s`;
      box.appendChild(c);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5500);
  }
  net.on('fx', fx => {
    if (!state || state.phase === 'lobby') return;
    const colorOf = c => `var(--${c.color || state.color})`;
    if (fx.type === 'play') {
      const c = fx.card;
      sounds.play();
      if (DRAWS[c.type]) { splash(`+${DRAWS[c.type]}`, colorOf(c), DRAWS[c.type] >= 6); if (DRAWS[c.type] >= 6) sounds.big(); }
      else if (c.type === 'skip') splash('SKIP!', colorOf(c));
      else if (c.type === 'skipAll') splash('SKIP EVERYONE!', colorOf(c));
      else if (c.type === 'reverse') splash('REVERSE!', colorOf(c));
      else if (c.type === 'discardAll') splash('DISCARD ALL!', colorOf(c));
      else if (c.type === 'roulette') splash('ROULETTE!', '#fff', true);
    } else if (fx.type === 'draw') {
      sounds.draw(fx.n);
      if (fx.n >= 4) { splash(`${nameOf(fx.id)} +${fx.n}`, '#ff4d4d', fx.n >= 10); if (fx.n >= 8) shake(); }
    } else if (fx.type === 'mercy') { splash(`💀 MERCY! ${nameOf(fx.id)} is out`, '#ff4d4d', true); sounds.big(); shake(); }
    else if (fx.type === 'uno') { splash(`${nameOf(fx.id)}: UNO!`, '#f6c21a', true); sounds.uno(); }
    else if (fx.type === 'caught') { splash(`CAUGHT! ${nameOf(fx.id)} +2`, '#ff4d4d'); sounds.big(); }
    else if (fx.type === 'swap') splash('🔁 SWAP!', '#fff');
    else if (fx.type === 'rotate') splash('🔄 PASS IT ON!', '#fff');
    else if (fx.type === 'roulette') splash(`🎯 ${fx.cards.length} card${fx.cards.length === 1 ? '' : 's'}!`, `var(--${state.color})`, fx.cards.length >= 5);
    else if (fx.type === 'win') { sounds.win(); confetti(); }
  });

  // ---------- log, chat, tabs ----------
  function renderLog() {
    const el = $('tab-log'), log = state.log || [];
    el.innerHTML = log.map(l => `<div class="${l.to ? 'private' : ''}">${esc(l.text)}</div>`).join('');
    if (log.length && log[log.length - 1].id !== lastLogId) el.scrollTop = el.scrollHeight;
    if (log.length) lastLogId = log[log.length - 1].id;
  }
  document.querySelector('.tabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    for (const t of ['log', 'chat', 'rules']) $('tab-' + t).classList.toggle('hidden', t !== tab);
    if (tab === 'chat') { unread = 0; badge(); $('chat-list').scrollTop = 1e9; }
  };
  function badge() { $('chat-badge').textContent = unread; $('chat-badge').classList.toggle('hidden', !unread); }
  function addChat(m) {
    const div = document.createElement('div');
    div.innerHTML = `<b style="color:${m.color}">${esc(m.name)}</b> ${esc(m.text)}`;
    $('chat-list').appendChild(div);
    $('chat-list').scrollTop = 1e9;
  }
  net.on('chatHistory', list => { $('chat-list').innerHTML = ''; list.forEach(addChat); });
  net.on('chat', m => { addChat(m); if (tab !== 'chat') { unread++; badge(); } });
  $('chat-form').onsubmit = e => { e.preventDefault(); const t = $('chat-input').value.trim(); if (t) emit('chat', t); $('chat-input').value = ''; };

  // ---------- timer ----------
  let timerEnd = null;
  function updateTimer() {
    const el = $('timer');
    if (!el) return;
    if (!timerEnd || !state || state.phase === 'over') { el.textContent = ''; return; }
    const secs = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    el.textContent = `⏱ ${secs}s`;
    el.className = secs <= 5 ? 'low' : '';
  }
  setInterval(updateTimer, 250);

  // ---------- main render ----------
  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
    show('game');
    $('room-code').textContent = state.code;
    $('status').innerHTML = `<span>${statusText()}</span><span id="timer"></span>`;
    $('status').classList.toggle('mine', myTurn() && state.phase !== 'over');
    $('status').classList.toggle('danger', !!(myTurn() && state.pending));
    updateTimer();
    renderOpponents();
    renderCenter();
    renderHand();
    renderControls();
    renderLog();
    renderModal();
  }

  net.on('state', s => {
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    state = s;
    if (s.phase === 'lobby') { prevTop = null; prevHand = null; }
    const key = `${s.round}:${s.turnSeq}`;
    if ((s.phase === 'play' || s.phase === 'roulette') && s.current === s.you && key !== lastTurnKey) {
      sounds.turn();
      if (document.hidden) document.title = '🔔 Your turn — UNO';
    }
    lastTurnKey = s.current === s.you ? key : null;
    render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'UNO No Mercy'; });

  // keyboard: D draw, P pass, U uno
  document.addEventListener('keydown', e => {
    if (!state || state.phase === 'lobby' || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'd') draw();
    else if (k === 'p' && !$('b-pass').disabled) act('pass');
    else if (k === 'u' && !$('b-uno').disabled) act('uno');
    else if (k === 'escape' && modal && (modal.kind === 'color' || modal.kind === 'swap')) closeModal();
  });
})();
