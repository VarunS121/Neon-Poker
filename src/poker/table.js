// No-limit Texas Hold'em table engine.
const crypto = require('crypto');
const { evaluate, compare } = require('./handEval');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const MAX_SEATS = 9;
const COLORS = ['#ff2d95', '#00e5ff', '#a46bff', '#39ff88', '#ffb800', '#ff6b3d', '#4d7cff', '#ff4dd2', '#2dffd5'];

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

class Table {
  constructor(code, settings, hooks = {}) {
    this.code = code;
    this.settings = settings; // { smallBlind, bigBlind, startingStack, turnTime }
    this.hooks = hooks;       // { changed(), fx(obj), log(text) }
    this.seats = Array(MAX_SEATS).fill(null);
    this.hostId = null;
    this.started = false;
    this.phase = 'waiting';   // waiting | preflop | flop | turn | river | showdown | complete
    this.handNumber = 0;
    this.dealerSeat = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.board = [];
    this.deck = [];
    this.currentSeat = -1;
    this.currentBet = 0;
    this.minRaise = settings.bigBlind;
    this.reopenId = 0;
    this.turnTimer = null;
    this.turnDeadline = 0;
    this.turnTotal = 0;
    this.nextHandTimer = null;
    this.nextHandAt = 0;
    this.runoutTimer = null;
    this.result = null;
  }

  // ---------- helpers ----------
  changed() { this.hooks.changed && this.hooks.changed(); }
  fx(obj) { this.hooks.fx && this.hooks.fx(obj); }
  log(text) { this.hooks.log && this.hooks.log(text); }

  get players() { return this.seats.filter(Boolean); }
  findPlayer(id) { return this.seats.find(p => p && p.id === id) || null; }
  isBetting() { return ['preflop', 'flop', 'turn', 'river'].includes(this.phase); }
  live(p) { return p && p.inHand && !p.folded; }
  canAct(p) { return this.live(p) && !p.allIn; }

  nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (((from + i) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if (p && pred(p)) return s;
    }
    return -1;
  }

  needsToAct(p) {
    if (!this.canAct(p)) return false;
    if (p.bet < this.currentBet) return true;
    if (p.acted) return false;
    // nobody else can respond — no reason to act
    return this.seats.some(o => o && o !== p && this.canAct(o));
  }

  canRaise(p) {
    return this.canAct(p) && p.lastReopen !== this.reopenId && p.chips > this.currentBet - p.bet;
  }

  eligibleForHand(p) { return p && p.chips > 0 && !p.sittingOut && p.connected && !p.leaving; }
  eligibleCount() { return this.players.filter(p => this.eligibleForHand(p)).length; }

  // ---------- players ----------
  addPlayer(id, name) {
    const existing = this.findPlayer(id);
    if (existing) {
      existing.name = name || existing.name;
      existing.connected = true;
      existing.leaving = false;
      if (!this.hostId || !this.findPlayer(this.hostId)) this.hostId = id;
      this.maybeStart();
      this.changed();
      return existing.seat;
    }
    const seat = this.pickSeat();
    if (seat === -1) return -1;
    this.seats[seat] = {
      id, name, seat, color: COLORS[seat],
      chips: this.settings.startingStack, buyIns: 1,
      connected: true, sittingOut: false, leaving: false, inHand: false,
      hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, acted: false,
      lastReopen: -1, lastAction: null, showCards: false, timeouts: 0,
    };
    if (!this.hostId || !this.findPlayer(this.hostId)) this.hostId = id;
    this.log(`${name} sat down`);
    this.maybeStart();
    this.changed();
    return seat;
  }

