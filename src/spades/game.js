// Spades rules engine: four players in two partnerships (seats 0 & 2 vs 1 & 3), bidding with
// Nil and optional Blind Nil, spades as trumps, bags. Empty seats can be filled with bots.
const crypto = require('crypto');

const SUITS = ['C', 'D', 'H', 'S'];            // spades are trumps
const TARGETS = [250, 300, 500];
const TURN_TIMES = [0, 15, 30, 60];
const BAG_LIMIT = 10;                           // every 10 bags costs 100 points
const LOSE_AT = -200;                           // a team this far down loses
const NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_NAME = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
const BOT_NAMES = ['Ace Bot', 'Jack Bot', 'Queenie', 'King Bot'];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const card = (r, s) => ({ id: `${r}${s}`, r, s });
const buildDeck = () => SUITS.flatMap(s => Array.from({ length: 13 }, (_, k) => card(k + 2, s)));
const cardName = c => `${NAMES[c.r] || c.r}${{ C: '♣', D: '♦', H: '♥', S: '♠' }[c.s]}`;
const team = seat => seat % 2;
const sortHand = h => h.sort((a, b) => SUITS.indexOf(a.s) - SUITS.indexOf(b.s) || a.r - b.r);

// who is winning a (partial) trick
function trickWinner(trick) {
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const c = t.card, b = best.card;
    if (c.s === b.s ? c.r > b.r : c.s === 'S') best = t;
  }
  return best.seat;
}

class Game {
  constructor(code, settings = {}, hooks = {}) {
    this.code = code;
    this.settings = {
      target: TARGETS.includes(settings.target) ? settings.target : 500,
      blindNil: !!settings.blindNil,
      turnTime: TURN_TIMES.includes(settings.turnTime) ? settings.turnTime : 30,
    };
    this.botMs = settings.botMs != null ? settings.botMs : 900;      // how long bots "think"
    this.trickMs = settings.trickMs != null ? settings.trickMs : 1400; // how long a finished trick stays visible
    this.hooks = { changed() {}, fx() {}, ...hooks };
    this.seats = [null, null, null, null];   // { id, name, bot, connected }
    this.spectators = new Map();
    this.phase = 'lobby';
    this.scores = [0, 0];
    this.bags = [0, 0];
    this.handNo = 0;
    this.dealer = crypto.randomInt(4);
    this.history = [];
    this.log = [];
    this.logId = 0;
    this.timer = { key: null, handle: null, deadline: null };
    this.botTimer = null;
  }

  // ---------- seats & lobby ----------
  seatOf(id) { return this.seats.findIndex(p => p && p.id === id); }
  findPlayer(id) { const i = this.seatOf(id); return i < 0 ? null : this.seats[i]; }
  get hostId() {
    if (this.host && (this.findPlayer(this.host) || this.spectators.has(this.host))) return this.host;
    const human = this.seats.find(p => p && !p.bot);
    return human ? human.id : null;
  }
  get between() { return this.phase === 'lobby' || this.phase === 'over'; }

  addPlayer(id, name) {
    const p = this.findPlayer(id);
    if (p) { p.connected = true; p.name = name || p.name; this.hooks.changed(); return { ok: true }; }
    if (!this.host) this.host = id;
    const free = this.seats.indexOf(null);
    if (!this.between || free < 0) {
      // the table is full or a game is on: watch (and grab a seat if one frees up in the lobby)
      this.spectators.set(id, name);
      this.hooks.changed();
      return { ok: true, spectator: true };
    }
    this.seats[free] = { id, name, bot: false, connected: true };
    this.spectators.delete(id);
    this.hooks.changed();
    return { ok: true };
  }

  removePlayer(id) {
    this.spectators.delete(id);
    const i = this.seatOf(id);
    if (i < 0) return this.hooks.changed();
    if (this.between) this.seats[i] = null;
    else this.seats[i].connected = false;
    this.hooks.changed();
  }

  setConnected(id, value) {
    const p = this.findPlayer(id);
    if (p) { p.connected = value; this.hooks.changed(); }
  }

  sit(id, seat) {
    if (!this.between) return 'You can only change seats between games';
    seat = Number(seat);
    if (!(seat >= 0 && seat < 4)) return 'Invalid seat';
    if (this.seats[seat]) return 'That seat is taken';
    const cur = this.seatOf(id);
    const name = cur >= 0 ? this.seats[cur].name : this.spectators.get(id);
    if (name == null) return 'Join the game first';
    if (cur >= 0) this.seats[cur] = null;
    this.seats[seat] = { id, name, bot: false, connected: true };
    this.spectators.delete(id);
    this.hooks.changed();
    return null;
  }

