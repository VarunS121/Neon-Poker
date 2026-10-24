// Spades client: renders server state, sends actions. All rules (and the bots) live on the server.
(function () {
  const $ = id => document.getElementById(id);
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const SHOW_ORDER = { S: 0, H: 1, C: 2, D: 3 };   // alternate colors in the hand
  const POS = ['bottom', 'left', 'top', 'right'];
  const COMPASS = ['South', 'West', 'North', 'East'];

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let playerId = store.get('spades.pid');
  if (!playerId) { playerId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('spades.pid', playerId); }
  $('name').value = store.get('spades.name') || store.get('spin.name') || store.get('uno.name') || store.get('catan.name') || store.get('nh_name') || '';

  const net = new Net('/spades/ws');
  window.__net = net;
  let state = null, modal = null, tab = 'log', unread = 0, lastLogId = 0;
  let prevTrick = [], prevHandNo = null, lastTurnKey = null;
  let soundOn = store.get('spades.sound') !== '0';

  // ---------- utils ----------
  function toast(msg, ok) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : '');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function emit(e, d, cb) { net.emit(e, d, res => { if (res && res.error) toast(res.error); if (cb) cb(res || {}); }); }
  function act(type, data, cb) { emit('action', { type, data }, cb); }
  function show(screen) { for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== screen); }
  const base = () => (state.mySeat >= 0 ? state.mySeat : 0);
  const posOf = seat => POS[(seat - base() + 4) % 4];
  const nameAt = seat => (state.seats[seat] ? esc(state.seats[seat].name) : 'Empty');
  const teamLabel = t => {
    if (state.mySeat >= 0) return state.mySeat % 2 === t ? 'Us' : 'Them';
    return t === 0 ? 'North/South' : 'East/West';
  };
  const teamNames = t => `${nameAt(t)} & ${nameAt(t + 2)}`;
  const bidText = b => (b === null || b === undefined ? '…' : b === 'nil' ? 'Nil' : b === 'blind' ? 'Blind Nil' : b);

  function cardHtml(c, cls = '') {
    const red = c.s === 'H' || c.s === 'D';
    const r = RANK[c.r] || c.r;
    return `<div class="pcard ${red ? 'red' : 'black'} ${cls}" data-id="${c.id}"><span class="cr tl">${r}<i>${SUIT[c.s]}</i></span><span class="pip">${SUIT[c.s]}</span><span class="cr br">${r}<i>${SUIT[c.s]}</i></span></div>`;
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
      o.connect(g).connect(actx.destination); o.start(actx.currentTime + delay); o.stop(actx.currentTime + delay + dur);
    } catch {}
  }
  const sounds = {
    card() { beep(380, 0.05, 'triangle', 0.06); beep(240, 0.06, 'triangle', 0.04, 0.03); },
    trick() { beep(520, 0.09, 'sine', 0.06); beep(660, 0.1, 'sine', 0.05, 0.08); },
    turn() { beep(660, 0.12); beep(880, 0.16, 'sine', 0.06, 0.12); },
    broken() { beep(200, 0.25, 'sawtooth', 0.05); },
    win() { [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.3, 'triangle', 0.08, i * 0.15)); },
  };

  // ---------- home & lobby ----------
  function myName() {
    const n = $('name').value.trim();
    if (!n) { toast('Enter your name first'); $('name').focus(); return null; }
    store.set('spades.name', n);
    return n;
  }
  function enterRoom(code) { store.set('spades.room', code); history.replaceState(null, '', '?room=' + code); }
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
    const code = (url || store.get('spades.room') || '').toUpperCase();
    if (url) $('code').value = url.toUpperCase();
    const name = store.get('spades.name');
    if (code && name) {
      net.emit('join', { name, playerId, code }, res => {
        if (res && res.ok) enterRoom(res.code);
        else { store.del('spades.room'); if (url) toast(res.error || 'Could not join'); show('home'); }
      });
    }
  });
  net.on('disconnect', () => toast('Connection lost — reconnecting…'));

  $('invite').onclick = () => {
    const link = location.origin + '/spades/?room=' + state.code;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied', true), () => prompt('Copy this link:', link));
  };
  $('lobby-target').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { target: +b.dataset.t }); };
  $('lobby-blind').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { blindNil: b.dataset.on === '1' }); };
  $('lobby-time').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { turnTime: +b.dataset.time }); };
  $('start').onclick = () => emit('start');
  function leave() { emit('leave'); store.del('spades.room'); history.replaceState(null, '', '/spades/'); state = null; show('home'); }
  $('leave-lobby').onclick = leave;
  $('leave').onclick = () => { if (confirm('Leave this game? Your seat will be played automatically if there is a turn timer.')) leave(); };
  $('sound').onclick = () => { soundOn = !soundOn; store.set('spades.sound', soundOn ? '1' : '0'); $('sound').textContent = soundOn ? '🔊' : '🔇'; };
  $('sound').textContent = soundOn ? '🔊' : '🔇';

  function renderLobby() {
    const s = state, host = s.hostId === s.you;
    $('lobby-code').textContent = s.code;
    // seats drawn around a little table: South bottom, West left, North top, East right
    $('seat-map').innerHTML = `<div class="mini-table"><span>Team 1: N/S<br>Team 2: E/W</span></div>` + s.seats.map((p, i) => {
      const me = p && p.id === s.you;
      let body;
      if (p) {
        const tags = [p.bot && 'bot', me && 'you', p.id === s.hostId && 'host', !p.connected && 'offline'].filter(Boolean).join(' · ');
        const btns = (me ? '<button class="small ghost" data-stand>Stand up</button>' : '') + (p.bot && host ? `<button class="small ghost" data-remove="${i}">Remove</button>` : '');
        body = `<b>${esc(p.name)}</b>${tags ? `<em>${tags}</em>` : ''}${btns ? `<div class="sbtns">${btns}</div>` : ''}`;
      } else {
        body = `<span class="empty">Empty seat</span><div class="sbtns"><button class="small" data-sit="${i}">Sit here</button>${host ? `<button class="small ghost" data-bot="${i}">+ Bot</button>` : ''}</div>`;
      }
      return `<div class="seat s${i} team${i % 2}${me ? ' mine' : ''}"><small>${COMPASS[i]} · Team ${i % 2 + 1}</small>${body}</div>`;
    }).join('');
    $('watchers').textContent = s.spectators.length ? `Watching: ${s.spectators.map(x => x.name).join(', ')}` : '';
    const seg = (id, attr, val) => { for (const b of $(id).children) { b.classList.toggle('on', b.dataset[attr] === String(val)); b.disabled = !host; } };
    seg('lobby-target', 't', s.settings.target);
    seg('lobby-blind', 'on', s.settings.blindNil ? '1' : '0');
    seg('lobby-time', 'time', s.settings.turnTime);
    const filled = s.seats.filter(Boolean).length;
    $('lobby-note').textContent = filled < 4 ? `${filled}/4 seats filled${host ? ' — invite friends or add bots' : ''}.` : host ? 'All seats filled. Ready when you are!' : 'Waiting for the host to start…';
    $('start').classList.toggle('hidden', !host);
    $('start').disabled = filled < 4;
  }
  $('seat-map').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sit != null) emit('sit', +b.dataset.sit);
    else if (b.dataset.bot != null) emit('addBot', +b.dataset.bot);
    else if (b.dataset.remove != null) emit('removeBot', +b.dataset.remove);
    else if (b.dataset.stand != null) emit('stand');
  });

  // ---------- table ----------
  function renderScoreboard() {
    const s = state;
    const teams = [0, 1].map(t => {
      const bid = [t, t + 2].reduce((a, i) => a + (typeof (s.bids || [])[i] === 'number' ? s.bids[i] : 0), 0);
      const won = s.tricks ? s.tricks[t] + s.tricks[t + 2] : 0;
      const mine = s.mySeat >= 0 && s.mySeat % 2 === t;
      return `<div class="team t${t}${mine ? ' mine' : ''}" title="${teamNames(t)}"><span class="tl">${teamLabel(t)}</span><b>${s.scores[t]}</b><small>bags ${s.bags[t]}</small>${s.bids ? `<small>bid ${bid} · won ${won}</small>` : ''}</div>`;
    });
    $('scoreboard').innerHTML = teams.join('<span class="vs">vs</span>') + `<span class="target">to ${s.settings.target}</span>`;
  }

  function renderSeats() {
    const s = state;
    for (let seat = 0; seat < 4; seat++) {
      const pos = posOf(seat), p = s.seats[seat], el = $('pos-' + pos);
      const turn = (s.phase === 'bidding' || s.phase === 'playing') && s.turn === seat;
      const bid = s.bids ? s.bids[seat] : null;
      const backs = pos === 'bottom' ? '' : `<div class="backs">${Array.from({ length: Math.min(s.counts ? s.counts[seat] : 0, 13) }, (_, k) => `<i style="--k:${k}"></i>`).join('')}</div>`;
      el.className = `seat-tag pos-${pos} team${seat % 2}${turn ? ' turn' : ''}${p && !p.connected ? ' off' : ''}`;
      el.innerHTML = `${backs}<div class="tag"><b>${p ? esc(p.name) : '—'}</b>${p && p.bot ? '<em>bot</em>' : ''}${s.dealer === seat ? '<span class="dealer" title="Dealer">D</span>' : ''}
        <span class="bt">${s.phase === 'lobby' ? '' : `Bid <b>${bidText(bid)}</b> · Won <b>${s.tricks ? s.tricks[seat] : 0}</b>`}</span></div>`;
    }
  }

  function renderTrick() {
    const s = state, el = $('trick');
    const trick = s.trick || [];
    const fresh = trick.length > prevTrick.length ? trick.slice(prevTrick.length).map(t => t.card.id) : [];
    const done = s.phase === 'trickEnd' && s.lastTrick;
    el.innerHTML = trick.map(t => {
      const pos = posOf(t.seat);
      const win = done && s.lastTrick.winner === t.seat;
      return `<div class="slot at-${pos}${fresh.includes(t.card.id) ? ' in-' + pos : ''}">${cardHtml(t.card, win ? 'winner' : '')}</div>`;
    }).join('');
    // after a moment the finished trick sweeps to whoever won it
    if (done) {
      const to = posOf(s.lastTrick.winner), handNo = s.handNo, left = s.counts.join();
      setTimeout(() => { if (state.phase === 'trickEnd' && state.handNo === handNo && state.counts.join() === left) el.classList.add('sweep', 'to-' + to); }, 800);
    }
    else el.className = 'trick';
    prevTrick = trick.slice();
    $('broken').classList.toggle('hidden', !s.spadesBroken);
    $('last-trick').classList.toggle('hidden', !s.lastTrick || s.phase === 'bidding');
  }
  $('last-trick').onclick = () => openModal({ kind: 'last' });

  function renderHand() {
    const s = state, el = $('hand');
    if (s.mySeat < 0) { el.innerHTML = '<p class="sub">You are watching this game.</p>'; return; }
    if (!s.hand) {
      el.innerHTML = '<div class="facedown">' + Array.from({ length: 13 }, () => '<div class="pcard back"></div>').join('') + '</div>';
      return;
    }
    const hand = s.hand.slice().sort((a, b) => SHOW_ORDER[a.s] - SHOW_ORDER[b.s] || b.r - a.r);
    const legal = new Set(s.legal || []);
    const myTurn = s.phase === 'playing' && s.turn === s.mySeat;
    const dealt = prevHandNo !== s.handNo;
    el.innerHTML = hand.map((c, k) => cardHtml(c, [myTurn && legal.has(c.id) ? 'ok' : '', myTurn && !legal.has(c.id) ? 'dim' : '', dealt ? 'deal' : ''].join(' ')).replace('class="pcard', `style="--d:${k * 40}ms" class="pcard`)).join('');
    prevHandNo = s.handNo;
    fitHand();
  }
  function fitHand() {
    const el = $('hand'), n = el.children.length;
    if (!n) return;
    const w = el.clientWidth - 16, cw = el.children[0].offsetWidth || 70;
    el.style.setProperty('--ov', (n > 1 ? Math.min(cw - 20, Math.max(0, (n * cw - w) / (n - 1))) : 0) + 'px');
  }
  window.addEventListener('resize', () => state && state.phase !== 'lobby' && fitHand());
  $('hand').addEventListener('click', e => {
    const el = e.target.closest('.pcard'); if (!el || !state || !el.dataset.id) return;
    if (state.phase !== 'playing' || state.turn !== state.mySeat) return;
    if (!(state.legal || []).includes(el.dataset.id)) {
      const led = state.trick && state.trick[0];
      return toast(led ? `You must follow ${SUIT[led.card.s]} if you can` : "Spades aren't broken yet — lead another suit");
    }
    act('play', { card: el.dataset.id });
  });

  function renderBidBox() {
    const s = state, box = $('bidbox');
    const mine = s.phase === 'bidding' && s.turn === s.mySeat;
    box.classList.toggle('hidden', !mine);
    if (!mine) return;
    const partner = (s.mySeat + 2) % 4;
    const pb = s.bids[partner];
    if (!s.hand) {
      box.innerHTML = `<h3>Your bid</h3><p class="sub">Your team is behind by 100+. Bid <b>Blind Nil</b> without looking (±200), or look at your cards first.</p>
        <div class="bid-row"><button class="primary" data-bid="blind">Blind Nil</button><button data-look>Look at my cards</button></div>`;
      return;
    }
    box.innerHTML = `<h3>Your bid</h3>${pb != null ? `<p class="sub">Partner bid <b>${bidText(pb)}</b></p>` : ''}
      <div class="bid-grid"><button class="nil" data-bid="nil">Nil</button>${Array.from({ length: 13 }, (_, k) => `<button data-bid="${k + 1}">${k + 1}</button>`).join('')}</div>`;
  }
  $('bidbox').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.look != null) return act('look');
    const v = b.dataset.bid;
    if (v === 'nil' && !confirm('Bid Nil? You promise to win no tricks (+100 / −100).')) return;
    act('bid', { bid: v === 'nil' || v === 'blind' ? v : +v });
  });

  function statusText() {
    const s = state, who = nameAt(s.turn);
    const me = s.turn === s.mySeat;
    if (s.phase === 'bidding') return me ? 'Your bid' : `${who} is bidding…`;
    if (s.phase === 'trickEnd') return `${nameAt(s.lastTrick.winner)} takes the trick`;
    if (s.phase === 'playing') {
      if (!me) return `${who}'s turn`;
      const led = s.trick && s.trick[0];
      return led ? `Your turn — follow ${SUIT[led.card.s]} if you can` : 'Your lead';
    }
    if (s.phase === 'handOver') return 'Hand over';
    if (s.phase === 'over') return `🏆 ${teamLabel(s.winnerTeam)} win!`;
    return '';
  }

  function renderHistory() {
    const s = state;
    const rows = s.history.map(h => `<tr><td>${h.hand}</td>${[0, 1].map(t => `<td>${[t, t + 2].map(i => bidText(h.bids[i])).join('+')} / ${h.tricks[t] + h.tricks[t + 2]}</td><td class="${h.result[t] < 0 ? 'neg' : ''}">${h.result[t] > 0 ? '+' : ''}${h.result[t]}</td>`).join('')}</tr>`).join('');
    $('tab-history').innerHTML = `<table class="hist"><tr><th>#</th><th colspan="2">${teamLabel(0)}</th><th colspan="2">${teamLabel(1)}</th></tr><tr class="sub-h"><th></th><th>bid/won</th><th>pts</th><th>bid/won</th><th>pts</th></tr>${rows || '<tr><td colspan="5" class="sub">No hands yet</td></tr>'}
      <tr class="tot"><td></td><td colspan="2">${s.scores[0]} (${s.bags[0]} bags)</td><td colspan="2">${s.scores[1]} (${s.bags[1]} bags)</td></tr></table>`;
  }

  // ---------- modals ----------
  function openModal(m) { modal = m; renderModal(); }
  function closeModal() { modal = null; $('modal').classList.add('hidden'); }
  function renderModal() {
    const s = state;
    let m = modal;
    if (s.phase === 'handOver') m = m && m.kind === 'hidden' ? m : { kind: 'hand' };
    else if (s.phase === 'over') m = m && m.kind === 'hidden' ? m : { kind: 'over' };
    else if (m && (m.kind === 'hand' || m.kind === 'over' || m.kind === 'hidden')) m = null;
    modal = m;
    if (!m || m.kind === 'hidden') { $('modal').classList.add('hidden'); return; }
    let html = '';
    const breakdown = () => s.handResult ? `<div class="breakdown">${[0, 1].map(t => `<div class="bd t${t}"><h4>${teamLabel(t)} <small>${teamNames(t)}</small></h4>
        ${s.handResult[t].lines.map(l => `<div>${esc(l)}</div>`).join('') || '<div class="sub">—</div>'}
        <div class="bd-total">${s.handResult[t].pts > 0 ? '+' : ''}${s.handResult[t].pts} → <b>${s.scores[t]}</b> <small>(${s.bags[t]} bags)</small></div></div>`).join('')}</div>` : '';
    if (m.kind === 'last' && s.lastTrick) {
      html = `<h3>Last trick</h3><div class="last">${s.lastTrick.cards.map(t => `<div><small>${nameAt(t.seat)}</small>${cardHtml(t.card, t.seat === s.lastTrick.winner ? 'winner' : '')}</div>`).join('')}</div>
        <p class="sub">${nameAt(s.lastTrick.winner)} won it.</p><button class="ghost" data-close>Close</button>`;
    } else if (m.kind === 'hand') {
      html = `<h3>Hand ${s.handNo} results</h3>${breakdown()}${s.mySeat >= 0 ? '<button class="primary" data-next>Next hand</button>' : ''}<button class="ghost" data-hide>View table</button>`;
    } else if (m.kind === 'over') {
      const host = s.hostId === s.you;
      html = `<h3 class="win-title">🏆 ${teamLabel(s.winnerTeam)} win!</h3><p class="sub center">${teamNames(s.winnerTeam)} — ${s.scores[s.winnerTeam]} to ${s.scores[1 - s.winnerTeam]}</p>${breakdown()}
        ${host ? '<button class="primary" data-new>New game</button>' : '<p class="sub center">Waiting for the host to start a new game…</p>'}<button class="ghost" data-hide>View table</button>`;
    }
    $('modal-card').innerHTML = html;
    $('modal').classList.remove('hidden');
  }
  $('modal-card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.close != null) closeModal();
    else if (d.hide != null) { modal = { kind: 'hidden' }; $('modal').classList.add('hidden'); }
    else if (d.next != null) act('next');
    else if (d.new != null) emit('start');
  });

  // ---------- effects ----------
  function splash(text, color, big) {
    const el = $('splash');
    el.innerHTML = `<span style="--sc:${color || '#fff'}">${text}</span>`;
    el.className = 'splash' + (big ? ' big' : '');
    void el.offsetWidth; el.classList.add('go');
  }
  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const cols = ['#f4d27a', '#ffffff', '#d0283a', '#1b1b1b', '#3fa06a'];
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
    if (fx.type === 'play') sounds.card();
    else if (fx.type === 'trick') sounds.trick();
    else if (fx.type === 'broken') { splash('♠ Spades broken!', '#f4d27a'); sounds.broken(); }
    else if (fx.type === 'bid' && (fx.bid === 'nil' || fx.bid === 'blind')) splash(`${nameAt(fx.seat)}: ${fx.bid === 'blind' ? 'BLIND NIL!' : 'NIL!'}`, '#f4d27a', fx.bid === 'blind');
    else if (fx.type === 'win') { sounds.win(); if (state.mySeat >= 0 && state.mySeat % 2 === fx.team) confetti(); }
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
    for (const t of ['log', 'chat', 'history', 'rules']) $('tab-' + t).classList.toggle('hidden', t !== tab);
    if (tab === 'chat') { unread = 0; badge(); $('chat-list').scrollTop = 1e9; }
  };
  function badge() { $('chat-badge').textContent = unread; $('chat-badge').classList.toggle('hidden', !unread); }
  function addChat(m) {
    const div = document.createElement('div');
    div.innerHTML = `<b style="color:${m.color}">${esc(m.name)}</b> ${esc(m.text)}`;
    $('chat-list').appendChild(div); $('chat-list').scrollTop = 1e9;
  }
  net.on('chatHistory', list => { $('chat-list').innerHTML = ''; list.forEach(addChat); });
  net.on('chat', m => { addChat(m); if (tab !== 'chat') { unread++; badge(); } });
  $('chat-form').onsubmit = e => { e.preventDefault(); const t = $('chat-input').value.trim(); if (t) emit('chat', t); $('chat-input').value = ''; };

  // ---------- timer ----------
  let timerEnd = null;
  function updateTimer() {
    const el = $('timer');
    if (!el) return;
    if (!timerEnd || !state) { el.textContent = ''; return; }
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
    const mine = (state.phase === 'bidding' || state.phase === 'playing') && state.turn === state.mySeat;
    $('status').innerHTML = `<span>${statusText()}</span><span id="timer"></span>`;
    $('status').classList.toggle('mine', mine);
    updateTimer();
    renderScoreboard();
    renderSeats();
    renderTrick();
    renderHand();
    renderBidBox();
    renderHistory();
    renderLog();
    renderModal();
  }

  net.on('state', s => {
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    state = s;
    const mine = (s.phase === 'bidding' || s.phase === 'playing') && s.turn === s.mySeat;
    const key = `${s.handNo}:${s.phase}:${s.counts ? s.counts.join() : ''}`;
    if (mine && key !== lastTurnKey) { sounds.turn(); if (document.hidden) document.title = '🔔 Your turn — Spades'; }
    lastTurnKey = mine ? key : null;
    render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Spades'; });
})();
