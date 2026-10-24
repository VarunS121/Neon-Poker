// UNO Spin client: renders server state, animates the wheel, sends actions. Rules live on the server.
(function () {
  const $ = id => document.getElementById(id);
  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const SYM = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '', wild4: '+4' };
  const ORDER = { red: 0, yellow: 1, green: 2, blue: 3, null: 4 };
  // wheel wedge colors and short labels
  const SPACE = {
    unoSpin: ['#ffcc33', 'UNO|SPIN'], discardColor: ['#22a447', 'DISCARD|COLOR'], drawBlue: ['#1f6fd6', 'DRAW|BLUE'], drawRed: ['#e8262f', 'DRAW|RED'],
    war: ['#ff7a1a', 'WAR'], discardNumber: ['#8a3ffc', 'DISCARD|NUMBER'], showHand: ['#14b8a6', 'SHOW|HAND'], tradeHands: ['#ec4899', 'TRADE|HANDS'],
    almostUno: ['#a3e635', 'ALMOST|UNO'], 'colorDraw:red': ['#e8262f', 'RED|DRAW'], twoX: ['#151515', '2X'], 'colorDraw:blue': ['#1f6fd6', 'BLUE|DRAW'],
    colorDiscard: ['#8a3ffc', 'COLOR|DISCARD'], 'colorDraw:green': ['#22a447', 'GREEN|DRAW'], swapHands: ['#ec4899', 'SWAP|HANDS'],
    'colorDraw:yellow': ['#f6c21a', 'YELLOW|DRAW'], wildColorDraw: ['#3a3a48', 'WILD|DRAW'],
  };
  const DISCARD_MODES = ['almostUno', 'discardNumber', 'discardColor', 'unoSpin'];
  const RULES = {
    classic: `<p><b>Classic wheel (2005).</b> Play a Spin card and the <b>next player spins</b> instead of taking their turn.</p>
      <p><b>Almost UNO:</b> discard down to 2 cards. <b>Discard Number / Color:</b> pick a number or color and discard as many of those as you like.
      <b>Draw Red / Blue:</b> draw until that color or a wild. <b>Show Hand:</b> everyone sees your cards.
      <b>War:</b> everyone reveals their highest number; the highest is played (ties go to the next card). <b>UNO Spin:</b> race to hit the button, and the winner discards any one card.
      <b>Trade Hands:</b> everyone passes their hand to the left.</p>`,
    new: `<p><b>New wheel (2025).</b> Play a Spin card and <b>you spin</b>.</p>
      <p><b>Color Draw:</b> draw until that color comes up. <b>Wild Color Draw:</b> name a color, then draw until it comes up. <b>Color Discard:</b> name a color and discard all of it.
      <b>Swap Hands:</b> trade hands with anyone. <b>2X:</b> everyone may play two cards a turn until someone spins.</p>`,
    common: `<p><b>Match</b> color, number or symbol. Wilds go on anything. Can't or won't play? Draw one, and play it if you can.</p>
      <p><b>Wild Draw Four</b> is only legal with no card of the current color. The next player can accept (+4) or challenge: if you were bluffing you draw 4; if not, they draw 6.</p>
      <p><b>UNO!</b> Call it at one card or get caught for +2. The round winner scores everyone else's cards (numbers face value, actions 20, wilds 50).</p>`,
  };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let playerId = store.get('spin.pid');
  if (!playerId) { playerId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('spin.pid', playerId); }
  $('name').value = store.get('spin.name') || store.get('uno.name') || store.get('catan.name') || store.get('nh_name') || '';

  const net = new Net('/spin/ws');
  window.__net = net;
  let state = null, modal = null, tab = 'log', unread = 0, lastLogId = 0;
  let prevTop = null, prevHand = null, lastTurnKey = null;
  let selected = [];          // card ids picked for a wheel discard, in order
  let wheelRot = 0, wheelSpaces = '';
  let soundOn = store.get('spin.sound') !== '0';

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
  const myTurn = () => state && state.current === state.you && !state.spectator;
  const myPick = () => state.phase === 'pick' && state.pick && state.pick.player === state.you;

  function cardHtml(c, cls = '') {
    const s = c.type === 'number' ? c.value : SYM[c.type];
    const cap = c.spin ? 'SPIN' : c.type === 'wild' ? 'WILD' : c.type === 'skip' ? 'SKIP' : c.type === 'reverse' ? 'REVERSE' : '';
    const u = c.type === 'number' && (c.value === 6 || c.value === 9) ? ' u' : '';
    const len = String(s).length > 1 ? ' mid' : '';
    return `<div class="ucard c-${c.color || 'wild'} t-${c.type}${c.spin ? ' spin' : ''} ${cls}" data-id="${c.id}">
      <span class="corner tl${u}">${s || '★'}</span><div class="oval"><span class="big${u}${len}">${s}</span>${cap ? `<span class="cap">${cap}</span>` : ''}</div><span class="corner br${u}">${s || '★'}</span></div>`;
  }

  // ---------- the wheel ----------
  function wheelSvg(spaces, r = 100, labels = true) {
    const step = 360 / spaces.length, rad = d => (d * Math.PI) / 180;
    const pt = (d, rr) => `${(rr * Math.sin(rad(d))).toFixed(2)},${(-rr * Math.cos(rad(d))).toFixed(2)}`;
    return spaces.map((sp, i) => {
      const [col, label] = SPACE[sp];
      const a0 = i * step - step / 2, a1 = i * step + step / 2;
      const lines = label.split('|');
      const dark = sp === 'unoSpin' || sp === 'almostUno' || sp === 'colorDraw:yellow';
      return `<path d="M0,0 L${pt(a0, r)} A${r},${r} 0 0 1 ${pt(a1, r)} Z" fill="${col}" stroke="#fff" stroke-width="2"/>`
        + (labels ? `<g transform="rotate(${i * step})"><text y="${-r * 0.62}" class="wl${dark ? ' dark' : ''}">${lines.map((l, k) => `<tspan x="0" dy="${k ? 11 : -(lines.length - 1) * 5.5}">${l}</tspan>`).join('')}</text></g>` : '');
    }).join('') + `<circle r="${r}" fill="none" stroke="#fff" stroke-width="5"/>`;
  }
  // logo wheel on the home screen
  document.querySelector('.logo-wheel').innerHTML = `<g class="logo-rot">${wheelSvg(['drawRed', 'unoSpin', 'drawBlue', 'discardColor', 'war', 'discardNumber', 'showHand', 'tradeHands'], 46, false)}</g><circle r="8" fill="#fff"/>`;

  function ensureWheel() {
    const key = state.wheel.join();
    if (key !== wheelSpaces) { $('wheel-rot').innerHTML = wheelSvg(state.wheel); wheelSpaces = key; }
  }
  function spinWheelTo(index, animate) {
    const step = 360 / state.wheel.length;
    const target = -index * step;
    const delta = (((target - wheelRot) % 360) + 360) % 360;
    wheelRot += delta + (animate ? 360 * 5 : 0);
    const g = $('wheel-rot');
    g.style.transition = animate ? 'transform 2.6s cubic-bezier(.12,.75,.2,1)' : 'none';
    g.style.transform = `rotate(${wheelRot}deg)`;
  }

  function renderWheel() {
    const s = state, stage = $('wheel-stage');
    const active = !!s.spin && ['spin', 'spinning', 'race', 'pick'].includes(s.phase);
    stage.classList.toggle('hidden', !active);
    $('b-race').classList.toggle('hidden', !(s.phase === 'race' && !s.spectator));
    if (!active) return;
    ensureWheel();
    const spinner = s.spin.spinner;
    $('b-spin').classList.toggle('hidden', !(s.phase === 'spin' && spinner === s.you));
    const res = $('wheel-result');
    if (s.phase === 'spin') res.innerHTML = spinner === s.you ? 'Your spin!' : `${nameOf(spinner)} is about to spin…`;
    else if (s.phase === 'spinning') res.innerHTML = '…';
    else res.innerHTML = `<b>${esc(s.spaceNames[s.spin.space] || '')}</b>`;
    if (s.spin.index != null && s.phase !== 'spinning' && !spinWheelTo.animating) spinWheelTo(s.spin.index, false);
  }
  $('b-spin').onclick = () => act('spin');
  $('b-race').onclick = () => act('unoSpin');

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
    play() { beep(520, 0.07, 'triangle'); beep(780, 0.08, 'triangle', 0.05, 0.05); },
    draw(n) { for (let i = 0; i < Math.min(n, 8); i++) beep(300 - i * 15, 0.05, 'square', 0.03, i * 0.05); },
    turn() { beep(660, 0.12); beep(990, 0.18, 'sine', 0.07, 0.12); },
    spin() { for (let i = 0; i < 26; i++) beep(900, 0.02, 'square', 0.025, Math.pow(i / 26, 1.8) * 2.5); },
    big() { beep(140, 0.35, 'sawtooth', 0.06); },
    uno() { [880, 1175, 1568].forEach((f, i) => beep(f, 0.12, 'square', 0.05, i * 0.08)); },
    win() { [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.3, 'triangle', 0.08, i * 0.15)); },
  };

  // ---------- home & lobby ----------
  function myName() {
    const n = $('name').value.trim();
    if (!n) { toast('Enter your name first'); $('name').focus(); return null; }
    store.set('spin.name', n);
    return n;
  }
  function enterRoom(code) { store.set('spin.room', code); history.replaceState(null, '', '?room=' + code); }
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
    const code = (url || store.get('spin.room') || '').toUpperCase();
    if (url) $('code').value = url.toUpperCase();
    const name = store.get('spin.name');
    if (code && name) {
      net.emit('join', { name, playerId, code }, res => {
        if (res && res.ok) enterRoom(res.code);
        else { store.del('spin.room'); if (url) toast(res.error || 'Could not join'); show('home'); }
      });
    }
  });
  net.on('disconnect', () => toast('Connection lost — reconnecting…'));

  function invite() {
    const link = location.origin + '/spin/?room=' + state.code;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied', true), () => prompt('Copy this link:', link));
  }
  $('invite').onclick = invite; $('invite2').onclick = invite;
  $('lobby-edition').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { edition: b.dataset.ed }); };
  $('lobby-target').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { target: +b.dataset.t }); };
  $('lobby-time').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { turnTime: +b.dataset.time }); };
  $('start').onclick = () => emit('start');
  function leave() { emit('leave'); store.del('spin.room'); history.replaceState(null, '', '/spin/'); state = null; show('home'); }
  $('leave-lobby').onclick = leave;
  $('leave').onclick = () => { if (confirm('Leave this game?')) leave(); };
  $('sound').onclick = () => { soundOn = !soundOn; store.set('spin.sound', soundOn ? '1' : '0'); $('sound').textContent = soundOn ? '🔊' : '🔇'; };
  $('sound').textContent = soundOn ? '🔊' : '🔇';

  function renderLobby() {
    const s = state, host = s.hostId === s.you;
    $('lobby-code').textContent = s.code;
    $('lobby-players').innerHTML = s.players.map(p => `<li><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span> ${esc(p.name)}${p.id === s.hostId ? ' <em>host</em>' : ''}${p.id === s.you ? ' <em>you</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}</li>`).join('');
    const seg = (id, attr, val) => { for (const b of $(id).children) { b.classList.toggle('on', b.dataset[attr] === String(val)); b.disabled = !host; } };
    seg('lobby-edition', 'ed', s.settings.edition);
    seg('lobby-target', 't', s.settings.target);
    seg('lobby-time', 'time', s.settings.turnTime);
    $('edition-note').innerHTML = s.settings.edition === 'classic'
      ? '9 spaces: Almost UNO, Discard Number, Discard Color, Draw Red, Draw Blue, Show Hand, War, UNO Spin, Trade Hands. The next player spins.'
      : '8 slots: four Color Draws, Wild Color Draw, Color Discard, Swap Hands and 2X. Whoever played the Spin card spins.';
    const n = s.players.length;
    $('lobby-note').textContent = n < 2 ? 'Waiting for players… (2–10)' : host ? 'Ready when you are! Share the invite link.' : 'Waiting for the host to start…';
    $('start').classList.toggle('hidden', !host);
    $('start').disabled = n < 2;
  }

  // ---------- table ----------
  function seatOrder() {
    const ps = state.players, i = ps.findIndex(p => p.id === state.you);
    return i < 0 ? ps : ps.slice(i + 1).concat(ps.slice(0, i));
  }
  function renderOpponents() {
    const s = state, pending = new Set(s.unoPending || []);
    $('opponents').innerHTML = seatOrder().map(p => {
      const turn = (p.id === s.current && ['play', 'second'].includes(s.phase)) || (s.spin && s.spin.spinner === p.id && ['spin', 'spinning'].includes(s.phase))
        || (s.pick && s.pick.player === p.id) || (s.challenge && s.challenge.target === p.id);
      const backs = Math.min(p.cards, 12);
      const canCatch = pending.has(p.id) && !s.spectator;
      return `<div class="opp${turn ? ' turn' : ''}${p.connected ? '' : ' off'}${p.id === s.winner ? ' won' : ''}" style="--c:${p.color}">
        <div class="opp-top"><span class="av">${esc(p.name[0].toUpperCase())}</span><b>${esc(p.name)}</b><span class="pts" title="Points">${p.score}</span></div>
        <div class="fan">${Array.from({ length: backs }, (_, k) => `<i style="--k:${k - (backs - 1) / 2}"></i>`).join('')}</div>
        <div class="opp-count">${p.cards} card${p.cards === 1 ? '' : 's'}</div>
        ${canCatch ? `<button class="catch" data-catch="${p.id}">Catch! +2</button>` : ''}
        ${!canCatch && p.cards === 1 ? '<span class="uno-tag">UNO</span>' : ''}
        ${s.shown && s.shown.id === p.id ? '<span class="eye" title="Showing their hand">👀</span>' : ''}
      </div>`;
    }).join('');
  }
  $('opponents').addEventListener('click', e => { const b = e.target.closest('[data-catch]'); if (b) act('catch', { target: b.dataset.catch }); });

  function renderCenter() {
    const s = state, top = s.top;
    const fresh = prevTop !== null && prevTop !== top.id;
    $('discard').innerHTML = cardHtml(top, fresh ? 'slam' : '');
    $('discard').style.setProperty('--cur', `var(--${s.color})`);
    prevTop = top.id;
    $('deck-count').textContent = s.deckCount;
    $('dir').classList.toggle('ccw', s.direction === -1);
    $('dir').style.color = `var(--${s.color})`;
    const canDraw = myTurn() && s.phase === 'play' && s.drawn == null;
    $('deck').disabled = !canDraw;
    $('deck').classList.toggle('glow', canDraw && !s.playable.length);
    $('badges').innerHTML = s.twoX ? '<span class="twox">2X</span>' : '';
  }
  $('deck').onclick = () => { if (myTurn() && state.phase === 'play' && state.drawn == null) act('draw'); };

  function renderHand() {
    const s = state, el = $('hand');
    if (s.spectator) { el.innerHTML = '<p class="sub">You are watching this round.</p>'; return; }
    const hand = (s.hand || []).slice().sort((a, b) => ORDER[a.color] - ORDER[b.color] || (a.type === 'number' ? a.value : 20) - (b.type === 'number' ? b.value : 20) || a.type.localeCompare(b.type));
    const picking = myPick() && DISCARD_MODES.includes(s.pick.mode);
    if (!picking) selected = [];
    selected = selected.filter(id => hand.some(c => c.id === id));
    const playable = new Set(s.playable);
    const mine = myTurn() && (s.phase === 'play' || s.phase === 'second');
    const seen = prevHand && prevHand.round === s.round ? prevHand.ids : null;
    el.innerHTML = hand.map(c => {
      const order = selected.indexOf(c.id);
      return cardHtml(c, [mine && playable.has(c.id) ? 'ok' : '', mine && !playable.has(c.id) ? 'dim' : '', picking ? 'pickable' : '', order >= 0 ? 'sel' : '',
        seen && !seen.has(c.id) ? 'new' : '', s.drawn === c.id ? 'drawn' : ''].join(' '));
    }).join('');
    // order badges sit on top of each selected card
    if (picking) for (const node of el.querySelectorAll('.ucard.sel')) node.insertAdjacentHTML('beforeend', `<b class="order">${selected.indexOf(+node.dataset.id) + 1}</b>`);
    prevHand = { round: s.round, ids: new Set(hand.map(c => c.id)) };
    fitHand();
  }
  function fitHand() {
    const el = $('hand'), n = el.children.length;
    if (!n) return;
    const w = el.clientWidth - 16, cw = el.children[0].offsetWidth || 80;
    el.style.setProperty('--ov', (n > 1 ? Math.min(cw - 22, Math.max(0, (n * cw - w) / (n - 1))) : 0) + 'px');
  }
  window.addEventListener('resize', () => state && state.phase !== 'lobby' && fitHand());

  $('hand').addEventListener('click', e => {
    const el = e.target.closest('.ucard'); if (!el || !state) return;
    const card = state.hand.find(c => c.id === +el.dataset.id);
    if (!card) return;
    if (myPick() && DISCARD_MODES.includes(state.pick.mode)) {
      const i = selected.indexOf(card.id);
      if (i >= 0) selected.splice(i, 1);
      else if (state.pick.mode === 'unoSpin') selected = [card.id];
      else selected.push(card.id);
      renderHand(); renderControls();
      return;
    }
    if (!state.playable.includes(card.id)) {
      if (myTurn() && (state.phase === 'play' || state.phase === 'second')) toast(state.drawn != null ? 'Play the card you drew, or pass' : "That card doesn't match");
      return;
    }
    if (card.type === 'wild' || card.type === 'wild4') return openModal({ kind: 'color', card });
    act('play', { cardId: card.id });
  });

  function discardLabel() {
    const m = state.pick.mode, n = selected.length;
    if (m === 'almostUno') return `Discard ${n}/${state.hand.length - 2}`;
    if (m === 'unoSpin') return n ? 'Discard it' : 'Pick a card';
    return n ? `Discard ${n}` : 'Keep them all';
  }
  function sendDiscard(color) { act('discard', { cards: selected, color }, r => { if (r.ok) selected = []; }); }
  $('b-discard').onclick = () => {
    const last = state.hand.find(c => c.id === selected[selected.length - 1]);
    if (last && (last.type === 'wild' || last.type === 'wild4')) return openModal({ kind: 'discardColor' });
    sendDiscard();
  };

  function renderControls() {
    const s = state;
    const inRound = ['play', 'second', 'spin', 'spinning', 'race', 'pick', 'challenge'].includes(s.phase) && !s.spectator;
    $('b-uno').disabled = !inRound || !s.hand || s.hand.length > 2 || s.saidUno;
    $('b-uno').classList.toggle('urgent', (s.unoPending || []).includes(s.you));
    const picking = myPick() && DISCARD_MODES.includes(s.pick.mode);
    $('b-discard').classList.toggle('hidden', !picking);
    if (picking) { $('b-discard').textContent = discardLabel(); $('b-discard').disabled = s.pick.mode === 'unoSpin' && !selected.length; }
    $('b-draw').classList.toggle('hidden', picking);
    $('b-pass').classList.toggle('hidden', picking);
    $('b-draw').disabled = !(myTurn() && s.phase === 'play' && s.drawn == null);
    $('b-pass').disabled = !(myTurn() && (s.drawn != null || s.phase === 'second'));
    $('b-pass').textContent = s.phase === 'second' && myTurn() ? 'Done' : 'Pass';
    $('my-count').textContent = s.hand ? `${s.hand.length} card${s.hand.length === 1 ? '' : 's'}` : '';
  }
  $('b-uno').onclick = () => act('uno');
  $('b-draw').onclick = () => act('draw');
  $('b-pass').onclick = () => act('pass');

  function statusText() {
    const s = state, cur = nameOf(s.current);
    if (s.phase === 'roundOver' || s.phase === 'over') return `🏆 ${nameOf(s.winner)} wins the round (+${s.roundPoints})!`;
    if (s.phase === 'challenge') return s.challenge.target === s.you ? 'Wild Draw Four! Accept or challenge?' : `${nameOf(s.challenge.target)} is deciding whether to challenge…`;
    if (s.phase === 'spin') return s.spin.spinner === s.you ? '🌀 Spin the wheel!' : `🌀 ${nameOf(s.spin.spinner)} must spin…`;
    if (s.phase === 'spinning') return '🌀 Spinning…';
    if (s.phase === 'race') return '⚡ RACE! First to hit UNO SPIN! discards any card';
    if (s.phase === 'pick') {
      const m = s.pick.mode, mine = s.pick.player === s.you, who = nameOf(s.pick.player);
      const what = {
        almostUno: 'discard down to 2 cards (last one goes on top)', discardNumber: 'pick a number and discard any of those cards', discardColor: 'pick a color and discard any of those cards',
        unoSpin: 'discard any one card', wildColorDraw: 'name a color to draw until', colorDiscard: 'name a color to discard', swapHands: 'choose who to swap hands with',
      }[m];
      return mine ? `Your move: ${what}` : `${who} must ${what}…`;
    }
    if (!myTurn()) return `${cur}'s turn`;
    if (s.phase === 'second') return '2X — play a second card on top, or press Done';
    if (s.drawn != null) return 'Play the card you drew, or pass';
    return s.playable.length ? 'Your turn — play a card (or draw)' : 'Nothing to play — draw a card';
  }

  function renderShown() {
    const s = state, el = $('shown');
    if (!s.shown || s.shown.id === s.you || s.spectator && !s.shown) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<div class="shown-title">👀 ${nameOf(s.shown.id)}'s hand</div><div class="shown-cards">${s.shown.cards.map(c => cardHtml(c, 'tiny')).join('')}</div>`;
  }

  function renderScores() {
    const s = state;
    const ranked = s.players.slice().sort((a, b) => b.score - a.score);
    $('tab-scores').innerHTML = `<table class="scores">${ranked.map(p => `<tr><td><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}</td><td><b>${p.score}</b></td><td><div class="bar"><i style="width:${Math.min(100, (p.score / s.settings.target) * 100)}%"></i></div></td></tr>`).join('')}</table>
      <p class="sub">First to ${s.settings.target} points wins. Round ${s.round}.</p>`;
    $('round-info').textContent = `Round ${s.round} · to ${s.settings.target}`;
    $('tab-rules').innerHTML = RULES[s.settings.edition] + RULES.common;
  }

  // ---------- modals ----------
  function openModal(m) { modal = m; renderModal(); }
  function closeModal() { modal = null; $('modal').classList.add('hidden'); }
  function renderModal() {
    const s = state;
    let m = modal;
    // modals the game demands take priority
    if (s.phase === 'challenge' && s.challenge.target === s.you) m = { kind: 'challenge' };
    else if (myPick() && (s.pick.mode === 'wildColorDraw' || s.pick.mode === 'colorDiscard')) m = { kind: 'pickColor' };
    else if (myPick() && s.pick.mode === 'swapHands') m = { kind: 'swap' };
    else if (s.phase === 'roundOver' || s.phase === 'over') m = m && m.kind === 'hidden' ? m : { kind: 'over' };
    else if (m && ['challenge', 'pickColor', 'swap', 'over', 'hidden'].includes(m.kind)) m = null;
    else if (m && m.kind === 'discardColor' && !myPick()) m = null;
    modal = m;
    if (!m || m.kind === 'hidden') { $('modal').classList.add('hidden'); return; }
    const colorButtons = COLORS.map(c => `<button class="pick c-${c}" data-color="${c}">${c}</button>`).join('');
    let html = '';
    if (m.kind === 'color') html = `<h3>Choose a color</h3>${cardHtml(m.card, 'preview')}<div class="colors">${colorButtons}</div><button class="ghost" data-cancel>Cancel</button>`;
    else if (m.kind === 'discardColor') html = `<h3>Your wild goes on top — choose a color</h3><div class="colors">${colorButtons}</div><button class="ghost" data-cancel>Cancel</button>`;
    else if (m.kind === 'pickColor') html = `<h3>${s.pick.mode === 'wildColorDraw' ? 'Wild Color Draw' : 'Color Discard'}</h3><p class="sub">${s.pick.mode === 'wildColorDraw' ? 'Name a color. You draw until it comes up.' : 'Name a color. Every card of that color in your hand is discarded.'}</p><div class="colors">${colorButtons}</div>`;
    else if (m.kind === 'swap') html = `<h3>🔁 Swap hands with…</h3><div class="targets">${s.players.filter(p => p.id !== s.you).map(p => `<button data-target="${p.id}"><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}<small>${p.cards} card${p.cards === 1 ? '' : 's'}</small></button>`).join('')}</div>`;
    else if (m.kind === 'challenge') html = `<h3>${nameOf(s.challenge.by)} played a Wild Draw Four!</h3><p class="sub">Think they had a card of the previous color? If you challenge and you're right, they draw 4. If you're wrong, you draw 6.</p>
      <div class="colors"><button class="primary" data-accept>Accept (+4)</button><button data-challenge>Challenge!</button></div>`;
    else if (m.kind === 'over') {
      const ranked = s.players.slice().sort((a, b) => b.score - a.score);
      const host = s.hostId === s.you, over = s.phase === 'over';
      html = `<h3 class="win-title">${over ? `🏆 ${nameOf(s.champion)} wins the game!` : `${nameOf(s.winner)} wins the round! +${s.roundPoints}`}</h3>
        <table class="scores">${ranked.map(p => `<tr class="${p.id === s.winner ? 'top' : ''}"><td><span class="av" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}</td><td>${(s.hands[p.id] || []).length} left</td><td><b>${p.score}</b> / ${s.settings.target}</td></tr>`).join('')}</table>
        ${host ? `<button class="primary" data-next>${over ? 'New game' : 'Next round'}</button>` : `<p class="sub">Waiting for the host to start the ${over ? 'next game' : 'next round'}…</p>`}
        <button class="ghost" data-hide>View table</button>`;
    }
    $('modal-card').innerHTML = html;
    $('modal').classList.remove('hidden');
  }
  $('modal-card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.cancel != null) closeModal();
    else if (d.hide != null) { modal = { kind: 'hidden' }; $('modal').classList.add('hidden'); }
    else if (d.next != null) emit('start');
    else if (d.accept != null) act('challenge', { challenge: false });
    else if (d.challenge != null) act('challenge', { challenge: true });
    else if (d.target) act('swap', { target: d.target });
    else if (d.color) {
      if (modal.kind === 'color') act('play', { cardId: modal.card.id, color: d.color });
      else if (modal.kind === 'discardColor') sendDiscard(d.color);
      else if (modal.kind === 'pickColor') act('chooseColor', { color: d.color });
      closeModal();
    }
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
    const cols = ['#e8262f', '#f6c21a', '#22a447', '#1f6fd6', '#fff', '#ec4899'];
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
    if (fx.type === 'play') {
      sounds.play();
      const c = fx.card, col = `var(--${c.color || state.color})`;
      if (c.type === 'draw2') splash('+2', col); else if (c.type === 'wild4') { splash('+4?', '#fff', true); sounds.big(); }
      else if (c.type === 'skip') splash('SKIP!', col); else if (c.type === 'reverse') splash('REVERSE!', col);
      else if (c.spin) splash('🌀 SPIN!', col, true);
    } else if (fx.type === 'spin') {
      // make sure the wheel matches this edition, then animate it onto the result
      if (state.wheel.length !== (fx.edition === 'new' ? 8 : 9)) return;
      $('wheel-stage').classList.remove('hidden');
      ensureWheel();
      spinWheelTo.animating = true;
      spinWheelTo(fx.index, true);
      sounds.spin();
      setTimeout(() => { spinWheelTo.animating = false; splash(esc(state.spaceNames[fx.space]) + '!', SPACE[fx.space][0] === '#151515' ? '#fff' : SPACE[fx.space][0], true); }, 2650);
    } else if (fx.type === 'draw') { sounds.draw(fx.n); if (fx.n >= 4) splash(`${nameOf(fx.id)} +${fx.n}`, '#ff4d4d', fx.n >= 8); }
    else if (fx.type === 'uno') { splash(`${nameOf(fx.id)}: UNO!`, '#f6c21a', true); sounds.uno(); }
    else if (fx.type === 'caught') { splash(`CAUGHT! ${nameOf(fx.id)} +2`, '#ff4d4d'); sounds.big(); }
    else if (fx.type === 'unoSpin') { splash(`⚡ ${nameOf(fx.id)} wins the race!`, '#ffcc33', true); sounds.uno(); }
    else if (fx.type === 'war') splash(`⚔️ ${nameOf(fx.id)} wins the war`, '#ff7a1a');
    else if (fx.type === 'trade') splash('🔄 TRADE HANDS!', '#ec4899', true);
    else if (fx.type === 'swap') splash('🔁 SWAP!', '#ec4899');
    else if (fx.type === 'challenge') splash(fx.won ? 'CHALLENGE WON!' : 'CHALLENGE FAILED!', fx.won ? '#2fd17a' : '#ff4d4d', true);
    else if (fx.type === 'win') { sounds.win(); if (fx.game) confetti(); }
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
    for (const t of ['log', 'chat', 'scores', 'rules']) $('tab-' + t).classList.toggle('hidden', t !== tab);
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
    if (!timerEnd || !state || state.phase === 'spinning') { el.textContent = ''; return; }
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
    const waitingOnMe = myTurn() && ['play', 'second'].includes(state.phase) || myPick() || (state.spin && state.spin.spinner === state.you && state.phase === 'spin')
      || (state.challenge && state.challenge.target === state.you) || state.phase === 'race';
    $('status').innerHTML = `<span>${statusText()}</span><span id="timer"></span>`;
    $('status').classList.toggle('mine', !!waitingOnMe && !state.spectator);
    updateTimer();
    renderOpponents();
    renderCenter();
    renderHand();
    renderControls();
    renderWheel();
    renderShown();
    renderScores();
    renderLog();
    renderModal();
  }

  net.on('state', s => {
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    state = s;
    if (s.phase === 'lobby') { prevTop = null; prevHand = null; }
    const mine = (s.current === s.you && ['play', 'second'].includes(s.phase)) || (s.spin && s.spin.spinner === s.you && s.phase === 'spin');
    const key = `${s.round}:${s.turnSeq}:${s.phase}`;
    if (mine && key !== lastTurnKey) { sounds.turn(); if (document.hidden) document.title = '🔔 Your turn — UNO Spin'; }
    lastTurnKey = mine ? key : null;
    render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'UNO Spin'; });
  document.addEventListener('keydown', e => {
    if (!state || state.phase === 'lobby' || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'd' && !$('b-draw').disabled) act('draw');
    else if (k === 'p' && !$('b-pass').disabled) act('pass');
    else if (k === 'u' && !$('b-uno').disabled) act('uno');
    else if (k === ' ' && !$('b-race').classList.contains('hidden')) { e.preventDefault(); act('unoSpin'); }
    else if (k === 's' && !$('b-spin').classList.contains('hidden')) act('spin');
    else if (k === 'escape' && modal && (modal.kind === 'color' || modal.kind === 'discardColor')) closeModal();
  });
})();