  standUp(id) {
    if (!this.between) return 'You can only change seats between games';
    const cur = this.seatOf(id);
    if (cur < 0) return 'You are not seated';
    this.spectators.set(id, this.seats[cur].name);
    this.seats[cur] = null;
    this.hooks.changed();
    return null;
  }

  addBot(id, seat) {
    if (id !== this.hostId) return 'Only the host can add bots';
    if (!this.between) return 'Bots can only be added between games';
    seat = Number(seat);
    if (!(seat >= 0 && seat < 4) || this.seats[seat]) return 'That seat is taken';
    const used = new Set(this.seats.filter(Boolean).map(p => p.name));
    this.seats[seat] = { id: `bot-${seat}-${Date.now()}`, name: BOT_NAMES.find(n => !used.has(n)) || 'Bot', bot: true, connected: true };
    this.hooks.changed();
    return null;
  }

  removeBot(id, seat) {
    if (id !== this.hostId) return 'Only the host can remove bots';
    if (!this.between) return 'Bots can only be removed between games';
    const p = this.seats[Number(seat)];
    if (!p || !p.bot) return 'No bot in that seat';
    this.seats[Number(seat)] = null;
    this.hooks.changed();
    return null;
  }

  configure(id, s = {}) {
    if (!this.between) return 'Settings can only change between games';
    if (id !== this.hostId) return 'Only the host can change settings';
    if (s.target != null && TARGETS.includes(+s.target)) this.settings.target = +s.target;
    if (typeof s.blindNil === 'boolean') this.settings.blindNil = s.blindNil;
    if (s.turnTime != null && TURN_TIMES.includes(+s.turnTime)) this.settings.turnTime = +s.turnTime;
    this.hooks.changed();
    return null;
  }

  start(id) {
    if (!this.between) return 'A game is already in progress';
    if (id !== this.hostId) return 'Only the host can start';
    if (this.seats.some(s => !s)) return 'All four seats must be filled — add bots for empty seats';
    this.scores = [0, 0];
    this.bags = [0, 0];
    this.handNo = 0;
    this.history = [];
    this.winnerTeam = null;
    this.addLog(`New game to ${this.settings.target}: ${this.teamName(0)} vs ${this.teamName(1)}.`);
    this.deal();
    this.changed();
    return null;
  }

  teamName(t) { return `${this.seats[t].name} & ${this.seats[t + 2].name}`; }

  deal() {
    this.handNo++;
    this.dealer = (this.dealer + 1) % 4;
    const deck = shuffle(buildDeck());
    this.hands = [0, 1, 2, 3].map(i => sortHand(deck.slice(i * 13, i * 13 + 13)));
    this.bids = [null, null, null, null];
    this.looked = [false, false, false, false];
    this.tricks = [0, 0, 0, 0];
    this.trick = [];
    this.lastTrick = null;
    this.spadesBroken = false;
    this.turn = (this.dealer + 1) % 4;   // bidding and the first lead start left of the dealer
    this.phase = 'bidding';
    this.addLog(`Hand ${this.handNo} — ${this.seats[this.dealer].name} deals.`);
  }

  // ---------- helpers ----------
  addLog(text, to) {
    this.log.push({ id: ++this.logId, text, to: to || null });
    if (this.log.length > 100) this.log.shift();
  }

  changed() { this.syncTimer(); this.scheduleBots(); this.hooks.changed(); }

  // Blind Nil is only allowed for a team trailing by 100 or more
  blindEligible(seat) {
    return this.settings.blindNil && this.scores[1 - team(seat)] - this.scores[team(seat)] >= 100;
  }

  legalCards(seat) {
    const hand = this.hands[seat];
    if (this.trick.length) {
      const led = this.trick[0].card.s;
      const follow = hand.filter(c => c.s === led);
      return follow.length ? follow : hand;
    }
    if (this.spadesBroken) return hand;
    const nonSpades = hand.filter(c => c.s !== 'S');
    return nonSpades.length ? nonSpades : hand;
  }

