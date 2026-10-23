(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // ---------- storage / identity ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let playerId = LS.get('nh_pid', null);
  if (!playerId) {
    playerId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    LS.set('nh_pid', playerId);
  }
  let myName = LS.get('nh_name', '');

  const socket = new Net('/ws'); window.__net = socket;
  let state = null, prev = null, roomCode = null;
  let turnDeadline = 0, turnTotal = 0, nextHandAt = 0, warnedTurn = null;
  let raiseKey = null, unread = 0, portrait = false;

  // ---------- utils ----------
  const fmt = n => Number(n || 0).toLocaleString();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = n => n.trim().split(/\s+/).slice(0, 2).map(w => [...w][0] || '').join('').toUpperCase() || '?';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SUIT = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };
  const BETTING = ['preflop', 'flop', 'turn', 'river'];

  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = 'toast'), 2600);
  }

  // ---------- sound (synthesised, no files) ----------
  const Sound = {
    ctx: null, master: null, on: LS.get('nh_sound', 'on') === 'on',
    init() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(f, d, { type = 'sine', vol = 0.2, at = 0, to = null } = {}) {
      const c = this.ctx, t = c.currentTime + at;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + d + 0.05);
    },
    noise(d, { vol = 0.2, at = 0, freq = 3000, q = 1, type = 'bandpass' } = {}) {
      const c = this.ctx, t = c.currentTime + at;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate * d), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      src.connect(f).connect(g).connect(this.master);
      src.start(t);
    },
    play(kind, n = 1) {
      if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
      switch (kind) {
        case 'card':
          for (let i = 0; i < n; i++) this.noise(0.07, { vol: 0.5, at: i * 0.08, freq: 2600 + Math.random() * 1400, q: 0.9 });
          break;
        case 'flip':
          for (let i = 0; i < n; i++) { this.noise(0.09, { vol: 0.45, at: i * 0.13, freq: 1800, q: 0.7 }); this.tone(520, 0.05, { vol: 0.05, at: i * 0.13 + 0.02 }); }
          break;
        case 'chip':
          this.tone(3200, 0.05, { type: 'triangle', vol: 0.14 });
          this.tone(2400, 0.06, { type: 'triangle', vol: 0.12, at: 0.045 });
          this.tone(2900, 0.05, { type: 'triangle', vol: 0.09, at: 0.09 });
          break;
        case 'check':
          this.tone(170, 0.09, { vol: 0.45, to: 90 });
          this.tone(170, 0.09, { vol: 0.38, at: 0.12, to: 90 });
          break;
        case 'fold':
          this.noise(0.2, { vol: 0.25, freq: 900, type: 'lowpass' });
          break;
        case 'turn':
          this.tone(880, 0.16, { vol: 0.2 });
          this.tone(1320, 0.28, { vol: 0.2, at: 0.12 });
          break;
        case 'allin':
          this.tone(200, 0.55, { type: 'sawtooth', vol: 0.07, to: 900 });
          this.tone(300, 0.55, { type: 'square', vol: 0.035, to: 1350 });
          this.play('chip');
          break;
        case 'win':
          [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.32, { type: 'triangle', vol: 0.17, at: i * 0.09 }));
          this.tone(1568, 0.6, { vol: 0.09, at: 0.38 });
          break;
        case 'collect':
          for (let i = 0; i < 4; i++) this.tone(2600 + i * 180, 0.04, { type: 'triangle', vol: 0.08, at: i * 0.05 });
          break;
        case 'tick':
          this.tone(1250, 0.04, { type: 'square', vol: 0.05 });
          break;
        case 'msg':
          this.tone(990, 0.07, { vol: 0.05 });
          break;
      }
    },
  };
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => Sound.init(), { passive: true }));

  // ---------- lobby ----------
  $('#createName').value = myName;
  $('#joinName').value = myName;
  let timerVal = 30;
  $$('#timerSeg button').forEach(b => b.addEventListener('click', () => {
    $$('#timerSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    timerVal = +b.dataset.v;
  }));
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (urlRoom) {
    $('#joinCode').value = urlRoom;
    setTimeout(() => (myName ? $('#joinForm button') : $('#joinName')).focus(), 50);
  }

  function enterRoom(res, name) {
    if (!res || res.error) { toast(res ? res.error : 'Could not connect', true); return; }
    roomCode = res.code;
    myName = name;
    LS.set('nh_name', name);
    LS.set('nh_room', roomCode);
    history.replaceState(null, '', '?room=' + roomCode);
    $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#roomCode').textContent = roomCode;
    requestAnimationFrame(layout);
  }

  $('#createForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#createName').value.trim();
    if (!name) return;
    const [sb, bb] = $('#blinds').value.split('/').map(Number);
    const settings = { smallBlind: sb, bigBlind: bb, startingStack: bb * +$('#stack').value, turnTime: timerVal };
    socket.emit('create', { name, playerId, settings }, res => enterRoom(res, name));
  });

  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    const code = $('#joinCode').value.trim().toUpperCase();
    if (!name || !code) return;
    socket.emit('join', { code, name, playerId }, res => enterRoom(res, name));
  });

  // auto-rejoin after refresh
  if (urlRoom && LS.get('nh_room', '') === urlRoom && myName) roomCode = urlRoom;
  socket.on('connect', () => {
    if (!roomCode) return;
    socket.emit('join', { code: roomCode, name: myName, playerId }, res => {
      if (res && res.error) { toast(res.error, true); backToLobby(); }
      else enterRoom(res, myName);
    });
  });
  socket.on('disconnect', () => { if (roomCode) toast('Connection lost — reconnecting…', true); });

  function backToLobby() {
    roomCode = null; state = null; prev = null;
    LS.del('nh_room');
    history.replaceState(null, '', '/');
    $('#game').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    $('#messages').innerHTML = '';
  }

  // ---------- top bar ----------
  $('#copyLink').addEventListener('click', async () => {
    const link = location.origin + '/?room=' + roomCode;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied — send it to your friends'); }
    catch { window.prompt('Copy this invite link:', link); }
  });
  const refreshSoundBtn = () => ($('#soundBtn').textContent = Sound.on ? '🔊' : '🔇');
  refreshSoundBtn();
  $('#soundBtn').addEventListener('click', () => {
    Sound.on = !Sound.on; LS.set('nh_sound', Sound.on ? 'on' : 'off'); refreshSoundBtn();
    Sound.init(); Sound.play('chip');
  });
  $('#sitBtn').addEventListener('click', () => {
    const me = mySeatObj();
    if (me) socket.emit('sitout', !me.sittingOut);
  });
  $('#rebuyBtn').addEventListener('click', rebuy);
  function rebuy() { socket.emit('rebuy', null, r => r && r.error && toast(r.error, true)); }
  $('#leaveBtn').addEventListener('click', () => {
    if (!confirm('Leave the table? Your seat and chips will be given up.')) return;
    socket.emit('leave', null, () => backToLobby());
  });
  $('#chatToggle').addEventListener('click', () => {
    $('#sidebar').classList.add('open'); unread = 0; $('#chatBadge').classList.add('hidden');
  });
  $('#closeSide').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $$('.tabs button[data-tab]').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    $('#chatTab').classList.toggle('hidden', b.dataset.tab !== 'chat');
    $('#standingsTab').classList.toggle('hidden', b.dataset.tab !== 'standings');
  }));

  // ---------- chat & emoji ----------
  const EMOJIS = ['😂', '🔥', '😱', '👏', '😎', '🤡', '💀', '🙏', '😤', '🍀', '💸', '🫡'];
  $('#emojiBar').innerHTML = EMOJIS.map(e => `<button type="button" data-e="${e}">${e}</button>`).join('');
  $('#emojiBar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) socket.emit('emoji', b.dataset.e);
  });
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (!v) return;
    socket.emit('chat', v);
    $('#chatInput').value = '';
  });

  function addMsg(m, quiet) {
    const box = $('#messages');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const div = document.createElement('div');
    if (m.system) {
      div.className = 'msg sys' + (/ wins | split /.test(m.text) ? ' win' : '');
      div.textContent = m.text;
    } else {
      div.className = 'msg';
      const who = document.createElement('span');
      who.className = 'who'; who.style.color = m.color; who.textContent = m.name;
      div.append(who, document.createTextNode(m.text));
      if (!quiet) {
        Sound.play('msg');
        if (!$('#sidebar').classList.contains('open') && getComputedStyle($('#chatToggle')).display !== 'none') {
          unread++; $('#chatBadge').classList.remove('hidden');
        }
      }
    }
    box.appendChild(div);
    while (box.children.length > 120) box.firstChild.remove();
    if (near || quiet) box.scrollTop = box.scrollHeight;
  }
  socket.on('chatHistory', list => { $('#messages').innerHTML = ''; list.forEach(m => addMsg(m, true)); });
  socket.on('chat', m => addMsg(m));
  socket.on('emoji', ({ seat, emoji }) => {
    const pos = seatXY(seat);
    if (!pos) return;
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    el.style.left = pos[0] + 'px';
    el.style.top = pos[1] + 'px';
    el.style.setProperty('--drift', (Math.random() * 60 - 30) + 'px');
    $('#fxLayer').appendChild(el);
    setTimeout(() => el.remove(), 2300);
  });

  // ---------- table geometry ----------
  const POS_L = [[50, 90], [21, 86], [8.5, 59], [12.5, 24], [34, 8], [66, 8], [87.5, 24], [91.5, 59], [79, 86]];
  const POS_P = [[50, 91], [15, 77], [11, 57], [12, 35], [31, 13], [69, 13], [88, 35], [89, 57], [85, 77]];
  const CENTER = [50, 47];
  const table = $('#table');

  function layout() {
    const area = $('#tableArea');
    const w = area.clientWidth - 12, h = area.clientHeight - 12;
    if (w <= 0 || h <= 0) return;
    portrait = w / h < 1.1;
    const ratio = portrait ? 0.74 : 1.85;
    let tw = w, th = tw / ratio;
    if (th > h) { th = h; tw = th * ratio; }
    table.style.width = tw + 'px';
    table.style.height = th + 'px';
    table.classList.toggle('portrait', portrait);
    const s = portrait ? clamp(tw / 470, 0.58, 1.1) : clamp(tw / 1000, 0.55, 1.2);
    table.style.setProperty('--s', s.toFixed(3));
    if (state) render(true);
  }
  window.addEventListener('resize', layout);

  function visualIndex(seat) {
    const my = state ? state.mySeat : -1;
    return my >= 0 ? (seat - my + 9) % 9 : seat;
  }
  function seatPct(seat) { return (portrait ? POS_P : POS_L)[visualIndex(seat)]; }
  function toward(p, f) { return [p[0] + (CENTER[0] - p[0]) * f, p[1] + (CENTER[1] - p[1]) * f]; }
  function pctToPx(p) { return [p[0] / 100 * table.clientWidth, p[1] / 100 * table.clientHeight]; }
  function seatXY(seat) { return state ? pctToPx(seatPct(seat)) : null; }
  function betPct(seat) {
    const p = seatPct(seat);
    // my hole cards are big and face the center, so my bet sits beside them (mirroring the dealer button)
    if (!portrait && state && seat === state.mySeat) return [p[0] - 14, p[1] - 9];
    return toward(p, p[1] < (portrait ? 20 : 40) ? 0.5 : 0.44);
  }
  function potXY() {
    const pr = $('#pot').getBoundingClientRect(), tr = table.getBoundingClientRect();
    return [pr.left - tr.left + pr.width / 2, pr.top - tr.top + pr.height / 2];
  }

  // ---------- rendering helpers ----------
  function cardHTML(c, cls = '', style = '') {
    if (!c) return `<div class="card back ${cls}" style="${style}"></div>`;
    const r = c[0] === 'T' ? '10' : c[0];
    const red = c[1] === 'h' || c[1] === 'd';
    return `<div class="card ${red ? 'red' : ''} ${cls}" style="${style}"><span class="r">${r}</span><span class="s">${SUIT[c[1]]}</span><span class="big">${SUIT[c[1]]}</span></div>`;
  }
  const CHIP_COLORS = ['#00e5ff', '#ff2d95', '#a46bff', '#39ff88', '#ffb800'];
  function stackHTML(amount) {
    const bb = state.settings.bigBlind;
    const n = clamp(Math.ceil(Math.log2(amount / bb + 1)), 1, 4);
    let h = '<div class="stack">';
    for (let i = 0; i < n; i++) h += `<div class="chip" style="--cc:${CHIP_COLORS[(Math.floor(Math.log10(amount + 1)) + i) % CHIP_COLORS.length]};top:${-i * 4}px"></div>`;
    return h + '</div>';
  }
  function tagFor(p) {
    const st = state;
    if (st.result && st.phase === 'complete' && st.result.winners.some(w => w.seat === p.seat)) {
      const w = st.result.winners.find(w => w.seat === p.seat);
      return `<div class="tag allin">+${fmt(w.amount)}</div>`;
    }
    const a = p.lastAction;
    if (p.inHand && a) {
      const label = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in', sb: 'SB', bb: 'BB' }[a.type];
      const showAmt = ['call', 'bet', 'raise'].includes(a.type) && a.amount;
      return `<div class="tag ${a.type}">${label}${showAmt ? ' ' + fmt(a.amount) : ''}</div>`;
    }
    if (p.allIn && p.inHand && !p.folded) return '<div class="tag allin">All-in</div>';
    if (!p.connected) return '<div class="tag status">Offline</div>';
    if (p.sittingOut) return '<div class="tag status">Sitting out</div>';
    if (p.chips === 0 && !p.inHand) return '<div class="tag status">Busted</div>';
    if (!p.inHand && st.started && BETTING.includes(st.phase)) return '<div class="tag status">Next hand</div>';
    return '';
  }

  const seatEls = [], betEls = [];
  for (let i = 0; i < 9; i++) {
    const s = document.createElement('div'); s.className = 'seat'; $('#seats').appendChild(s); seatEls.push(s);
    const b = document.createElement('div'); b.className = 'bet hidden'; $('#bets').appendChild(b); betEls.push(b);
  }

  function winnerBest() {
    const r = state.result;
    if (!r || r.uncontested || state.phase !== 'complete' || !r.winners.length) return null;
    return new Set(r.winners[0].cards);
  }

  function renderSeats(force) {
    const st = state;
    const best = winnerBest();
    const winners = new Set(st.result && st.phase === 'complete' ? st.result.winners.map(w => w.seat) : []);
    const handNames = {};
    if (st.result && st.result.hands && st.phase === 'complete') st.result.hands.forEach(h => (handNames[h.seat] = h.handName));
    const occupied = st.seats.filter(Boolean).length;

    st.seats.forEach((p, i) => {
      const el = seatEls[i];
      const pos = seatPct(i);
      el.style.left = pos[0] + '%';
      el.style.top = pos[1] + '%';
      const below = pos[1] < (portrait ? 20 : 40);
      if (!p) {
        const show = occupied < 9 && st.mySeat >= 0 && !portrait;
        const key = 'empty' + show;
        if (el._key !== key || force) {
          el.className = 'seat empty' + (show ? '' : ' hidden');
          el.innerHTML = '<div class="pod">open</div>';
          el._key = key;
        }
        return;
      }
      const pp = prev && prev.seats[i];
      const samePlayer = pp && pp.name === p.name;
      const dealing = p.cardCount > 0 && (!samePlayer || pp.cardCount === 0 || (prev && prev.handNumber !== st.handNumber));
      const revealing = !dealing && p.cards && !p.isYou && samePlayer && !pp.cards;

      let cards = '';
      if (p.cardCount > 0) {
        const xy = pctToPx(pos), c = pctToPx(CENTER);
        const dStyle = dealing ? `--dx:${(c[0] - xy[0]).toFixed(0)}px;--dy:${(c[1] - xy[1]).toFixed(0)}px;` : '';
        for (let k = 0; k < p.cardCount; k++) {
          const card = p.cards ? p.cards[k] : null;
          let cls = dealing ? 'deal' : revealing ? 'flip' : '';
          if (best && card) cls += best.has(card) && winners.has(i) ? ' hl' : '';
          const delay = dealing ? `animation-delay:${(k * occupied + visualIndex(i)) * 0.07}s;` : '';
          cards += cardHTML(card, cls, dStyle + delay);
        }
      }
      const hn = handNames[i] ? `<div class="hand-name">${esc(handNames[i])}</div>` : '';
      const cls = ['seat',
        p.isYou && 'me', below && 'below',
        st.currentSeat === i && 'active',
        p.folded && p.inHand && 'folded',
        (!p.inHand || p.sittingOut) && 'out',
        !p.connected && 'offline',
        winners.has(i) && 'winner',
      ].filter(Boolean).join(' ');

      const html = `<div class="hole">${cards}${hn}</div>
        <div class="pod" style="--c:${p.color}">
          <div class="avatar" style="--c:${p.color}">${esc(initials(p.name))}</div>
          <div class="info"><div class="name">${esc(p.name)}${p.isHost ? '<span class="crown" title="Host">👑</span>' : ''}</div><div class="chips">${fmt(p.chips)}</div></div>
          ${tagFor(p)}
        </div>`;
      if (html !== el._key) { el.innerHTML = html; el._key = html; }
      el.className = cls;
    });
  }

  function renderBets() {
    state.seats.forEach((p, i) => {
      const el = betEls[i];
      if (!p || !p.bet) { el.classList.add('hidden'); el._amt = 0; return; }
      const pos = betPct(i);
      el.style.left = pos[0] + '%';
      el.style.top = pos[1] + '%';
      if (el._amt !== p.bet) {
        el.innerHTML = `${stackHTML(p.bet)}<span class="amt">${fmt(p.bet)}</span>`;
        el.classList.remove('hidden');
        el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
        el._amt = p.bet;
      }
    });
    const d = $('#dealerBtn');
    if (state.dealerSeat >= 0 && state.seats[state.dealerSeat] && state.handNumber > 0) {
      const sp = seatPct(state.dealerSeat);
      const isMe = state.dealerSeat === state.mySeat;
      const t = toward(sp, isMe ? 0.12 : 0.3);
      const dx = CENTER[0] - sp[0], dy = CENTER[1] - sp[1];
      const len = Math.hypot(dx, dy) || 1;
      const off = isMe ? 13 : 8;
      d.style.left = (t[0] + (-dy / len) * off) + '%';
      d.style.top = (t[1] + (dx / len) * off) + '%';
      d.classList.remove('hidden');
    } else d.classList.add('hidden');
  }

  function renderBoard() {
    const board = state.board;
    const best = winnerBest();
    const prevLen = prev && prev.handNumber === state.handNumber ? prev.board.length : 0;
    const key = board.join() + '|' + (best ? [...best].join() : '');
    const el = $('#board');
    if (el._key === key) return;
    let h = '', n = 0;
    for (let i = 0; i < 5; i++) {
      const c = board[i];
      if (!c) { h += '<div class="slot"></div>'; continue; }
      let cls = '';
      const isNew = i >= prevLen && el._len !== board.length;
      if (isNew) cls += ' flip';
      if (best) cls += best.has(c) ? ' hl' : ' dim';
      h += cardHTML(c, cls, isNew ? `animation-delay:${(n++) * 0.13}s` : '');
    }
    el.innerHTML = h;
    el._key = key;
    el._len = board.length;
  }

  function renderCenter() {
    const st = state;
    $('#pot').innerHTML = st.totalPot > 0 ? `<small>Pot</small>${fmt(st.totalPot)}` : '';
    let msg = '';
    if (st.phase === 'complete' && st.result) {
      const r = st.result;
      const names = r.winners.map(w => `${esc(w.name)} wins ${fmt(w.amount)}`).join(' · ');
      const hand = r.uncontested ? 'Everyone else folded' : esc(r.winners[0].handName || '');
      msg = `<div class="win">${names}</div><div class="sub">${hand}</div>`;
    } else if (!st.started) {
      const n = st.seats.filter(Boolean).length;
      msg = `<div class="sub">${n} player${n === 1 ? '' : 's'} at the table — waiting to start</div>`;
    } else if (st.phase === 'waiting') {
      msg = '<div class="sub">Waiting for at least 2 active players…</div>';
    }
    $('#centerMsg').innerHTML = msg;
  }

  function mySeatObj() { return state && state.mySeat >= 0 ? state.seats[state.mySeat] : null; }

  function renderActionBar() {
    const st = state, me = mySeatObj();
    // hand strength
    if (me && me.cards && me.cards.length && me.inHand && !me.folded) {
      const name = window.HandEval ? HandEval.describePartial([...me.cards, ...st.board]) : '';
      $('#myHand').innerHTML = name ? `Your hand <b>${esc(name)}</b>` : '';
    } else $('#myHand').innerHTML = '';

    const a = st.actions;
    const actions = $('#actions'), status = $('#statusBox');
    if (a && me) {
      actions.classList.remove('hidden');
      status.innerHTML = '';
      const allInCall = !a.canCheck && a.toCall >= me.chips;
      $('#callBtn').innerHTML = a.canCheck ? '<span>Check</span><kbd>C</kbd>'
        : `<span>${allInCall ? 'All-in' : 'Call'}</span><small>${fmt(a.toCall)}</small><kbd>C</kbd>`;
      const canRaise = a.canRaise && a.maxRaiseTo > st.currentBet;
      $('#raiseBox').classList.toggle('hidden', !canRaise);
      $('#raiseBtn').classList.toggle('hidden', !canRaise);
      if (canRaise) {
        const key = st.handNumber + st.phase + st.currentBet + ':' + a.minRaiseTo;
        const range = $('#raiseRange');
        range.min = a.minRaiseTo; range.max = a.maxRaiseTo; range.step = 1;
        if (raiseKey !== key) { setRaise(a.minRaiseTo); raiseKey = key; }
        else setRaise(+range.value);
        const onlyAllIn = a.maxRaiseTo <= a.minRaiseTo;
        range.disabled = onlyAllIn; $('#raiseInput').disabled = onlyAllIn;
      }
    } else {
      actions.classList.add('hidden');
      raiseKey = null;
      const h = statusHTML(me);
      status.innerHTML = h.trim().startsWith('<span') ? h : `<span>${h}</span>`;
    }
  }

  function setRaise(v) {
    const a = state && state.actions;
    if (!a) return;
    v = clamp(Math.round(v), a.minRaiseTo, a.maxRaiseTo);
    const range = $('#raiseRange');
    range.value = v;
    $('#raiseInput').value = v;
    const pct = a.maxRaiseTo > a.minRaiseTo ? (v - a.minRaiseTo) / (a.maxRaiseTo - a.minRaiseTo) * 100 : 100;
    range.style.setProperty('--fill', pct + '%');
    const allIn = v >= a.maxRaiseTo;
    $('#raiseBtn').innerHTML = `<span>${allIn ? 'All-in' : a.isBet ? 'Bet' : 'Raise to'}</span><small>${fmt(v)}</small><kbd>R</kbd>`;
  }

  function statusHTML(me) {
    const st = state;
    if (!me) return 'Watching the table';
    const host = st.seats.find(p => p && p.isHost);
    if (!st.started) {
      const n = st.seats.filter(p => p && p.connected && p.chips > 0 && !p.sittingOut).length;
      if (st.isHost) {
        return `<span>${n < 2 ? 'Send the invite link to your friends — you need at least 2 players.' : `<b>${n} players</b> ready.`}</span>
          <button class="btn primary start-btn" id="startBtn" ${n < 2 ? 'disabled style="opacity:.5"' : ''}>Start game</button>`;
      }
      return `Waiting for <b>${esc(host ? host.name : 'the host')}</b> to start the game…`;
    }
    if (me.chips === 0 && !(me.inHand && !me.folded && BETTING.includes(st.phase))) {
      return `<span>You're out of chips.</span><button class="btn primary sm" id="rebuyInline">Rebuy ${fmt(st.settings.startingStack)}</button>`;
    }
    if (me.sittingOut) return `<span>You're sitting out.</span><button class="btn cyan sm" id="sitInBtn">Sit back in</button>`;
    if (st.phase === 'complete') return `Next hand in <b id="nextIn">…</b>`;
    if (st.phase === 'waiting') return 'Waiting for more players…';
    if (!me.inHand) return "You'll be dealt in next hand.";
    if (me.folded) return 'You folded — sit tight for the next hand.';
    const cur = st.currentSeat >= 0 ? st.seats[st.currentSeat] : null;
    if (me.allIn) return `You're <b>all-in</b>. Good luck!`;
    return cur ? `Waiting for <b>${esc(cur.name)}</b>…` : 'Dealing…';
  }

  $('#statusBox').addEventListener('click', e => {
    if (e.target.id === 'startBtn') socket.emit('start', null, r => r && r.error && toast(r.error, true));
    if (e.target.id === 'rebuyInline') rebuy();
    if (e.target.id === 'sitInBtn') socket.emit('sitout', false);
  });

  function renderTop() {
    const st = state, me = mySeatObj();
    $('#blindsInfo').innerHTML = `Blinds <b>${fmt(st.settings.smallBlind)}/${fmt(st.settings.bigBlind)}</b>${st.handNumber ? ` · Hand <b>#${st.handNumber}</b>` : ''}`;
    $('#sitBtn').textContent = me && me.sittingOut ? 'Sit in' : 'Sit out';
    $('#sitBtn').classList.toggle('on', !!(me && me.sittingOut));
    $('#rebuyBtn').classList.toggle('hidden', !(me && me.chips === 0 && st.started && !(me.inHand && !me.folded && BETTING.includes(st.phase))));
    const rows = st.seats.filter(Boolean).sort((a, b) => b.net - a.net);
    $('#standings').innerHTML = rows.map(p => `<tr>
      <td><span class="sw" style="background:${p.color};box-shadow:0 0 8px ${p.color}"></span>${esc(p.name)}${p.isYou ? ' <span style="color:var(--muted)">(you)</span>' : ''}</td>
      <td>${fmt(p.chips)}</td><td>${p.buyIns}</td>
      <td class="${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${p.net > 0 ? '+' : ''}${fmt(p.net)}</td></tr>`).join('');
  }

  // ---------- chip flights ----------
  function fly(from, to, amount, delay = 0, dur = 550) {
    const el = document.createElement('div');
    el.className = 'fly-chip';
    el.innerHTML = stackHTML(Math.max(amount, 1));
    el.style.left = from[0] + 'px';
    el.style.top = from[1] + 'px';
    el.style.opacity = '0';
    $('#fxLayer').appendChild(el);
    const anim = el.animate([
      { left: from[0] + 'px', top: from[1] + 'px', opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
      { left: to[0] + 'px', top: to[1] + 'px', opacity: 1, transform: 'translate(-50%,-50%) scale(0.9)' },
    ], { duration: dur, delay, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' });
    anim.onfinish = () => el.remove();
    setTimeout(() => el.remove(), dur + delay + 200);
  }

  function confetti() {
    const colors = ['#ff2d95', '#00e5ff', '#ffcc33', '#a46bff', '#39ff88'];
    const w = table.clientWidth, h = table.clientHeight;
    for (let i = 0; i < 70; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.background = colors[i % colors.length];
      el.style.left = (w / 2) + 'px';
      el.style.top = (h * 0.45) + 'px';
      $('#fxLayer').appendChild(el);
      const ang = Math.random() * Math.PI * 2, dist = 120 + Math.random() * w * 0.4;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist * 0.6 + 140;
      el.animate([
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${Math.random() * 720}deg)`, opacity: 0 },
      ], { duration: 1400 + Math.random() * 900, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' }).onfinish = () => el.remove();
    }
  }

  function animateTransitions() {
    if (!prev || !state || prev.handNumber !== state.handNumber) return;
    // street end: bets slide into the pot
    const collected = prev.seats.some((p, i) => p && p.bet > 0 && (!state.seats[i] || state.seats[i].bet === 0)) &&
      state.seats.every(p => !p || p.bet === 0);
    let delay = 0;
    if (collected) {
      const pot = potXY();
      prev.seats.forEach((p, i) => { if (p && p.bet > 0) fly(pctToPx(betPct(i)), pot, p.bet, 0, 420); });
      Sound.play('collect');
      delay = 450;
    }
    // hand won: pot flies to winners
    if (state.phase === 'complete' && prev.phase !== 'complete' && state.result) {
      const pot = potXY();
      state.result.winners.forEach((w, k) => fly(pot, seatXY(w.seat), w.amount, delay + 250 + k * 150, 700));
      if (state.result.winners.some(w => w.seat === state.mySeat)) setTimeout(confetti, delay + 300);
    }
  }

  // ---------- main render ----------
  function render(force) {
    if (!state) return;
    renderSeats(force);
    renderBets();
    renderBoard();
    renderCenter();
    renderActionBar();
    renderTop();
  }

  socket.on('state', s => {
    prev = state;
    state = s;
    if (s.currentSeat >= 0 && s.turnRemainingMs > 0) {
      turnDeadline = Date.now() + s.turnRemainingMs;
      turnTotal = s.turnTotalMs || s.turnRemainingMs;
    } else { turnDeadline = 0; }
    nextHandAt = s.nextHandInMs ? Date.now() + s.nextHandInMs : 0;
    if (!prev || prev.mySeat !== s.mySeat) layout();
    render();
    animateTransitions();
  });

  socket.on('fx', fx => {
    switch (fx.kind) {
      case 'deal': Sound.play('card', Math.min(fx.count, 12)); break;
      case 'street': Sound.play('flip', fx.count); break;
      case 'turn':
        if (state && fx.seat === state.mySeat) {
          Sound.play('turn');
          if (navigator.vibrate) navigator.vibrate(60);
          if (document.hidden) document.title = '🔴 Your turn — Neon Hold\'em';
        }
        break;
      case 'action':
        if (fx.action === 'fold') Sound.play('fold');
        else if (fx.action === 'check') Sound.play('check');
        else if (fx.action === 'allin') Sound.play('allin');
        else Sound.play('chip');
        break;
      case 'win':
        if (state && fx.seats.includes(state.mySeat)) Sound.play('win');
        else Sound.play('collect');
        break;
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = "Neon Hold'em"; });

  // ---------- timer ring / countdown loop ----------
  function tick() {
    if (state) {
      const active = state.currentSeat >= 0 ? seatEls[state.currentSeat] : null;
      if (active && turnDeadline) {
        const rem = Math.max(0, turnDeadline - Date.now());
        const p = turnTotal ? rem / turnTotal : 0;
        const av = active.querySelector('.avatar');
        if (av) {
          av.style.setProperty('--p', p.toFixed(4));
          av.style.setProperty('--ring', p < 0.3 ? '#ff3d6e' : p < 0.6 ? '#ffcc33' : '#39ff88');
        }
        if (state.currentSeat === state.mySeat && rem < 5000 && rem > 0) {
          const sec = Math.ceil(rem / 1000);
          if (warnedTurn !== sec) { warnedTurn = sec; Sound.play('tick'); }
        }
      } else if (active) {
        const av = active.querySelector('.avatar');
        if (av) { av.style.setProperty('--p', '1'); av.style.setProperty('--ring', 'var(--c)'); }
      }
      const ni = document.getElementById('nextIn');
      if (ni) ni.textContent = Math.max(0, Math.ceil((nextHandAt - Date.now()) / 1000)) + 's';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- actions ----------
  function send(type, amount) {
    socket.emit('action', { type, amount }, r => r && r.error && toast(r.error, true));
  }
  $('#foldBtn').addEventListener('click', () => {
    const a = state && state.actions;
    if (a && a.canCheck && !confirm('You can check for free. Fold anyway?')) return;
    send('fold');
  });
  $('#callBtn').addEventListener('click', () => {
    const a = state && state.actions;
    if (a) send(a.canCheck ? 'check' : 'call');
  });
  $('#raiseBtn').addEventListener('click', () => {
    const a = state && state.actions;
    if (!a) return;
    const v = +$('#raiseRange').value;
    if (v >= a.maxRaiseTo) send('allin'); else send('raise', v);
  });
  $('#raiseRange').addEventListener('input', e => setRaise(+e.target.value));
  $('#raiseInput').addEventListener('change', e => setRaise(+e.target.value));
  $$('.step').forEach(b => b.addEventListener('click', () => {
    const a = state && state.actions;
    if (!a) return;
    const step = state.settings.bigBlind;
    setRaise(+$('#raiseRange').value + step * +b.dataset.step);
  }));
  $$('.presets button').forEach(b => b.addEventListener('click', () => {
    const a = state && state.actions;
    if (!a) return;
    const p = b.dataset.p;
    if (p === 'min') return setRaise(a.minRaiseTo);
    if (p === 'all') return setRaise(a.maxRaiseTo);
    const potAfterCall = state.totalPot + a.toCall;
    const target = state.currentBet + potAfterCall * +p;
    const sb = state.settings.smallBlind;
    setRaise(Math.round(target / sb) * sb);
  }));
  document.addEventListener('keydown', e => {
    if (!state || !state.actions || e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') $('#foldBtn').click();
    else if (k === 'c' || k === 'k') $('#callBtn').click();
    else if (k === 'r' && !$('#raiseBtn').classList.contains('hidden')) $('#raiseBtn').click();
  });
})();