  // spread players around the table: choose the empty seat farthest from everyone
  pickSeat() {
    const taken = this.seats.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
    let best = -1, bestDist = -1;
    for (let i = 0; i < MAX_SEATS; i++) {
      if (this.seats[i]) continue;
      const d = taken.length ? Math.min(...taken.map(t => Math.min(Math.abs(t - i), MAX_SEATS - Math.abs(t - i)))) : 99;
      if (d > bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  setConnected(id, connected) {
    const p = this.findPlayer(id);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.currentSeat === p.seat && this.isBetting()) {
      const remaining = this.turnDeadline - Date.now();
      if (remaining > 6000 || !this.settings.turnTime) this.startTurnTimer(p.seat, 6000);
    }
    if (connected) this.maybeStart();
    this.changed();
  }

  removePlayer(id) {
    const p = this.findPlayer(id);
    if (!p) return;
    this.log(`${p.name} left the table`);
    if (this.live(p) && this.isBetting()) {
      if (this.currentSeat === p.seat) { this.act(id, 'fold'); }
      else { p.folded = true; p.lastAction = { type: 'fold' }; this.checkUncontested(); }
    }
    if (p.inHand && this.phase !== 'waiting' && this.phase !== 'complete') p.leaving = true;
    else this.seats[p.seat] = null;
    if (this.hostId === id) {
      const next = this.players.find(o => !o.leaving && o.connected) || this.players.find(o => !o.leaving);
      this.hostId = next ? next.id : null;
    }
    this.changed();
  }

  setSittingOut(id, value) {
    const p = this.findPlayer(id);
    if (!p) return;
    p.sittingOut = !!value;
    if (!value) p.timeouts = 0;
    this.maybeStart();
    this.changed();
  }

  rebuy(id) {
    const p = this.findPlayer(id);
    if (!p) return 'Not seated';
    if (p.chips > 0) return 'You still have chips';
    if (this.live(p) && this.isBetting()) return 'Wait for the hand to finish';
    p.chips += this.settings.startingStack;
    p.buyIns += 1;
    this.log(`${p.name} rebought for ${this.settings.startingStack.toLocaleString()}`);
    this.maybeStart();
    this.changed();
    return null;
  }

  startGame(id) {
    if (id !== this.hostId) return 'Only the host can start the game';
    if (this.started) return 'Game already started';
    if (this.eligibleCount() < 2) return 'Need at least 2 players';
    this.started = true;
    this.log('Game started — good luck!');
    this.startHand();
    return null;
  }

  maybeStart() {
    if (this.started && this.phase === 'waiting' && !this.nextHandTimer && this.eligibleCount() >= 2) {
      this.scheduleNext(2500);
    }
  }

  scheduleNext(delay) {
    clearTimeout(this.nextHandTimer);
    this.nextHandAt = Date.now() + delay;
    this.nextHandTimer = setTimeout(() => { this.nextHandTimer = null; this.startHand(); }, delay);
  }

  // ---------- hand flow ----------
  startHand() {
    clearTimeout(this.nextHandTimer); this.nextHandTimer = null; this.nextHandAt = 0;
    clearTimeout(this.runoutTimer); clearTimeout(this.turnTimer);
    for (let i = 0; i < MAX_SEATS; i++) if (this.seats[i] && this.seats[i].leaving) this.seats[i] = null;

    for (const p of this.players) {
      Object.assign(p, {
        inHand: this.eligibleForHand(p), hole: [], bet: 0, totalBet: 0, folded: false,
        allIn: false, acted: false, lastReopen: -1, lastAction: null, showCards: false,
      });
    }
    const inHand = this.players.filter(p => p.inHand);
    this.board = [];
    this.currentSeat = -1;
    if (inHand.length < 2) {
      this.phase = 'waiting';
      this.changed();
      return;
    }
    this.handNumber++;
    this.result = null;
    this.deck = newDeck();
    this.reopenId = 0;
    const bb = this.settings.bigBlind, sb = this.settings.smallBlind;

    this.dealerSeat = this.nextSeat(this.dealerSeat, p => p.inHand);
    if (inHand.length === 2) {
      this.sbSeat = this.dealerSeat;
      this.bbSeat = this.nextSeat(this.dealerSeat, p => p.inHand);
    } else {
      this.sbSeat = this.nextSeat(this.dealerSeat, p => p.inHand);
      this.bbSeat = this.nextSeat(this.sbSeat, p => p.inHand);
    }
    this.postBlind(this.sbSeat, sb, 'sb');
    this.postBlind(this.bbSeat, bb, 'bb');
    this.currentBet = bb;
    this.minRaise = bb;

    for (let r = 0; r < 2; r++) {
      let s = this.sbSeat;
      for (let k = 0; k < inHand.length; k++) {
        this.seats[s].hole.push(this.deck.pop());
        s = this.nextSeat(s, p => p.inHand);
      }
    }
    this.phase = 'preflop';
    this.fx({ kind: 'deal', count: inHand.length * 2 });

    const first = this.nextSeat(this.bbSeat, p => this.needsToAct(p));
    if (first === -1) return this.endStreet();
    this.setTurn(first);
  }

  postBlind(seat, amount, type) {
    const p = this.seats[seat];
    const amt = Math.min(amount, p.chips);
    this.commit(p, amt);
    p.lastAction = { type, amount: amt };
  }

  commit(p, amount) {
    const amt = Math.max(0, Math.min(amount, p.chips));
    p.chips -= amt;
    p.bet += amt;
    p.totalBet += amt;
    if (p.chips === 0) p.allIn = true;
    return amt;
  }

  startTurnTimer(seat, ms) {
    clearTimeout(this.turnTimer);
    this.turnTotal = ms;
    this.turnDeadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => this.onTimeout(seat), ms);
  }

  setTurn(seat) {
    this.currentSeat = seat;
    const p = this.seats[seat];
    const base = this.settings.turnTime ? this.settings.turnTime * 1000 : 0;
    if (!p.connected) this.startTurnTimer(seat, 6000);
    else if (base) this.startTurnTimer(seat, base);
    else { clearTimeout(this.turnTimer); this.turnDeadline = 0; this.turnTotal = 0; }
    this.fx({ kind: 'turn', seat });
    this.changed();
  }

  onTimeout(seat) {
    if (this.currentSeat !== seat || !this.isBetting()) return;
    const p = this.seats[seat];
    if (!p) return;
    const type = p.bet >= this.currentBet ? 'check' : 'fold';
    p.timeouts = (p.timeouts || 0) + 1;
    this.act(p.id, type, 0, true);
    if (p.timeouts >= 2 && !p.sittingOut) {
      p.sittingOut = true;
      this.log(`${p.name} timed out and is now sitting out`);
      this.changed();
    }
  }

  act(id, type, amount = 0, auto = false) {
    if (!this.isBetting()) return 'No hand in progress';
    const seat = this.currentSeat;
    const p = this.seats[seat];
    if (!p || p.id !== id) return 'Not your turn';
    const toCall = this.currentBet - p.bet;

    if (type === 'allin') {
      const target = p.bet + p.chips;
      if (target <= this.currentBet || !this.canRaise(p)) type = 'call';
      else { type = 'raise'; amount = target; }
    }
    if (type === 'call' && toCall <= 0) type = 'check';

    let fxAction = type;
    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = { type: 'fold' };
        break;
      case 'check':
        if (toCall > 0) return 'You cannot check — there is a bet to you';
        p.lastAction = { type: 'check' };
        break;
      case 'call': {
        const amt = this.commit(p, toCall);
        p.lastAction = { type: p.allIn ? 'allin' : 'call', amount: amt };
        if (p.allIn) fxAction = 'allin';
        break;
      }
      case 'raise': {
        if (!this.canRaise(p)) return 'You cannot raise right now';
        const maxTo = p.bet + p.chips;
        let target = Math.floor(Number(amount) || 0);
        if (target > maxTo) target = maxTo;
        if (target <= this.currentBet) return `Raise must be more than ${this.currentBet}`;
        const raiseSize = target - this.currentBet;
        const isAllIn = target === maxTo;
        if (raiseSize < this.minRaise && !isAllIn) return `Minimum raise is to ${this.currentBet + this.minRaise}`;
        const wasBet = this.currentBet === 0;
        this.commit(p, target - p.bet);
        if (raiseSize >= this.minRaise) { this.minRaise = raiseSize; this.reopenId++; }
        this.currentBet = target;
        p.lastAction = { type: p.allIn ? 'allin' : (wasBet ? 'bet' : 'raise'), amount: target };
        fxAction = p.allIn ? 'allin' : (wasBet ? 'bet' : 'raise');
        break;
      }
      default:
        return 'Unknown action';
    }
    if (!auto) p.timeouts = 0;
    p.acted = true;
    p.lastReopen = this.reopenId;
    clearTimeout(this.turnTimer);
    this.fx({ kind: 'action', action: fxAction, seat });
    this.afterAction(seat);
    return null;
  }