  // ---------- actions ----------
  act(id, type, d = {}) {
    const seat = this.seatOf(id);
    if (seat < 0) return 'You are not seated in this game';
    if (d === null || typeof d !== 'object') d = {};
    const handler = { bid: this.doBid, play: this.doPlay, look: this.doLook, next: this.doNext }[type];
    if (!handler) return 'Unknown action';
    const err = handler.call(this, seat, d);
    if (!err) this.changed();
    return err || null;
  }

  doLook(seat) {
    if (this.phase !== 'bidding') return 'Not bidding';
    this.looked[seat] = true;
    return null;
  }

  doBid(seat, d) {
    if (this.phase !== 'bidding') return 'Bidding is over';
    if (this.turn !== seat) return 'It is not your turn to bid';
    let bid = d.bid;
    if (bid === 'blind') {
      if (!this.blindEligible(seat)) return 'Blind Nil is only allowed when your team is behind by 100 or more';
      if (this.looked[seat]) return 'Blind Nil must be bid before you look at your cards';
    } else if (bid === 'nil' || bid === 0) bid = 'nil';
    else {
      bid = Math.floor(Number(bid));
      if (!(bid >= 1 && bid <= 13)) return 'Bid between 1 and 13, or Nil';
    }
    this.bids[seat] = bid;
    this.looked[seat] = true;
    const p = this.seats[seat];
    this.addLog(`${p.name} bids ${bid === 'nil' ? 'Nil' : bid === 'blind' ? 'Blind Nil!' : bid}.`);
    this.hooks.fx({ type: 'bid', seat, bid });
    this.turn = (seat + 1) % 4;
    if (this.bids.every(b => b !== null)) {
      this.phase = 'playing';
      this.turn = (this.dealer + 1) % 4;
      const tb = t => [t, t + 2].reduce((s, i) => s + (typeof this.bids[i] === 'number' ? this.bids[i] : 0), 0);
      this.addLog(`Bids are in: ${this.teamName(0)} ${tb(0)}, ${this.teamName(1)} ${tb(1)}. ${this.seats[this.turn].name} leads.`);
    }
    return null;
  }

  doPlay(seat, d) {
    if (this.phase !== 'playing') return this.phase === 'trickEnd' ? 'Wait for the trick to be collected' : 'Not playing right now';
    if (this.turn !== seat) return 'It is not your turn';
    const hand = this.hands[seat];
    const c = hand.find(x => x.id === String(d.card));
    if (!c) return 'You do not have that card';
    if (!this.legalCards(seat).includes(c)) {
      return this.trick.length ? `You must follow suit (${SUIT_NAME[this.trick[0].card.s]})` : 'Spades have not been broken yet';
    }
    hand.splice(hand.indexOf(c), 1);
    this.trick.push({ seat, card: c });
    if (c.s === 'S' && !this.spadesBroken && this.trick.length > 1 && this.trick[0].card.s !== 'S') {
      this.spadesBroken = true;
      this.addLog('♠ Spades are broken!');
      this.hooks.fx({ type: 'broken' });
    }
    if (c.s === 'S') this.spadesBroken = this.spadesBroken || this.trick[0].card.s === 'S';
    this.hooks.fx({ type: 'play', seat, card: c });
    if (this.trick.length < 4) { this.turn = (seat + 1) % 4; return null; }

    // trick complete
    const w = trickWinner(this.trick);
    this.tricks[w]++;
    this.lastTrick = { cards: this.trick.slice(), winner: w };
    this.addLog(`${this.seats[w].name} wins the trick with ${cardName(this.trick.find(t => t.seat === w).card)}.`);
    this.hooks.fx({ type: 'trick', winner: w });
    this.turn = w;
    this.phase = 'trickEnd';
    const collect = () => {
      if (this.phase !== 'trickEnd') return;
      this.trick = [];
      if (this.hands.every(h => !h.length)) this.scoreHand();
      else this.phase = 'playing';
      this.changed();
    };
    if (this.trickMs) { clearTimeout(this.trickTimer); this.trickTimer = setTimeout(collect, this.trickMs); }
    else { this.trick = []; if (this.hands.every(h => !h.length)) this.scoreHand(); else this.phase = 'playing'; }
    return null;
  }

