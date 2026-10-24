// UNO Show 'Em No Mercy rules engine. The server is authoritative: every action is validated
// here, and view(playerId) hides other hands and the draw pile.
const crypto = require('crypto');

const COLORS = ['red', 'yellow', 'green', 'blue'];
const DRAW_VALUE = { draw2: 2, draw4: 4, wildRev4: 4, wild6: 6, wild10: 10 };
const WILDS = ['wildRev4', 'wild6', 'wild10', 'roulette'];
const MERCY_LIMIT = 25;          // holding this many cards knocks you out
const TURN_TIMES = [0, 15, 30, 45, 60];
const PLAYER_COLORS = ['#ff3b5c', '#3b8cff', '#2fd17a', '#ffc93b', '#b06bff', '#ff8a3b', '#3bd9ff', '#ff6bd5', '#a3e635', '#f5f5f5'];
const NAMES = {
  skip: 'Skip', reverse: 'Reverse', draw2: 'Draw 2', draw4: 'Draw 4', skipAll: 'Skip Everyone', discardAll: 'Discard All',
  wildRev4: 'Wild Reverse Draw 4', wild6: 'Wild Draw 6', wild10: 'Wild Draw 10', roulette: 'Wild Color Roulette',
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The 168-card No Mercy deck.
function buildDeck() {
  const cards = [];
  let id = 0;
  const add = (type, color, value) => cards.push({ id: id++, type, color, value });
  for (const color of COLORS) {
    for (let n = 0; n <= 9; n++) { add('number', color, n); add('number', color, n); }
    for (let k = 0; k < 3; k++) { add('draw2', color); add('skip', color); add('reverse', color); add('discardAll', color); }
    for (let k = 0; k < 2; k++) { add('draw4', color); add('skipAll', color); }
  }
  for (let k = 0; k < 8; k++) { add('wildRev4', null); add('roulette', null); }
  for (let k = 0; k < 4; k++) { add('wild6', null); add('wild10', null); }
  return cards;
}

const cardName = c => (c.type === 'number' ? `${c.color} ${c.value}` : `${c.color ? c.color + ' ' : ''}${NAMES[c.type]}`);
const isWild = c => WILDS.includes(c.type);

class Game {
  constructor(code, settings = {}, hooks = {}) {
    this.code = code;
    this.settings = { turnTime: TURN_TIMES.includes(settings.turnTime) ? settings.turnTime : 30, sevenZero: settings.sevenZero !== false };
    this.hooks = { changed() {}, fx() {}, ...hooks };
    this.players = [];
    this.spectators = new Map();
    this.phase = 'lobby';
    this.round = 0;
    this.log = [];
    this.logId = 0;
    this.timer = { key: null, handle: null, deadline: null };
  }

  // ---------- lobby ----------
  findPlayer(id) { return this.players.find(p => p.id === id); }
  // the host is whoever created the game; seats get shuffled, so it can't just be the first seat
  get hostId() { return this.host && this.findPlayer(this.host) ? this.host : this.players[0] && this.players[0].id; }

  addPlayer(id, name) {
    const existing = this.findPlayer(id);
    if (existing) { existing.connected = true; existing.name = name || existing.name; this.hooks.changed(); return { ok: true }; }
    // newcomers can take a seat before the first round or between rounds; otherwise they watch
    if (this.phase !== 'lobby' && this.phase !== 'over') { this.spectators.set(id, name); this.hooks.changed(); return { ok: true, spectator: true }; }
    this.spectators.delete(id);
    if (this.players.length >= 10) return { error: 'This game is full (10 players max)' };
    if (!this.players.length) this.host = id;
    const used = new Set(this.players.map(p => p.color));
    this.players.push({ id, name, color: PLAYER_COLORS.find(c => !used.has(c)), connected: true, wins: 0, hand: [], out: false });
    this.hooks.changed();
    return { ok: true };
  }

  removePlayer(id) {
    this.spectators.delete(id);
    if (this.phase !== 'lobby') { this.setConnected(id, false); return; }
    this.players = this.players.filter(p => p.id !== id);
    this.hooks.changed();
  }

  setConnected(id, value) {
    const p = this.findPlayer(id);
    if (p) { p.connected = value; this.hooks.changed(); }
  }

  configure(id, s = {}) {
    if (this.phase !== 'lobby' && this.phase !== 'over') return 'Settings can only change between rounds';
    if (id !== this.hostId) return 'Only the host can change settings';
    if (s.turnTime != null && TURN_TIMES.includes(+s.turnTime)) this.settings.turnTime = +s.turnTime;
    if (typeof s.sevenZero === 'boolean') this.settings.sevenZero = s.sevenZero;
    this.hooks.changed();
    return null;
  }

  start(id) {
    if (this.phase !== 'lobby' && this.phase !== 'over') return 'A round is already in progress';
    if (id !== this.hostId) return 'Only the host can start';
    if (this.players.length < 2) return 'You need at least 2 players';
    this.round++;
    this.deck = shuffle(buildDeck());
    this.discard = [];
    for (const p of this.players) { p.hand = []; p.out = false; p.saidUno = false; }
    // a new round starts with the player after last round's starter
    if (this.round === 1) shuffle(this.players);
    this.direction = 1;
    this.current = (this.round - 1) % this.players.length;
    this.pending = 0;          // cards owed by whoever can't stack
    this.pendingMin = 0;       // a stacked draw card must be at least this value
    this.drawn = null;         // card drawn this turn that can now be played
    this.unoPending = null;    // player sitting on one card who hasn't called UNO
    this.winner = null;
    this.turnSeq = 0;
    for (let k = 0; k < 7; k++) for (const p of this.players) p.hand.push(this.deck.pop());
    // flip until a number card starts the discard pile
    let top;
    while ((top = this.deck.pop()).type !== 'number') this.deck.unshift(top);
    this.discard.push(top);
    this.color = top.color;
    this.phase = 'play';
    this.addLog(`Round ${this.round} — ${this.cur().name} goes first. Starting card: ${cardName(top)}.`);
    this.syncTimer();
    this.hooks.changed();
    return null;
  }

  // ---------- helpers ----------
  addLog(text, to) {
    this.log.push({ id: ++this.logId, text, to: to || null });
    if (this.log.length > 100) this.log.shift();
  }
  cur() { return this.players[this.current]; }
  top() { return this.discard[this.discard.length - 1]; }
  active() { return this.players.filter(p => !p.out); }

  // index of the player `steps` turns away, skipping knocked-out players
  nextIndex(from = this.current, steps = 1) {
    let i = from;
    const n = this.players.length;
    for (let k = 0; k < steps; k++) {
      do i = (i + this.direction + n) % n; while (this.players[i].out);
    }
    return i;
  }

  drawCard() {
    if (!this.deck.length) {
      if (this.discard.length <= 1) return null;
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
      this.addLog('The draw pile was reshuffled.');
    }
    return this.deck.pop();
  }

  // Give a player cards; returns false if the mercy rule knocked them out.
  give(p, n) {
    let got = 0;
    for (let k = 0; k < n; k++) {
      const c = this.drawCard();
      if (!c) break;
      p.hand.push(c);
      got++;
    }
    if (got) p.saidUno = false;
    this.hooks.fx({ type: 'draw', id: p.id, n: got });
    return this.mercyCheck(p);
  }

  mercyCheck(p) {
    if (p.out || p.hand.length < MERCY_LIMIT) return true;
    p.out = true;
    this.deck.unshift(...shuffle(p.hand));
    p.hand = [];
    if (this.unoPending === p.id) this.unoPending = null;
    this.addLog(`💀 ${p.name} hit ${MERCY_LIMIT} cards and is knocked out by the Mercy rule!`);
    this.hooks.fx({ type: 'mercy', id: p.id });
    const left = this.active();
    if (left.length === 1) this.endRound(left[0], 'last one standing');
    return false;
  }

  canPlay(card) {
    const top = this.top();
    if (this.pending) return card.type in DRAW_VALUE && DRAW_VALUE[card.type] >= this.pendingMin;
    if (isWild(card)) return true;
    if (card.color === this.color) return true;
    if (card.type === 'number') return top.type === 'number' && top.value === card.value;
    return card.type === top.type;
  }

  endRound(winner, how) {
    this.phase = 'over';
    this.winner = winner.id;
    winner.wins++;
    this.pending = 0;
    this.unoPending = null;
    this.addLog(`🏆 ${winner.name} wins round ${this.round} (${how})!`);
    this.hooks.fx({ type: 'win', id: winner.id });
  }

  // Move the turn on. `steps` = 0 means the same player goes again.
  advance(steps = 1) {
    if (this.phase === 'over') return;
    if (steps) this.current = this.nextIndex(this.current, steps);
    else if (this.cur().out) this.current = this.nextIndex();
    this.drawn = null;
    this.turnSeq++;
  }

  // ---------- actions ----------
  act(id, type, d = {}) {
    const p = this.findPlayer(id);
    if (!p) return 'You are not a player in this game';
    if (this.phase === 'lobby') return 'The game has not started';
    if (this.phase === 'over') return 'The round is over';
    if (d === null || typeof d !== 'object') d = {};
    if (p.out) return 'You have been knocked out this round';
    // the UNO catch window closes once anyone else makes a move
    if (this.unoPending && this.unoPending !== id && type !== 'catch' && type !== 'uno') this.unoPending = null;
    const handler = { play: this.doPlay, draw: this.doDraw, pass: this.doPass, uno: this.doUno, catch: this.doCatch, rouletteColor: this.doRoulette }[type];
    if (!handler) return 'Unknown action';
    const err = handler.call(this, p, d);
    if (!err) { this.syncTimer(); this.hooks.changed(); }
    return err || null;
  }

  doPlay(p, d) {
    if (this.phase !== 'play') return 'Waiting for the Color Roulette';
    if (this.cur() !== p) return 'It is not your turn';
    const card = p.hand.find(c => c.id === Number(d.cardId));
    if (!card) return 'You do not have that card';
    if (this.drawn != null && card.id !== this.drawn) return 'You can only play the card you just drew (or pass)';
    if (!this.canPlay(card)) return this.pending ? `Stack a draw card worth +${this.pendingMin} or more, or take the ${this.pending}` : 'That card does not match';
    let chosen = null;
    if (isWild(card) && card.type !== 'roulette') {
      if (!COLORS.includes(d.color)) return 'Choose a color';
      chosen = d.color;
    }
    let target = null;
    const sevenSwap = this.settings.sevenZero && card.type === 'number' && card.value === 7 && p.hand.length > 1;
    if (sevenSwap) {
      target = this.findPlayer(d.target);
      if (!target || target === p || target.out) return 'Choose a player to swap hands with';
    }

    p.hand.splice(p.hand.indexOf(card), 1);
    this.discard.push(card);
    this.color = chosen || card.color || this.color;
    if (p.hand.length === 1 && !p.saidUno) this.unoPending = p.id;
    if (p.hand.length !== 1) p.saidUno = false;
    this.addLog(`${p.name} played ${cardName(card)}${chosen ? ` → ${chosen}` : ''}.`);
    this.hooks.fx({ type: 'play', id: p.id, card });

    // Discard All also throws away every other card of that color
    if (card.type === 'discardAll') {
      const same = p.hand.filter(c => c.color === card.color);
      if (same.length) {
        p.hand = p.hand.filter(c => c.color !== card.color);
        this.discard.splice(this.discard.length - 1, 0, ...same);
        this.addLog(`${p.name} discarded ${same.length} more ${card.color} card${same.length > 1 ? 's' : ''}.`);
      }
      if (p.hand.length === 1 && !p.saidUno) this.unoPending = p.id;
    }

    if (!p.hand.length) return this.endRound(p, 'emptied their hand'), null;

    const twoLeft = this.active().length === 2;
    switch (card.type) {
      case 'number':
        if (sevenSwap) {
          [p.hand, target.hand] = [target.hand, p.hand];
          this.addLog(`🔁 ${p.name} swapped hands with ${target.name}.`);
          this.hooks.fx({ type: 'swap', a: p.id, b: target.id });
          for (const x of [p, target]) { x.saidUno = false; if (x.hand.length === 1) this.unoPending = x.id; }
          this.mercyCheck(p);
        } else if (this.settings.sevenZero && card.value === 0) {
          // everyone passes their hand to the next player in the direction of play
          const order = [];
          for (let i = this.current, k = 0; k < this.active().length; k++, i = this.nextIndex(i)) order.push(this.players[i]);
          const hands = order.map(x => x.hand);
          order.forEach((x, k) => { x.hand = hands[(k - 1 + order.length) % order.length]; x.saidUno = false; });
          this.addLog('🔄 Everyone passed their hand along!');
          this.hooks.fx({ type: 'rotate' });
          for (const x of order) this.mercyCheck(x);
        }
        return this.advance(1), null;
      case 'skip': return this.advance(2), null;
      case 'skipAll': this.addLog(`${p.name} skips everyone and goes again.`); return this.advance(0), null;
      case 'reverse':
        this.direction *= -1;
        return this.advance(twoLeft ? 0 : 1), null;   // with two players a Reverse works like a Skip
      case 'discardAll': return this.advance(1), null;
      case 'wildRev4':
        this.direction *= -1;
      // falls through: it is also a draw card
      case 'draw2': case 'draw4': case 'wild6': case 'wild10':
        this.pending += DRAW_VALUE[card.type];
        this.pendingMin = DRAW_VALUE[card.type];
        return this.advance(1), null;
      case 'roulette':
        this.advance(1);
        this.phase = 'roulette';
        this.addLog(`🎯 ${this.cur().name} must pick a color and flip until it comes up.`);
        return null;
    }
    return null;
  }

  doDraw(p) {
    if (this.phase !== 'play') return 'Waiting for the Color Roulette';
    if (this.cur() !== p) return 'It is not your turn';
    if (this.drawn != null) return 'You already drew — play that card or pass';
    if (this.pending) {
      const n = this.pending;
      this.pending = 0;
      this.pendingMin = 0;
      this.addLog(`${p.name} takes ${n} cards.`);
      this.give(p, n);
      this.advance(1);
      return null;
    }
    // No Mercy: keep drawing until you get a card you can play
    let n = 0;
    for (;;) {
      const c = this.drawCard();
      if (!c) break;
      p.hand.push(c);
      n++;
      if (this.canPlay(c)) { this.drawn = c.id; break; }
    }
    p.saidUno = false;
    this.addLog(`${p.name} drew ${n} card${n === 1 ? '' : 's'}.`);
    this.addLog(`You drew ${n} card${n === 1 ? '' : 's'}.`, [p.id]);
    this.hooks.fx({ type: 'draw', id: p.id, n });
    if (!this.mercyCheck(p)) { if (this.phase !== 'over') this.advance(0); return null; }
    if (this.drawn == null) this.advance(1); // pile ran dry without a playable card
    return null;
  }

  doPass(p) {
    if (this.phase !== 'play' || this.cur() !== p) return 'It is not your turn';
    if (this.drawn == null) return 'Draw first — you can only pass after drawing';
    this.addLog(`${p.name} passed.`);
    this.advance(1);
    return null;
  }

  doRoulette(p, d) {
    if (this.phase !== 'roulette' || this.cur() !== p) return 'It is not your turn to choose';
    if (!COLORS.includes(d.color)) return 'Choose a color';
    const flipped = [];
    for (;;) {
      const c = this.drawCard();
      if (!c) break;
      flipped.push(c);
      p.hand.push(c);
      if (c.color === d.color) break;
    }
    this.color = d.color;
    this.phase = 'play';
    p.saidUno = false;
    this.addLog(`🎯 ${p.name} chose ${d.color} and flipped ${flipped.length} card${flipped.length === 1 ? '' : 's'}.`);
    this.hooks.fx({ type: 'roulette', id: p.id, cards: flipped });
    if (this.mercyCheck(p) || this.phase !== 'over') this.advance(1);
    return null;
  }

  doUno(p) {
    if (p.hand.length > 2) return 'You can only call UNO with two cards or fewer';
    p.saidUno = true;
    if (this.unoPending === p.id) this.unoPending = null;
    this.addLog(`📣 ${p.name} called UNO!`);
    this.hooks.fx({ type: 'uno', id: p.id });
    return null;
  }

  doCatch(p, d) {
    const target = this.findPlayer(d.target);
    if (!target || this.unoPending !== target.id || target === p) return 'Too late — nobody to catch';
    this.unoPending = null;
    this.addLog(`🚨 ${p.name} caught ${target.name} not calling UNO! +2 cards.`);
    this.hooks.fx({ type: 'caught', id: target.id, by: p.id });
    this.give(target, 2);
    if (target.out && this.cur() === target) this.advance(0);
    return null;
  }

  // ---------- turn timer ----------
  timerKey() {
    if (this.phase !== 'play' && this.phase !== 'roulette') return null;
    return `${this.phase}:${this.current}:${this.turnSeq}:${this.drawn}`;
  }

  syncTimer() {
    const key = this.timerKey();
    if (key === this.timer.key) return;
    clearTimeout(this.timer.handle);
    this.timer = { key, handle: null, deadline: null };
    if (!key || !this.settings.turnTime) return;
    const ms = this.settings.turnTime * 1000;
    this.timer.deadline = Date.now() + ms;
    this.timer.handle = setTimeout(() => this.onTimeout(), ms);
    if (this.timer.handle.unref) this.timer.handle.unref();
  }

  // Time's up: take the penalty, or draw and play what comes, choosing your most-held color.
  onTimeout() {
    this.timer.key = null;
    const p = this.cur();
    if (!p || p.out) return this.syncTimer();
    const favourite = () => {
      const count = {};
      for (const c of p.hand) if (c.color) count[c.color] = (count[c.color] || 0) + 1;
      return COLORS.slice().sort((a, b) => (count[b] || 0) - (count[a] || 0))[0];
    };
    this.addLog(`⏱ ${p.name} ran out of time.`);
    if (this.phase === 'roulette') this.act(p.id, 'rouletteColor', { color: favourite() });
    else {
      if (this.drawn == null) this.act(p.id, 'draw');
      if (this.phase === 'play' && this.cur() === p && this.drawn != null) {
        const card = p.hand.find(c => c.id === this.drawn);
        const others = this.active().filter(x => x !== p);
        const err = this.act(p.id, 'play', { cardId: card.id, color: favourite(), target: others[0] && others[0].id });
        if (err) this.act(p.id, 'pass');
      }
    }
    this.syncTimer();
    this.hooks.changed();
  }

  // ---------- views ----------
  view(viewerId) {
    const me = this.findPlayer(viewerId);
    const base = {
      code: this.code, phase: this.phase, settings: this.settings, hostId: this.hostId, you: viewerId, spectator: !me, round: this.round,
      mercyLimit: MERCY_LIMIT,
      players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, wins: p.wins, cards: p.hand.length, out: p.out })),
      spectators: [...this.spectators.values()],
    };
    if (this.phase === 'lobby') return base;
    Object.assign(base, {
      top: this.top(),
      color: this.color,
      direction: this.direction,
      current: this.cur().id,
      pending: this.pending,
      pendingMin: this.pendingMin,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      drawn: me && this.cur() === me ? this.drawn : null,
      unoPending: this.unoPending,
      winner: this.winner,
      turnSeq: this.turnSeq,
      timeLeft: this.timer.deadline ? Math.max(0, this.timer.deadline - Date.now()) : null,
      log: this.log.filter(l => !l.to || l.to.includes(viewerId)).slice(-50),
    });
    if (me) {
      base.hand = me.hand;
      base.saidUno = !!me.saidUno;
      base.playable = this.phase === 'play' && this.cur() === me
        ? me.hand.filter(c => (this.drawn == null || c.id === this.drawn) && this.canPlay(c)).map(c => c.id)
        : [];
    }
    if (this.phase === 'over') base.hands = Object.fromEntries(this.players.map(p => [p.id, p.hand]));
    return base;
  }

  destroy() { clearTimeout(this.timer.handle); }
}

module.exports = { Game, buildDeck, COLORS, DRAW_VALUE, MERCY_LIMIT, cardName };