  checkUncontested() {
    if (!this.isBetting()) return false;
    const live = this.players.filter(p => this.live(p));
    if (live.length === 1) { this.winUncontested(live[0]); return true; }
    return false;
  }

  afterAction(fromSeat) {
    if (this.checkUncontested()) return;
    const next = this.nextSeat(fromSeat, p => this.needsToAct(p));
    if (next !== -1) return this.setTurn(next);
    this.endStreet();
  }

  endStreet() {
    clearTimeout(this.turnTimer);
    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
      if (p.lastAction && !['fold', 'allin'].includes(p.lastAction.type)) p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.reopenId++;
    this.currentSeat = -1;

    if (this.phase === 'river') return this.showdown();
    this.deck.pop(); // burn
    if (this.phase === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.phase = 'flop'; }
    else if (this.phase === 'flop') { this.board.push(this.deck.pop()); this.phase = 'turn'; }
    else if (this.phase === 'turn') { this.board.push(this.deck.pop()); this.phase = 'river'; }
    this.fx({ kind: 'street', phase: this.phase, count: this.phase === 'flop' ? 3 : 1 });

    const actors = this.players.filter(p => this.canAct(p)).length;
    const first = actors >= 2 ? this.nextSeat(this.dealerSeat, p => this.needsToAct(p)) : -1;
    if (first === -1) {
      // all-in run-out: reveal hands and deal the rest with a little drama
      for (const p of this.players) if (this.live(p)) p.showCards = true;
      this.changed();
      this.runoutTimer = setTimeout(() => this.endStreet(), 1600);
      return;
    }
    this.setTurn(first);
  }