  scoreHand() {
    const result = [0, 1].map(t => {
      const seats = [t, t + 2];
      let pts = 0, overtricks = 0, nilTricks = 0;
      const lines = [];
      let contract = 0, made = 0;
      for (const s of seats) {
        const b = this.bids[s], n = this.tricks[s], name = this.seats[s].name;
        if (b === 'nil' || b === 'blind') {
          const v = b === 'blind' ? 200 : 100;
          if (n === 0) { pts += v; lines.push(`${name} made ${b === 'blind' ? 'Blind Nil' : 'Nil'}: +${v}`); }
          else { pts -= v; nilTricks += n; lines.push(`${name} broke ${b === 'blind' ? 'Blind Nil' : 'Nil'} (${n} trick${n === 1 ? '' : 's'}): −${v}`); }
        } else { contract += b; made += n; }
      }
      if (contract) {
        if (made >= contract) {
          overtricks = made - contract;
          pts += contract * 10 + overtricks;
          lines.push(`Bid ${contract}, took ${made}: +${contract * 10}${overtricks ? ` + ${overtricks} bag${overtricks === 1 ? '' : 's'}` : ''}`);
        } else {
          pts -= contract * 10;
          lines.push(`Bid ${contract}, took only ${made}: set, −${contract * 10}`);
        }
      }
      // tricks won by a failed Nil bidder don't help the bid; they count as bags (a point each)
      if (nilTricks) { pts += nilTricks; lines.push(`${nilTricks} bag${nilTricks === 1 ? '' : 's'} from the broken Nil: +${nilTricks}`); }
      const bags = overtricks + nilTricks;
      this.bags[t] += bags;
      while (this.bags[t] >= BAG_LIMIT) {
        this.bags[t] -= BAG_LIMIT;
        pts -= 100;
        lines.push(`${BAG_LIMIT} bags: −100`);
      }
      this.scores[t] += pts;
      return { pts, lines, tricks: this.tricks[t] + this.tricks[t + 2] };
    });
    this.history.push({ hand: this.handNo, bids: this.bids.slice(), tricks: this.tricks.slice(), result: result.map(r => r.pts) });
    this.handResult = result;
    for (const t of [0, 1]) this.addLog(`${this.teamName(t)}: ${result[t].pts >= 0 ? '+' : ''}${result[t].pts} (${this.scores[t]}).`);
    const [a, b] = this.scores, target = this.settings.target;
    // first to the target wins; a team that sinks to −200 loses
    if (((a >= target || b >= target) || (a <= LOSE_AT || b <= LOSE_AT)) && a !== b) {
      this.winnerTeam = a > b ? 0 : 1;
      this.phase = 'over';
      this.addLog(`🏆 ${this.teamName(this.winnerTeam)} win ${Math.max(a, b)} to ${Math.min(a, b)}!`);
      this.hooks.fx({ type: 'win', team: this.winnerTeam });
    } else {
      this.phase = 'handOver';
      this.hooks.fx({ type: 'handOver' });
    }
  }

  doNext(seat) {
    if (this.phase !== 'handOver') return 'The hand is not over';
    this.deal();
    return null;
  }

  // ---------- bots ----------
  // A simple, reasonable player: counts likely tricks to bid, then plays to win cheaply or duck.
  botBid(seat) {
    const h = this.hands[seat];
    const spades = h.filter(c => c.s === 'S');
    let est = 0;
    for (const c of h) {
      const len = h.filter(x => x.s === c.s).length;
      if (c.s === 'S') { if (c.r >= 12) est += 1; else if (c.r === 11 && spades.length >= 3) est += 0.5; }
      else if (c.r === 14) est += len <= 5 ? 1 : 0.6;
      else if (c.r === 13) est += len >= 2 && len <= 4 ? 0.8 : 0.3;
    }
    est += Math.max(0, spades.length - 3) * 0.9;
    for (const s of ['C', 'D', 'H']) if (!h.some(c => c.s === s) && spades.length >= 2) est += 0.7;
    if (est < 0.8 && !spades.some(c => c.r >= 11) && spades.length <= 3) return 'nil';
    return Math.max(1, Math.min(13, Math.round(est)));
  }

