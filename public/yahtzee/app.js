// Yahtzee client: renders server state, animates the dice, sends actions. Rules live on the server.
(function () {
  const $ = id => document.getElementById(id);
  const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let playerId = store.get('yahtzee.pid');
  if (!playerId) { playerId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('yahtzee.pid', playerId); }
  $('name').value = store.get('yahtzee.name') || store.get('spades.name') || store.get('spin.name') || store.get('uno.name') || store.get('catan.name') || store.get('nh_name') || '';

  const net = new Net('/yahtzee/ws');
  window.__net = net;
  let state = null, modal = null, tab = 'log', unread = 0, lastLogId = 0, lastTurnKey = null;
  let rolling = null;          // { until, mask } while the dice tumble
  let flash = null;            // the box that was just scored
  let soundOn = store.get('yahtzee.sound') !== '0';

  const die = (v, cls = '') => `<div class="die ${cls}">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<i class="${PIPS[v].includes(i) ? 'p' : ''}"></i>`).join('')}</div>`;
  $('logo-dice').innerHTML = [5, 5, 5, 5, 5].map((v, i) => die(v, `d${i}`)).join('');

  // ---------- utils ----------
  function toast(msg, ok) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : '');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function emit(e, d, cb) { net.emit(e, d, res => { if (res && res.error) toast(res.error); if (cb) cb(res || {}); }); }
  function act(type, data, cb) { emit('action', { type, data }, cb); }
  function show(screen) { for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== screen); }
  const player = id => state.players.find(p => p.id === id);
  const nameOf = id => { const p = player(id); return p ? esc(p.name) : '?'; };
  const myTurn = () => state && state.phase === 'play' && state.current === state.you;

  // ---------- sound ----------
  let actx = null;
  function beep(freq, dur, type = 'sine', vol = 0.06, delay = 0) {
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
    roll() { for (let i = 0; i < 9; i++) beep(160 + Math.random() * 260, 0.04, 'square', 0.03, i * 0.06); },
    score() { beep(620, 0.08, 'triangle'); beep(930, 0.1, 'triangle', 0.05, 0.07); },
    turn() { beep(660, 0.12); beep(880, 0.16, 'sine', 0.06, 0.12); },
    yahtzee() { [523, 659, 784, 1046, 1318].forEach((f, i) => beep(f, 0.22, 'square', 0.05, i * 0.09)); },
    win() { [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.3, 'triangle', 0.08, i * 0.15)); },
  };

  // ---------- home & lobby ----------
  function myName() {
    const n = $('name').value.trim();
    if (!n) { toast('Enter your name first'); $('name').focus(); return null; }
    store.set('yahtzee.name', n);
    return n;
  }
  function enterRoom(code) { store.set('yahtzee.room', code); history.replaceState(null, '', '?room=' + code); }
  $('create').onclick = () => { const name = myName(); if (name) emit('create', { name, playerId, settings: { turnTime: 60 } }, r => { if (r.ok) enterRoom(r.code); }); };
  $('join').onclick = () => {
    const name = myName(); if (!name) return;
    const code = $('code').value.trim().toUpperCase();
    if (!code) return toast('Enter a game code');
    emit('join', { name, playerId, code }, r => { if (r.ok) enterRoom(r.code); });
  };
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  net.on('connect', () => {
    const url = new URLSearchParams(location.search).get('room');
    const code = (url || store.get('yahtzee.room') || '').toUpperCase();
    if (url) $('code').value = url.toUpperCase();
    const name = store.get('yahtzee.name');
    if (code && name) {
      net.emit('join', { name, playerId, code }, res => {
        if (res && res.ok) enterRoom(res.code);
        else { store.del('yahtzee.room'); if (url) toast(res.error || 'Could not join'); show('home'); }
      });
    }
  });
  net.on('disconnect', () => toast('Connection lost — reconnecting…'));

  function invite() {
    const link = location.origin + '/yahtzee/?room=' + state.code;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied', true), () => prompt('Copy this link:', link));
  }
  $('invite').onclick = invite; $('invite2').onclick = invite;
  $('add-bot').onclick = () => emit('addBot');
  $('lobby-players').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) emit('removeBot', b.dataset.remove); });
  $('lobby-time').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { turnTime: +b.dataset.time }); };
  $('start').onclick = () => emit('start');
  function leave() { emit('leave'); store.del('yahtzee.room'); history.replaceState(null, '', '/yahtzee/'); state = null; show('home'); }
  $('leave-lobby').onclick = leave;
  $('leave').onclick = () => { if (confirm('Leave this game?')) leave(); };
  $('sound').onclick = () => { soundOn = !soundOn; store.set('yahtzee.sound', soundOn ? '1' : '0'); $('sound').textContent = soundOn ? '🔊' : '🔇'; };
  $('sound').textContent = soundOn ? '🔊' : '🔇';

  function renderLobby() {
    const s = state, host = s.hostId === s.you;
    $('lobby-code').textContent = s.code;
    $('lobby-players').innerHTML = s.players.map(p => `<li><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span> ${esc(p.name)}
      ${p.bot ? '<em>bot</em>' : ''}${p.id === s.hostId ? ' <em>host</em>' : ''}${p.id === s.you ? ' <em>you</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}
      ${p.bot && host ? `<button class="small ghost" data-remove="${p.id}">Remove</button>` : ''}</li>`).join('');
    $('add-bot').classList.toggle('hidden', !host || s.players.length >= 8);
    for (const b of $('lobby-time').children) { b.classList.toggle('on', +b.dataset.time === s.settings.turnTime); b.disabled = !host; }
    $('lobby-note').textContent = host ? (s.players.length === 1 ? 'Start now to play solo, or invite friends / add bots.' : 'Ready when you are!') : 'Waiting for the host to start…';
    $('start').classList.toggle('hidden', !host);
  }

  // ---------- dice ----------
  function renderDice() {
    const s = state, el = $('dice');
    const now = Date.now();
    const anim = rolling && now < rolling.until;
    const canHold = myTurn() && s.rollsLeft > 0 && s.rollsLeft < 3;
    el.innerHTML = s.dice.map((v, i) => {
      const spinning = anim && rolling.mask[i];
      const face = spinning ? 1 + Math.floor(Math.random() * 6) : v;
      const cls = [s.held[i] ? 'held' : '', spinning ? 'rolling' : '', canHold ? 'can' : '', s.rollsLeft === 3 ? 'idle' : ''].join(' ');
      return `<button class="die-btn" data-i="${i}" ${canHold ? '' : 'tabindex="-1"'}>${die(face, cls)}${s.held[i] ? '<span class="tag">HELD</span>' : ''}</button>`;
    }).join('');
    if (anim) { clearTimeout(renderDice.t); renderDice.t = setTimeout(renderDice, 70); }
    const b = $('b-roll');
    const all = s.held.every(Boolean) && s.rollsLeft < 3;
    b.disabled = !myTurn() || !s.rollsLeft || all;
    b.textContent = !myTurn() ? `${nameOf(s.current)} is rolling…` : s.rollsLeft === 3 ? '🎲 Roll' : s.rollsLeft ? `🎲 Roll again (${s.rollsLeft} left)` : 'Pick a box →';
    $('hint').textContent = myTurn()
      ? (s.rollsLeft === 3 ? 'Roll the dice to start your turn.' : s.rollsLeft ? 'Click dice to hold them, then roll again, or score now.' : 'No rolls left: pick a box on your scorecard.')
      : '';
  }
  $('dice').addEventListener('click', e => {
    const b = e.target.closest('.die-btn'); if (!b || !state) return;
    if (!(myTurn() && state.rollsLeft > 0 && state.rollsLeft < 3)) return;
    act('hold', { index: +b.dataset.i });
  });
  $('b-roll').onclick = () => act('roll');

  // ---------- scorecard ----------
  function renderCard() {
    const s = state, ps = s.players;
    const cur = s.phase === 'play' ? s.current : null;
    const opts = s.options || {};
    const head = `<tr class="head"><th></th>${ps.map(p => `<th class="${p.id === cur ? 'cur' : ''}${p.id === s.you ? ' me' : ''}" style="--c:${p.color}"><span class="av">${esc(p.name[0].toUpperCase())}</span><div>${esc(p.name)}${p.bot ? ' <em>bot</em>' : ''}</div>${p.wins ? `<small>🏆${p.wins}</small>` : ''}</th>`).join('')}</tr>`;
    const cell = (p, cat) => {
      const v = p.card[cat];
      const isFlash = flash && flash.id === p.id && flash.cat === cat;
      if (v !== null) return `<td class="filled${v === 0 ? ' zero' : ''}${isFlash ? ' flash' : ''}">${v}</td>`;
      if (p.id === cur && cat in opts) {
        const mine = p.id === s.you;
        return `<td class="preview${opts[cat] ? '' : ' nil'}${mine ? ' pick' : ''}" ${mine ? `data-cat="${cat}"` : ''}>${opts[cat]}</td>`;
      }
      return `<td class="open"></td>`;
    };
    const row = (cat, cls = '') => `<tr class="${cls}"><th>${s.labels[cat]}</th>${ps.map(p => cell(p, cat)).join('')}</tr>`;
    const sumRow = (label, fn, cls) => `<tr class="${cls}"><th>${label}</th>${ps.map(p => `<td>${fn(p)}</td>`).join('')}</tr>`;
    $('scorecard').innerHTML = head
      + s.upperCats.map(c => row(c)).join('')
      + sumRow('Upper sum', p => p.totals.upper, 'sum')
      + sumRow('Bonus <small>(63+ → 35)</small>', p => (p.totals.bonus ? '<b class="got">+35</b>' : `<span class="need">${p.totals.upper}/63</span>`), 'sum')
      + s.lowerCats.map(c => row(c, c === 'yahtzee' ? 'yrow' : '')).join('')
      + sumRow('Yahtzee bonus', p => (p.yBonus ? `<b class="got">+${p.yBonus * 100}</b>` : ''), 'sum')
      + sumRow('TOTAL', p => `<b>${p.totals.total}</b>`, 'total');
  }
  $('scorecard').addEventListener('click', e => {
    const td = e.target.closest('td[data-cat]'); if (!td || !myTurn()) return;
    const cat = td.dataset.cat, pts = state.options[cat];
    if (pts === 0 && Object.values(state.options).some(v => v > 0) && !confirm(`Score 0 in ${state.labels[cat]}?`)) return;
    act('score', { cat });
  });

  function statusText() {
    const s = state;
    if (s.phase === 'over') return `🏆 ${s.winners.map(nameOf).join(' & ')} win${s.winners.length > 1 ? '' : 's'}!`;
    if (s.joker && s.joker.joker && myTurn()) return '🎉 Bonus YAHTZEE! Joker rules apply';
    return myTurn() ? 'Your turn' : `${nameOf(s.current)}'s turn`;
  }

  // ---------- modals ----------
  function renderModal() {
    const s = state;
    let m = modal;
    if (s.phase === 'over') m = m && m.kind === 'hidden' ? m : { kind: 'over' };
    else m = null;
    modal = m;
    if (!m || m.kind === 'hidden') { $('modal').classList.add('hidden'); return; }
    const ranked = s.players.slice().sort((a, b) => b.totals.total - a.totals.total);
    const host = s.hostId === s.you;
    $('modal-card').innerHTML = `<h3 class="win-title">🏆 ${s.winners.map(nameOf).join(' & ')} win${s.winners.length > 1 ? '' : 's'}!</h3>
      <table class="final">${ranked.map((p, i) => `<tr class="${s.winners.includes(p.id) ? 'top' : ''}"><td>${i + 1}.</td><td><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}</td>
        <td><small>upper ${p.totals.upper}${p.totals.bonus ? ' +35' : ''} · lower ${p.totals.lower}${p.yBonus ? ` · +${p.yBonus * 100}` : ''}</small></td><td><b>${p.totals.total}</b></td></tr>`).join('')}</table>
      ${host ? '<button class="primary" data-again>Play again</button>' : '<p class="sub">Waiting for the host to start another game…</p>'}
      <button class="ghost" data-hide>View scorecard</button>`;
    $('modal').classList.remove('hidden');
  }
  $('modal-card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.again != null) emit('start');
    else if (b.dataset.hide != null) { modal = { kind: 'hidden' }; $('modal').classList.add('hidden'); }
  });

  // ---------- effects ----------
  function splash(text, big) {
    const el = $('splash');
    el.innerHTML = `<span>${text}</span>`;
    el.className = 'splash' + (big ? ' big' : '');
    void el.offsetWidth; el.classList.add('go');
  }
  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const cols = ['#e63946', '#ffd166', '#06d6a0', '#118ab2', '#ffffff'];
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
    if (fx.type === 'roll') {
      sounds.roll();
      rolling = { until: Date.now() + 650, mask: fx.held.map(h => !h) };
      setTimeout(() => { rolling = null; if (state) renderDice(); }, 680);
    } else if (fx.type === 'yahtzee') {
      setTimeout(() => { splash('YAHTZEE!', true); sounds.yahtzee(); confetti(); }, 700);
    } else if (fx.type === 'score') {
      sounds.score();
      flash = { id: fx.id, cat: fx.cat };
      setTimeout(() => { flash = null; }, 1500);
      if (fx.cat !== 'yahtzee' && fx.points >= 30) splash(`${state.labels[fx.cat]} +${fx.points}`);
    } else if (fx.type === 'win') { sounds.win(); if (fx.ids.includes(state.you)) confetti(); }
  });

  // ---------- log, chat, tabs ----------
  function renderLog() {
    const el = $('tab-log'), log = state.log || [];
    el.innerHTML = log.map(l => `<div>${esc(l.text)}</div>`).join('');
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
    if (!timerEnd || !state || state.phase !== 'play') { el.textContent = ''; return; }
    const secs = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    el.textContent = `⏱ ${secs}s`;
    el.className = secs <= 10 ? 'low' : '';
  }
  setInterval(updateTimer, 250);

  // ---------- main render ----------
  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
    show('game');
    $('room-code').textContent = state.code;
    $('round').textContent = state.phase === 'play' ? `Round ${state.round} of 13` : 'Game over';
    $('status').innerHTML = `<span>${statusText()}</span><span id="timer"></span>`;
    $('status').classList.toggle('mine', myTurn());
    updateTimer();
    renderDice();
    renderCard();
    renderLog();
    renderModal();
  }

  net.on('state', s => {
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    state = s;
    const key = `${s.games}:${s.turnSeq}`;
    if (myTurn() && key !== lastTurnKey) { sounds.turn(); if (document.hidden) document.title = '🔔 Your turn — Yahtzee'; }
    lastTurnKey = myTurn() ? key : null;
    render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Yahtzee'; });
  // keyboard: space rolls, 1–5 hold dice
  document.addEventListener('keydown', e => {
    if (!state || state.phase !== 'play' || e.target.tagName === 'INPUT') return;
    if (e.key === ' ' && !$('b-roll').disabled) { e.preventDefault(); act('roll'); }
    else if (/^[1-5]$/.test(e.key) && myTurn() && state.rollsLeft > 0 && state.rollsLeft < 3) act('hold', { index: +e.key - 1 });
  });
})();