  buildPots() {
    const contribs = this.players.filter(p => p.totalBet > 0);
    const levels = [...new Set(contribs.map(p => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0, contributors = 0;
      for (const p of contribs) {
        const c = Math.min(p.totalBet, lvl) - Math.min(p.totalBet, prev);
        if (c > 0) { amount += c; contributors++; }
      }
      const eligible = contribs.filter(p => this.live(p) && p.totalBet >= lvl).map(p => p.seat);
      pots.push({ amount, eligible, refund: contributors === 1 });
      prev = lvl;
    }
    // fold pots with nobody eligible into the one below; merge identical eligibility
    const out = [];
    for (const pot of pots) {
      if (pot.eligible.length === 0) {
        if (out.length) out[out.length - 1].amount += pot.amount;
        else out.push(pot);
        continue;
      }
      const last = out[out.length - 1];
      if (last && !last.refund && !pot.refund && last.eligible.join() === pot.eligible.join()) last.amount += pot.amount;
      else out.push({ ...pot });
    }
    return out;
  }

  winUncontested(p) {
    clearTimeout(this.turnTimer); clearTimeout(this.runoutTimer);
    this.currentSeat = -1;
    const pot = this.players.reduce((s, o) => s + o.totalBet, 0);
    // return any uncalled part of the winner's bet separately
    const others = Math.max(0, ...this.players.filter(o => o !== p).map(o => o.totalBet));
    const refund = Math.max(0, p.totalBet - others);
    p.chips += pot;
    for (const o of this.players) o.bet = 0;
    const won = pot - refund;
    this.result = { uncontested: true, winners: [{ seat: p.seat, name: p.name, amount: won, handName: null, cards: [] }], potTotal: pot };
    this.log(`${p.name} wins ${won.toLocaleString()}`);
    this.phase = 'complete';
    this.fx({ kind: 'win', seats: [p.seat] });
    this.scheduleNext(3500);
    this.changed();
  }

  showdown() {
    clearTimeout(this.runoutTimer);
    this.phase = 'showdown';
    const live = this.players.filter(p => this.live(p));
    const evals = {};
    for (const p of live) {
      p.showCards = true;
      evals[p.seat] = evaluate([...p.hole, ...this.board]);
    }
    const pots = this.buildPots();
    const awards = {};
    const potResults = [];
    for (const pot of pots) {
      let winners;
      if (pot.eligible.length === 1) winners = pot.eligible;
      else {
        let best = null;
        winners = [];
        for (const s of pot.eligible) {
          const sc = evals[s].score;
          const c = best ? compare(sc, best) : 1;
          if (c > 0) { best = sc; winners = [s]; } else if (c === 0) winners.push(s);
        }
      }
      // order winners starting left of the dealer for odd chips
      winners.sort((a, b) => ((a - this.dealerSeat - 1 + MAX_SEATS) % MAX_SEATS) - ((b - this.dealerSeat - 1 + MAX_SEATS) % MAX_SEATS));
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      for (const s of winners) {
        const amt = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        this.seats[s].chips += amt;
        if (!pot.refund) awards[s] = (awards[s] || 0) + amt;
      }
      if (!pot.refund) potResults.push({ amount: pot.amount, winners });
    }
    const winners = Object.entries(awards).map(([s, amount]) => {
      s = +s;
      return { seat: s, name: this.seats[s].name, amount, handName: evals[s].name, cards: evals[s].cards };
    }).sort((a, b) => b.amount - a.amount);
    this.result = {
      uncontested: false,
      winners,
      pots: potResults,
      hands: live.map(p => ({ seat: p.seat, handName: evals[p.seat].name })),
      potTotal: potResults.reduce((s, p) => s + p.amount, 0),
    };
    potResults.forEach((pr, i) => {
      const label = potResults.length > 1 ? (i === 0 ? 'main pot' : `side pot ${i}`) : 'the pot';
      const names = pr.winners.map(s => this.seats[s].name).join(' & ');
      const hand = evals[pr.winners[0]].name;
      this.log(`${names} ${pr.winners.length > 1 ? 'split' : 'wins'} ${label} (${pr.amount.toLocaleString()}) with ${hand}`);
    });
    this.phase = 'complete';
    this.fx({ kind: 'win', seats: winners.map(w => w.seat) });
    this.scheduleNext(6500);
    this.changed();
  }

  // ---------- views ----------
  view(forId) {
    const me = this.findPlayer(forId);
    const totalCommitted = this.players.reduce((s, p) => s + p.totalBet, 0);
    const streetBets = this.players.reduce((s, p) => s + p.bet, 0);
    const v = {
      code: this.code,
      settings: this.settings,
      started: this.started,
      phase: this.phase,
      handNumber: this.handNumber,
      board: this.board,
      pot: this.phase === 'complete' ? 0 : totalCommitted - streetBets,
      totalPot: this.phase === 'complete' ? 0 : totalCommitted,
      dealerSeat: this.dealerSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      currentSeat: this.currentSeat,
      currentBet: this.currentBet,
      turnRemainingMs: this.turnDeadline && this.currentSeat >= 0 ? Math.max(0, this.turnDeadline - Date.now()) : 0,
      turnTotalMs: this.turnTotal,
      nextHandInMs: this.nextHandAt ? Math.max(0, this.nextHandAt - Date.now()) : 0,
      result: this.result,
      mySeat: me ? me.seat : -1,
      isHost: forId === this.hostId,
      seats: this.seats.map(p => p && {
        seat: p.seat,
        name: p.name,
        color: p.color,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        sittingOut: p.sittingOut,
        connected: p.connected,
        isHost: p.id === this.hostId,
        isYou: p.id === forId,
        buyIns: p.buyIns,
        net: p.chips + (this.isBetting() || this.phase === 'showdown' ? p.totalBet : 0) - p.buyIns * this.settings.startingStack,
        lastAction: p.lastAction,
        cardCount: p.hole.length,
        cards: (p.id === forId || p.showCards) ? p.hole : null,
      }),
    };
    if (me && this.isBetting() && this.currentSeat === me.seat) {
      const toCall = Math.max(0, this.currentBet - me.bet);
      const maxTo = me.bet + me.chips;
      v.actions = {
        toCall: Math.min(toCall, me.chips),
        canCheck: toCall === 0,
        canRaise: this.canRaise(me),
        minRaiseTo: Math.min(maxTo, this.currentBet + this.minRaise),
        maxRaiseTo: maxTo,
        isBet: this.currentBet === 0,
      };
    }
    return v;
  }

  destroy() {
    clearTimeout(this.turnTimer); clearTimeout(this.nextHandTimer); clearTimeout(this.runoutTimer);
  }
}

module.exports = { Table, MAX_SEATS };