  botCard(seat) {
    const legal = this.legalCards(seat).slice().sort((a, b) => a.r - b.r);
    const nil = this.bids[seat] === 'nil' || this.bids[seat] === 'blind';
    const low = cards => cards.slice().sort((a, b) => (a.s === 'S') - (b.s === 'S') || a.r - b.r)[0];
    const beats = (c, trick) => trickWinner([...trick, { seat, card: c }]) === seat;
    if (!this.trick.length) {
      if (nil) return low(legal);
      const aces = legal.filter(c => c.r === 14 && c.s !== 'S');
      if (aces.length) return aces[0];
      return low(legal);
    }
    const winners = legal.filter(c => beats(c, this.trick));
    if (nil) {
      const losers = legal.filter(c => !beats(c, this.trick));
      return losers.length ? losers.sort((a, b) => b.r - a.r)[0] : winners.sort((a, b) => a.r - b.r)[0];
    }
    const cur = trickWinner(this.trick);
    const partnerWinning = cur === (seat + 2) % 4;
    const partnerNil = this.bids[(seat + 2) % 4] === 'nil' || this.bids[(seat + 2) % 4] === 'blind';
    if (partnerWinning && !partnerNil) return low(legal);
    if (winners.length && (this.trick.length === 3 || winners.some(c => c.r >= 12) || partnerNil)) {
      return winners.sort((a, b) => (a.s === 'S') - (b.s === 'S') || a.r - b.r)[0];
    }
    return low(legal);
  }

  // whose move is it?
  actorSeat() {
    if (this.phase === 'bidding' || this.phase === 'playing') return this.turn;
    return null;
  }

  botMove(seat) {
    if (this.phase === 'bidding') return this.act(this.seats[seat].id, 'bid', { bid: this.botBid(seat) });
    if (this.phase === 'playing') return this.act(this.seats[seat].id, 'play', { card: this.botCard(seat).id });
    return null;
  }

  scheduleBots() {
    const seat = this.actorSeat();
    if (seat == null || !this.seats[seat] || !this.seats[seat].bot) return;
    if (!this.botMs) { if (!this.inBotLoop) { this.inBotLoop = true; try { let guard = 0; while (this.actorSeat() != null && this.seats[this.actorSeat()].bot && guard++ < 400) this.botMove(this.actorSeat()); } finally { this.inBotLoop = false; } } return; }
    clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => { const s = this.actorSeat(); if (s != null && this.seats[s].bot) this.botMove(s); }, this.botMs);
    if (this.botTimer.unref) this.botTimer.unref();
  }

  // ---------- turn timer: a slow human gets the bot's move ----------
  timerKey() {
    const seat = this.actorSeat();
    if (seat == null || this.seats[seat].bot) return null;
    return `${this.phase}:${seat}:${this.handNo}:${this.hands[seat].length}`;
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

  onTimeout() {
    this.timer.key = null;
    const seat = this.actorSeat();
    if (seat == null) return;
    this.addLog(`⏱ ${this.seats[seat].name} ran out of time.`);
    this.botMove(seat);
  }

  // ---------- views ----------
  view(viewerId) {
    const me = this.seatOf(viewerId);
    const base = {
      code: this.code, phase: this.phase, settings: this.settings, hostId: this.hostId, you: viewerId, mySeat: me,
      seats: this.seats.map(p => p && { id: p.id, name: p.name, bot: p.bot, connected: p.connected }),
      spectators: [...this.spectators.entries()].map(([id, name]) => ({ id, name })),
      scores: this.scores, bags: this.bags, handNo: this.handNo, history: this.history, winnerTeam: this.winnerTeam ?? null,
      log: this.log.filter(l => !l.to || l.to.includes(viewerId)).slice(-50),
    };
    if (this.phase === 'lobby') return base;
    Object.assign(base, {
      dealer: this.dealer, turn: this.turn, bids: this.bids, tricks: this.tricks, trick: this.trick, lastTrick: this.lastTrick,
      spadesBroken: this.spadesBroken, counts: this.hands.map(h => h.length), handResult: this.handResult || null,
      timeLeft: this.timer.deadline ? Math.max(0, this.timer.deadline - Date.now()) : null,
    });
    if (me >= 0) {
      const hidden = this.phase === 'bidding' && this.blindEligible(me) && !this.looked[me] && this.bids[me] === null;
      base.hand = hidden ? null : this.hands[me];
      base.canBlind = this.phase === 'bidding' && this.blindEligible(me) && !this.looked[me];
      base.legal = this.phase === 'playing' && this.turn === me ? this.legalCards(me).map(c => c.id) : [];
    }
    return base;
  }

  destroy() { clearTimeout(this.timer.handle); clearTimeout(this.botTimer); clearTimeout(this.trickTimer); }
}

module.exports = { Game, buildDeck, trickWinner, cardName, team };
