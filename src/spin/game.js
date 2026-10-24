// UNO Spin rules engine: classic UNO plus the Spin wheel, in both the classic (2005) and the
// new (2025) wheel editions. The server is authoritative; view(playerId) hides other hands.
const crypto = require('crypto');

const COLORS = ['red', 'yellow', 'green', 'blue'];
const TURN_TIMES = [0, 15, 30, 45, 60];
const TARGETS = [250, 500, 1000];
const RACE_MS = 6000;      // how long everyone has to hit "UNO Spin!"
const SHOW_TURNS = 2;      // a shown hand stays visible for this many turns
const PLAYER_COLORS = ['#ff3b5c', '#3b8cff', '#2fd17a', '#ffc93b', '#b06bff', '#ff8a3b', '#3bd9ff', '#ff6bd5', '#a3e635', '#f5f5f5'];

// Wheel spaces in order around the wheel.
const WHEELS = {
  classic: ['unoSpin', 'discardColor', 'drawBlue', 'drawRed', 'war', 'discardNumber', 'showHand', 'tradeHands', 'almostUno'],
  new: ['colorDraw:red', 'twoX', 'colorDraw:blue', 'colorDiscard', 'colorDraw:green', 'swapHands', 'colorDraw:yellow', 'wildColorDraw'],
};
const SPACE_NAMES = {
  unoSpin: 'UNO Spin', discardColor: 'Discard Color', drawBlue: 'Draw Blue', drawRed: 'Draw Red', war: 'War', discardNumber: 'Discard Number',
  showHand: 'Show Hand', tradeHands: 'Trade Hands', almostUno: 'Almost UNO', 'colorDraw:red': 'Red Draw', 'colorDraw:blue': 'Blue Draw',
  'colorDraw:green': 'Green Draw', 'colorDraw:yellow': 'Yellow Draw', twoX: '2X', colorDiscard: 'Color Discard', swapHands: 'Swap Hands', wildColorDraw: 'Wild Color Draw',
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The 112-card UNO Spin deck.
function buildDeck() {
  const cards = [];
  let id = 0;
  const add = (type, color, value, spin = false) => cards.push({ id: id++, type, color, value, spin });
  for (const color of COLORS) {
    for (let n = 0; n <= 5; n++) add('number', color, n);
    for (let n = 6; n <= 9; n++) { add('number', color, n); add('number', color, n); }
    for (let n = 1; n <= 5; n++) add('number', color, n, true); // Spin cards
    for (let k = 0; k < 2; k++) { add('draw2', color); add('reverse', color); add('skip', color); }
  }
  for (let k = 0; k < 4; k++) { add('wild', null); add('wild', null, undefined, true); add('wild4', null); }
  return cards;
}

const NAMES = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' };
const cardName = c => (c.type === 'number' ? `${c.color} ${c.value}${c.spin ? ' (Spin)' : ''}` : `${c.color ? c.color + ' ' : ''}${NAMES[c.type]}${c.spin ? ' Spin' : ''}`);
const isWild = c => c.type === 'wild' || c.type === 'wild4';
const points = c => (c.type === 'number' ? c.value : isWild(c) ? 50 : 20);

class Game {
  constructor(code, settings = {}, hooks = {}) {
    this.code = code;
    this.settings = {
      edition: settings.edition === 'new' ? 'new' : 'classic',
      turnTime: TURN_TIMES.includes(settings.turnTime) ? settings.turnTime : 30,
      target: TARGETS.includes(settings.target) ? settings.target : 500,
    };
    this.spinMs = settings.spinMs != null ? settings.spinMs : 2800; // wheel animation before the result applies
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
  get hostId() { return this.host && this.findPlayer(this.host) ? this.host : this.players[0] && this.players[0].id; }
  get between() { return this.phase === 'lobby' || this.phase === 'roundOver' || this.phase === 'over'; }

  addPlayer(id, name) {
    const existing = this.findPlayer(id);
    if (existing) { existing.connected = true; existing.name = name || existing.name; this.hooks.changed(); return { ok: true }; }
    if (!this.between) { this.spectators.set(id, name); this.hooks.changed(); return { ok: true, spectator: true }; }
    if (this.players.length >= 10) return { error: 'This game is full (10 players max)' };
    if (!this.players.length) this.host = id;
    this.spectators.delete(id);
    const used = new Set(this.players.map(p => p.color));
    this.players.push({ id, name, color: PLAYER_COLORS.find(c => !used.has(c)), connected: true, score: 0, hand: [], saidUno: false });
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
    if (this.phase !== 'lobby' && this.phase !== 'over') return 'Settings can only change before a game';
    if (id !== this.hostId) return 'Only the host can change settings';
    if (s.edition === 'classic' || s.edition === 'new') this.settings.edition = s.edition;
    if (s.turnTime != null && TURN_TIMES.includes(+s.turnTime)) this.settings.turnTime = +s.turnTime;
    if (s.target != null && TARGETS.includes(+s.target)) this.settings.target = +s.target;
    this.hooks.changed();
    return null;
  }

  start(id) {
    if (!this.between) return 'A round is already in progress';
    if (id !== this.hostId) return 'Only the host can start';
    if (this.players.length < 2) return 'You need at least 2 players';
    if (this.phase !== 'roundOver') { // a fresh game
      for (const p of this.players) p.score = 0;
      this.round = 0;
      this.champion = null;
      shuffle(this.players);
    }
    this.round++;
    this.deck = shuffle(buildDeck());
    this.discard = [];
    for (const p of this.players) { p.hand = []; p.saidUno = false; }
    this.direction = 1;
    this.current = (this.round - 1) % this.players.length;
    this.drawn = null;
    this.unoPending = new Set();
    this.twoX = false;
    this.turnPlays = 0;
    this.turnFx = { skip: 0, draw: 0 };
    this.spin = null;
    this.pick = null;
    this.challenge = null;
    this.shown = null;
    this.winner = null;
    this.turnSeq = 0;
    for (let k = 0; k < 7; k++) for (const p of this.players) p.hand.push(this.deck.pop());
    // flip until a plain number card starts the pile
    let top;
    while ((top = this.deck.pop()).type !== 'number' || top.spin) this.deck.unshift(top);
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
  idx(p) { return this.players.indexOf(p); }
  nextIndex(from = this.current, steps = 1) {
    const n = this.players.length;
    return (((from + this.direction * steps) % n) + n) % n;
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

  give(p, n) {
    let got = 0;
    for (let k = 0; k < n; k++) { const c = this.drawCard(); if (!c) break; p.hand.push(c); got++; }
    if (got) { p.saidUno = false; this.unoPending.delete(p.id); }
    this.hooks.fx({ type: 'draw', id: p.id, n: got });
    return got;
  }

  // draw until `match` (keeping everything); returns the cards drawn
  drawUntil(p, match) {
    const got = [];
    for (;;) { const c = this.drawCard(); if (!c) break; got.push(c); p.hand.push(c); if (match(c)) break; }
    p.saidUno = false;
    this.unoPending.delete(p.id);
    this.hooks.fx({ type: 'draw', id: p.id, n: got.length });
    return got;
  }

  canPlay(card) {
    if (isWild(card)) return true;
    const top = this.top();
    if (card.color === this.color) return true;
    if (card.type === 'number') return top.type === 'number' && top.value === card.value;
    return card.type === top.type;
  }

  checkUno(p) {
    if (p.hand.length === 1 && !p.saidUno) this.unoPending.add(p.id);
    if (p.hand.length !== 1) { p.saidUno = false; this.unoPending.delete(p.id); }
  }

  // put cards from a hand onto the discard pile, in order; the last one is the new top
  discardCards(p, cards, color) {
    for (const c of cards) { p.hand.splice(p.hand.indexOf(c), 1); this.discard.push(c); }
    if (cards.length) this.color = isWild(cards[cards.length - 1]) ? color : cards[cards.length - 1].color;
    this.checkUno(p);
  }

  endRound(w) {
    // the winner scores every card left in the other hands
    let pts = 0;
    for (const p of this.players) if (p !== w) pts += p.hand.reduce((s, c) => s + points(c), 0);
    w.score += pts;
    this.winner = w.id;
    this.roundPoints = pts;
    this.unoPending.clear();
    this.spin = null; this.pick = null; this.challenge = null;
    if (w.score >= this.settings.target) {
      this.phase = 'over';
      this.champion = w.id;
      this.addLog(`🏆 ${w.name} wins round ${this.round} (+${pts}) and the game with ${w.score} points!`);
    } else {
      this.phase = 'roundOver';
      this.addLog(`🏆 ${w.name} wins round ${this.round} and scores ${pts} (total ${w.score}).`);
    }
    this.hooks.fx({ type: 'win', id: w.id, points: pts, game: this.phase === 'over' });
    return true;
  }

  // The current player's turn ends: apply skips and draw penalties, then move on.
  endTurn() {
    const fx = this.turnFx;
    let steps = 1 + fx.skip;
    if (fx.draw) {
      const victim = this.players[this.nextIndex()];
      this.give(victim, fx.draw);
      this.addLog(`${victim.name} draws ${fx.draw} and loses their turn.`);
      steps++;
    }
    this.current = this.nextIndex(this.current, steps);
    this.turnFx = { skip: 0, draw: 0 };
    this.turnPlays = 0;
    this.drawn = null;
    this.phase = 'play';
    this.turnSeq++;
    if (this.shown && this.turnSeq > this.shown.until) this.shown = null;
  }

  // ---------- actions ----------
  act(id, type, d = {}) {
    const p = this.findPlayer(id);
    if (!p) return 'You are not a player in this game';
    if (this.between) return this.phase === 'lobby' ? 'The game has not started' : 'The round is over';
    if (d === null || typeof d !== 'object') d = {};
    // the UNO catch window closes once someone else moves
    if (this.unoPending.size && type !== 'catch' && type !== 'uno' && type !== 'unoSpin') {
      for (const pid of [...this.unoPending]) if (pid !== id) this.unoPending.delete(pid);
    }
    const handler = {
      play: this.doPlay, draw: this.doDraw, pass: this.doPass, spin: this.doSpin, challenge: this.doChallenge,
      discard: this.doDiscard, chooseColor: this.doChooseColor, swap: this.doSwap, unoSpin: this.doUnoSpin, uno: this.doUno, catch: this.doCatch,
    }[type];
    if (!handler) return 'Unknown action';
    const err = handler.call(this, p, d);
    if (!err) { this.syncTimer(); this.hooks.changed(); }
    return err || null;
  }

  doPlay(p, d) {
    if (this.phase !== 'play' && this.phase !== 'second') return 'Finish the current action first';
    if (this.cur() !== p) return 'It is not your turn';
    const card = p.hand.find(c => c.id === Number(d.cardId));
    if (!card) return 'You do not have that card';
    if (this.drawn != null && card.id !== this.drawn) return 'You can only play the card you just drew (or pass)';
    if (!this.canPlay(card)) return 'That card does not match';
    if (this.phase === 'second' && card.type === 'wild4') return 'A Wild Draw Four has to be your first card';
    if (isWild(card) && !COLORS.includes(d.color)) return 'Choose a color';

    const prevColor = this.color;
    p.hand.splice(p.hand.indexOf(card), 1);
    this.discard.push(card);
    this.color = isWild(card) ? d.color : card.color;
    this.checkUno(p);
    this.drawn = null;
    this.turnPlays++;
    this.addLog(`${p.name} played ${cardName(card)}${isWild(card) ? ` → ${d.color}` : ''}.`);
    this.hooks.fx({ type: 'play', id: p.id, card });

    if (!p.hand.length) {
      // a last Draw Two / Wild Draw Four still makes the next player draw before scoring
      const extra = this.turnFx.draw + (card.type === 'draw2' ? 2 : card.type === 'wild4' ? 4 : 0);
      if (extra) this.give(this.players[this.nextIndex()], extra);
      return this.endRound(p), null;
    }

    if (card.type === 'skip') this.turnFx.skip++;
    else if (card.type === 'reverse') { this.direction *= -1; if (this.players.length === 2) this.turnFx.skip++; }
    else if (card.type === 'draw2') this.turnFx.draw += 2;
    else if (card.type === 'wild4') {
      // only legal with no card of the current color; the next player may accept or challenge
      const target = this.players[this.nextIndex()];
      this.challenge = { by: p.id, target: target.id, guilty: p.hand.some(c => c.color === prevColor) };
      this.phase = 'challenge';
      this.addLog(`${target.name}: accept the Wild Draw Four, or challenge it?`);
      return null;
    }

    if (card.spin) {
      if (this.twoX) { this.twoX = false; this.addLog('2X is over.'); }
      if (this.settings.edition === 'classic') {
        // classic: the next player spins instead of taking a normal turn
        this.endTurn();
        this.phase = 'spin';
        this.spin = { spinner: this.cur().id, by: p.id };
      } else {
        this.phase = 'spin';
        this.spin = { spinner: p.id, by: p.id };
      }
      this.addLog(`🌀 ${this.findPlayer(this.spin.spinner).name} must spin the wheel!`);
      return null;
    }

    // 2X: you may play a second card on top of your first
    if (this.twoX && this.turnPlays === 1) { this.phase = 'second'; return null; }
    this.endTurn();
    return null;
  }

  doDraw(p) {
    if (this.phase !== 'play') return this.phase === 'second' ? 'Play a second card or finish your turn' : 'Finish the current action first';
    if (this.cur() !== p) return 'It is not your turn';
    if (this.drawn != null) return 'You already drew — play that card or pass';
    const c = this.drawCard();
    if (!c) { this.endTurn(); return null; }
    p.hand.push(c);
    p.saidUno = false;
    this.unoPending.delete(p.id);
    this.addLog(`${p.name} drew a card.`);
    this.hooks.fx({ type: 'draw', id: p.id, n: 1 });
    if (this.canPlay(c)) this.drawn = c.id; else this.endTurn();
    return null;
  }

  doPass(p) {
    if (this.cur() !== p) return 'It is not your turn';
    if (this.phase === 'second') { this.endTurn(); return null; }
    if (this.phase !== 'play' || this.drawn == null) return 'Draw first — you can only pass after drawing';
    this.endTurn();
    return null;
  }

  doChallenge(p, d) {
    const ch = this.challenge;
    if (this.phase !== 'challenge' || !ch || ch.target !== p.id) return 'Nothing to challenge';
    const by = this.findPlayer(ch.by);
    this.challenge = null;
    // from here on it is the challenged player's move
    this.current = this.idx(p);
    this.turnFx = { skip: 0, draw: 0 };
    this.turnPlays = 0;
    this.drawn = null;
    if (!d.challenge) {
      this.give(p, 4);
      this.addLog(`${p.name} accepts and draws 4.`);
      this.endTurn(); // and loses their turn
    } else if (ch.guilty) {
      this.give(by, 4);
      this.addLog(`🚨 Challenge won! ${by.name} had a matching color and draws 4. ${p.name} plays on.`);
      this.hooks.fx({ type: 'challenge', won: true, id: p.id });
      this.phase = 'play';
      this.turnSeq++;
    } else {
      this.give(p, 6);
      this.addLog(`Challenge failed — ${p.name} draws 6 and loses their turn.`);
      this.hooks.fx({ type: 'challenge', won: false, id: p.id });
      this.endTurn();
    }
    return null;
  }

  // ---------- the wheel ----------
  doSpin(p) {
    if (this.phase !== 'spin' || this.spin.spinner !== p.id) return 'It is not your spin';
    const wheel = WHEELS[this.settings.edition];
    const index = crypto.randomInt(wheel.length);
    this.spin.space = wheel[index];
    this.spin.index = index;
    this.phase = 'spinning';
    this.addLog(`🌀 ${p.name} spins… ${SPACE_NAMES[this.spin.space]}!`);
    this.hooks.fx({ type: 'spin', id: p.id, space: this.spin.space, index, edition: this.settings.edition });
    if (!this.spinMs) this.resolveSpin();
    return null;
  }

  // the turn that the spin belongs to is over; play goes on after `from`
  finishSpin(from) {
    this.spin = null;
    this.pick = null;
    this.current = this.idx(from);
    this.endTurn(); // any Skip / Draw Two played earlier this turn still applies
  }

  resolveSpin() {
    if (this.phase !== 'spinning') return;
    const p = this.findPlayer(this.spin.spinner);
    const space = this.spin.space;
    const hasColored = p.hand.some(c => c.color);
    const ask = mode => { this.phase = 'pick'; this.pick = { mode, player: p.id }; };
    switch (space) {
      case 'almostUno': return p.hand.length > 2 ? ask('almostUno') : this.finishSpin(p);
      case 'discardNumber': return p.hand.some(c => c.type === 'number') ? ask('discardNumber') : this.finishSpin(p);
      case 'discardColor': return hasColored ? ask('discardColor') : this.finishSpin(p);
      case 'drawRed': case 'drawBlue': {
        const color = space === 'drawRed' ? 'red' : 'blue';
        const got = this.drawUntil(p, c => c.color === color || isWild(c));
        this.addLog(`${p.name} drew ${got.length} card${got.length === 1 ? '' : 's'} hunting for ${color}.`);
        return this.finishSpin(p);
      }
      case 'showHand':
        this.shown = { id: p.id, cards: p.hand.slice(), until: this.turnSeq + SHOW_TURNS };
        this.addLog(`👀 ${p.name} shows their hand to everyone.`);
        return this.finishSpin(p);
      case 'war': return this.war(p);
      case 'unoSpin':
        this.phase = 'race';
        this.addLog('⚡ Race! First to hit "UNO Spin!" discards any card.');
        return null;
      case 'tradeHands': {
        // everyone passes their hand to the player on their left
        const hands = this.players.map(x => x.hand);
        this.players.forEach((x, i) => { x.hand = hands[(i - 1 + hands.length) % hands.length]; x.saidUno = false; });
        this.unoPending.clear();
        for (const x of this.players) this.checkUno(x);
        this.addLog('🔄 Everyone passed their hand to the left!');
        this.hooks.fx({ type: 'trade' });
        return this.finishSpin(p);
      }
      case 'twoX':
        this.twoX = true;
        this.addLog('✌️ 2X! Everyone may play two cards a turn until someone spins.');
        return this.finishSpin(p);
      case 'wildColorDraw': return ask('wildColorDraw');
      case 'colorDiscard': return hasColored ? ask('colorDiscard') : this.finishSpin(p);
      case 'swapHands': return ask('swapHands');
      default: {
        const color = space.split(':')[1];
        const got = this.drawUntil(p, c => c.color === color);
        this.addLog(`${p.name} drew ${got.length} card${got.length === 1 ? '' : 's'} until ${color} came up.`);
        return this.finishSpin(p);
      }
    }
  }

  // War: everyone reveals their highest number; the best one is played, ties go to the next-highest.
  war(spinner) {
    const nums = p => p.hand.filter(c => c.type === 'number').map(c => c.value).sort((a, b) => b - a);
    let field = this.players.filter(p => nums(p).length);
    if (!field.length) { this.addLog('War: nobody has a number card.'); return this.finishSpin(spinner); }
    this.addLog(`⚔️ War! ${field.map(p => `${p.name}: ${nums(p)[0]}`).join(', ')}.`);
    for (let k = 0; field.length > 1; k++) {
      const vals = field.map(p => nums(p)[k] ?? -1);
      const best = Math.max(...vals);
      if (best < 0) break; // identical hands all the way down: first in the field wins
      field = field.filter((p, i) => vals[i] === best);
    }
    const w = field[0];
    const card = w.hand.filter(c => c.type === 'number').sort((a, b) => b.value - a.value)[0];
    this.discardCards(w, [card]);
    this.addLog(`${w.name} wins the war and plays ${cardName(card)}.`);
    this.hooks.fx({ type: 'war', id: w.id, card });
    if (!w.hand.length) return this.endRound(w);
    return this.finishSpin(w);
  }

  doUnoSpin(p) {
    if (this.phase !== 'race') return 'Too late!';
    this.phase = 'pick';
    this.pick = { mode: 'unoSpin', player: p.id };
    this.addLog(`⚡ ${p.name} hit "UNO Spin!" first and may discard any card.`);
    this.hooks.fx({ type: 'unoSpin', id: p.id });
    return null;
  }

  doDiscard(p, d) {
    const pk = this.pick;
    if (this.phase !== 'pick' || !pk || pk.player !== p.id || !['almostUno', 'discardNumber', 'discardColor', 'unoSpin'].includes(pk.mode)) return 'Nothing to discard right now';
    const ids = Array.isArray(d.cards) ? d.cards.map(Number) : [];
    if (new Set(ids).size !== ids.length) return 'Each card only once';
    const cards = ids.map(id => p.hand.find(c => c.id === id));
    if (cards.some(c => !c)) return 'You do not have those cards';
    if (pk.mode === 'almostUno' && cards.length !== p.hand.length - 2) return `Discard until you have 2 cards left (${p.hand.length - 2} cards)`;
    if (pk.mode === 'unoSpin' && cards.length !== 1) return 'Discard exactly one card';
    if (pk.mode === 'discardNumber' && (cards.some(c => c.type !== 'number') || new Set(cards.map(c => c.value)).size > 1)) return 'Pick number cards that all share one number';
    if (pk.mode === 'discardColor' && (cards.some(c => !c.color) || new Set(cards.map(c => c.color)).size > 1)) return 'Pick cards that all share one color (no wilds)';
    const last = cards[cards.length - 1];
    if (last && isWild(last) && !COLORS.includes(d.color)) return 'Choose a color for the wild you put on top';
    this.discardCards(p, cards, d.color);
    this.addLog(cards.length ? `${p.name} discarded ${cards.length} card${cards.length === 1 ? '' : 's'}${last ? `, ending on ${cardName(last)}` : ''}.` : `${p.name} kept their cards.`);
    if (cards.length) this.hooks.fx({ type: 'discard', id: p.id, n: cards.length, card: last });
    if (!p.hand.length) return this.endRound(p), null;
    // after the UNO Spin race, play continues after whoever discarded
    this.finishSpin(pk.mode === 'unoSpin' ? p : this.findPlayer(this.spin.spinner));
    return null;
  }

  doChooseColor(p, d) {
    const pk = this.pick;
    if (this.phase !== 'pick' || !pk || pk.player !== p.id || !['wildColorDraw', 'colorDiscard'].includes(pk.mode)) return 'Nothing to choose';
    if (!COLORS.includes(d.color)) return 'Choose a color';
    if (pk.mode === 'wildColorDraw') {
      const got = this.drawUntil(p, c => c.color === d.color);
      this.addLog(`${p.name} chose ${d.color} and drew ${got.length} card${got.length === 1 ? '' : 's'}.`);
    } else {
      // matching cards go to the bottom of the discard pile, so the top card stays
      const same = p.hand.filter(c => c.color === d.color);
      p.hand = p.hand.filter(c => c.color !== d.color);
      this.discard.unshift(...same);
      this.checkUno(p);
      this.addLog(`${p.name} discarded all ${same.length} ${d.color} card${same.length === 1 ? '' : 's'}.`);
      this.hooks.fx({ type: 'discard', id: p.id, n: same.length });
      if (!p.hand.length) return this.endRound(p), null;
    }
    this.finishSpin(p);
    return null;
  }

  doSwap(p, d) {
    const pk = this.pick;
    if (this.phase !== 'pick' || !pk || pk.player !== p.id || pk.mode !== 'swapHands') return 'Nothing to swap';
    const t = this.findPlayer(d.target);
    if (!t || t === p) return 'Choose another player';
    [p.hand, t.hand] = [t.hand, p.hand];
    p.saidUno = t.saidUno = false;
    this.checkUno(p); this.checkUno(t);
    this.addLog(`🔁 ${p.name} swapped hands with ${t.name}.`);
    this.hooks.fx({ type: 'swap', a: p.id, b: t.id });
    this.finishSpin(p);
    return null;
  }

  doUno(p) {
    if (p.hand.length > 2) return 'You can only call UNO with two cards or fewer';
    p.saidUno = true;
    this.unoPending.delete(p.id);
    this.addLog(`📣 ${p.name} called UNO!`);
    this.hooks.fx({ type: 'uno', id: p.id });
    return null;
  }

  doCatch(p, d) {
    const t = this.findPlayer(d.target);
    if (!t || t === p || !this.unoPending.has(t.id)) return 'Too late — nobody to catch';
    this.unoPending.delete(t.id);
    this.give(t, 2);
    this.addLog(`🚨 ${p.name} caught ${t.name} not calling UNO! +2 cards.`);
    this.hooks.fx({ type: 'caught', id: t.id, by: p.id });
    return null;
  }

  // ---------- timers ----------
  timerKey() {
    if (this.between) return null;
    const pk = this.pick ? `${this.pick.mode}:${this.pick.player}` : '';
    return `${this.phase}:${this.current}:${this.turnSeq}:${this.drawn}:${pk}`;
  }

  syncTimer() {
    const key = this.timerKey();
    if (key === this.timer.key) return;
    clearTimeout(this.timer.handle);
    this.timer = { key, handle: null, deadline: null };
    if (!key) return;
    // the wheel animation and the UNO Spin race run on their own clocks
    let ms = this.settings.turnTime * 1000;
    if (this.phase === 'spinning') ms = this.spinMs;
    else if (this.phase === 'race') ms = RACE_MS;
    if (!ms) return;
    this.timer.deadline = Date.now() + ms;
    this.timer.handle = setTimeout(() => this.onTimeout(), ms);
    if (this.timer.handle.unref) this.timer.handle.unref();
  }

  // the player we're waiting on gets a sensible automatic move
  onTimeout() {
    this.timer.key = null;
    const favourite = p => {
      const count = {};
      for (const c of p.hand) if (c.color) count[c.color] = (count[c.color] || 0) + 1;
      return COLORS.slice().sort((a, b) => (count[b] || 0) - (count[a] || 0))[0];
    };
    if (this.phase === 'spinning') this.resolveSpin();
    else if (this.phase === 'race') { this.addLog('Nobody hit "UNO Spin!" in time.'); this.finishSpin(this.findPlayer(this.spin.spinner)); }
    else if (this.phase === 'challenge') this.act(this.challenge.target, 'challenge', { challenge: false });
    else if (this.phase === 'spin') this.act(this.spin.spinner, 'spin');
    else if (this.phase === 'pick') {
      const p = this.findPlayer(this.pick.player);
      const byPoints = p.hand.slice().sort((a, b) => points(b) - points(a));
      this.addLog(`⏱ ${p.name} ran out of time.`);
      switch (this.pick.mode) {
        case 'almostUno': { const cards = byPoints.slice(0, p.hand.length - 2).reverse(); this.act(p.id, 'discard', { cards: cards.map(c => c.id), color: favourite(p) }); break; }
        case 'unoSpin': this.act(p.id, 'discard', { cards: [byPoints[0].id], color: favourite(p) }); break;
        case 'discardNumber': {
          const counts = {};
          for (const c of p.hand) if (c.type === 'number') counts[c.value] = (counts[c.value] || 0) + 1;
          const v = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
          this.act(p.id, 'discard', { cards: p.hand.filter(c => c.type === 'number' && c.value === v).map(c => c.id) });
          break;
        }
        case 'discardColor': { const col = favourite(p); this.act(p.id, 'discard', { cards: p.hand.filter(c => c.color === col).map(c => c.id) }); break; }
        case 'wildColorDraw': case 'colorDiscard': this.act(p.id, 'chooseColor', { color: favourite(p) }); break;
        case 'swapHands': {
          const t = this.players.filter(x => x !== p).sort((a, b) => a.hand.length - b.hand.length)[0];
          this.act(p.id, 'swap', { target: t.id });
          break;
        }
      }
    } else {
      const p = this.cur();
      this.addLog(`⏱ ${p.name} ran out of time.`);
      if (this.phase === 'second') this.act(p.id, 'pass');
      else if (this.drawn != null) {
        if (this.act(p.id, 'play', { cardId: this.drawn, color: favourite(p) })) this.act(p.id, 'pass');
      } else {
        this.act(p.id, 'draw');
        if (this.cur() === p && this.drawn != null && this.act(p.id, 'play', { cardId: this.drawn, color: favourite(p) })) this.act(p.id, 'pass');
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
      wheel: WHEELS[this.settings.edition], spaceNames: SPACE_NAMES,
      players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, score: p.score, cards: p.hand.length })),
      spectators: [...this.spectators.values()],
      champion: this.champion || null,
    };
    if (this.phase === 'lobby') return base;
    Object.assign(base, {
      top: this.top(), color: this.color, direction: this.direction, current: this.cur().id,
      deckCount: this.deck.length, twoX: this.twoX, turnPlays: this.turnPlays,
      spin: this.spin, pick: this.pick && { mode: this.pick.mode, player: this.pick.player },
      challenge: this.challenge && { by: this.challenge.by, target: this.challenge.target },
      shown: this.shown && { id: this.shown.id, cards: this.shown.cards },
      unoPending: [...this.unoPending], winner: this.winner, roundPoints: this.roundPoints || 0, turnSeq: this.turnSeq,
      timeLeft: this.timer.deadline ? Math.max(0, this.timer.deadline - Date.now()) : null,
      log: this.log.filter(l => !l.to || l.to.includes(viewerId)).slice(-50),
    });
    if (me) {
      base.hand = me.hand;
      base.saidUno = !!me.saidUno;
      base.drawn = this.cur() === me ? this.drawn : null;
      base.playable = (this.phase === 'play' || this.phase === 'second') && this.cur() === me
        ? me.hand.filter(c => (this.drawn == null || c.id === this.drawn) && this.canPlay(c) && !(this.phase === 'second' && c.type === 'wild4')).map(c => c.id)
        : [];
    }
    if (this.between) base.hands = Object.fromEntries(this.players.map(p => [p.id, p.hand]));
    return base;
  }

  destroy() { clearTimeout(this.timer.handle); }
}

module.exports = { Game, buildDeck, WHEELS, COLORS, points, cardName };
