// Yahtzee rules engine: 5 dice, 3 rolls a turn, 13 categories, the upper bonus, Yahtzee bonuses and
// the Joker rules. 1–8 players; the host can add computer players.
const crypto = require('crypto');

const UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
const LOWER = ['threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'];
const CATS = [...UPPER, ...LOWER];
const LABELS = {
  ones: 'Ones', twos: 'Twos', threes: 'Threes', fours: 'Fours', fives: 'Fives', sixes: 'Sixes',
  threeKind: '3 of a Kind', fourKind: '4 of a Kind', fullHouse: 'Full House', smallStraight: 'Sm. Straight',
  largeStraight: 'Lg. Straight', yahtzee: 'YAHTZEE', chance: 'Chance',
};
const UPPER_BONUS_AT = 63, UPPER_BONUS = 35, YAHTZEE_BONUS = 100;
const TURN_TIMES = [0, 30, 60, 90];
const PLAYER_COLORS = ['#e63946', '#2a9df4', '#2fbf71', '#f4a261', '#9b5de5', '#f15bb5', '#00bbf9', '#c9a227'];
const BOT_NAMES = ['Dicey', 'Lucky', 'Snake Eyes', 'Boxcars', 'Rollo', 'Pip'];
// a typical score for each box, used by the bots to judge whether a roll is "good" for a box
const BASELINE = { ones: 2.1, twos: 5.3, threes: 8.6, fours: 12.2, fives: 15.7, sixes: 19.2, threeKind: 21.7, fourKind: 13.1, fullHouse: 22.6, smallStraight: 29.5, largeStraight: 32.7, yahtzee: 16.9, chance: 22.0 };

const rollDie = () => crypto.randomInt(1, 7);
const counts = dice => { const c = [0, 0, 0, 0, 0, 0, 0]; for (const d of dice) c[d]++; return c; };
const sum = dice => dice.reduce((a, b) => a + b, 0);
function hasRun(dice, len) {
  const set = new Set(dice);
  for (let start = 1; start + len - 1 <= 6; start++) {
    let ok = true;
    for (let k = 0; k < len; k++) if (!set.has(start + k)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// Points for putting `dice` in `cat`. `joker` = a bonus Yahtzee being used under the Joker rules.
function scoreFor(cat, dice, joker = false) {
  const c = counts(dice);
  const max = Math.max(...c);
  const i = UPPER.indexOf(cat);
  if (i >= 0) return c[i + 1] * (i + 1);
  switch (cat) {
    case 'threeKind': return max >= 3 ? sum(dice) : 0;
    case 'fourKind': return max >= 4 ? sum(dice) : 0;
    case 'fullHouse': return joker || (c.includes(3) && c.includes(2)) ? 25 : 0;
    case 'smallStraight': return joker || hasRun(dice, 4) ? 30 : 0;
    case 'largeStraight': return joker || hasRun(dice, 5) ? 40 : 0;
    case 'yahtzee': return max === 5 ? 50 : 0;
    case 'chance': return sum(dice);
  }
  return 0;
}

class Game {
  constructor(code, settings = {}, hooks = {}) {
    this.code = code;
    this.settings = { turnTime: TURN_TIMES.includes(settings.turnTime) ? settings.turnTime : 60 };
    this.botMs = settings.botMs != null ? settings.botMs : 1100;
    this.hooks = { changed() {}, fx() {}, ...hooks };
    this.players = [];
    this.spectators = new Map();
    this.phase = 'lobby';
    this.log = [];
    this.logId = 0;
    this.timer = { key: null, handle: null, deadline: null };
    this.botTimer = null;
    this.games = 0;
  }

  // ---------- lobby ----------
  findPlayer(id) { return this.players.find(p => p.id === id); }
  get hostId() {
    if (this.host && this.findPlayer(this.host)) return this.host;
    const h = this.players.find(p => !p.bot);
    return h ? h.id : null;
  }
  get between() { return this.phase === 'lobby' || this.phase === 'over'; }

  newCard() { return Object.fromEntries(CATS.map(c => [c, null])); }

  addPlayer(id, name) {
    const p = this.findPlayer(id);
    if (p) { p.connected = true; p.name = name || p.name; this.hooks.changed(); return { ok: true }; }
    if (!this.between) { this.spectators.set(id, name); this.hooks.changed(); return { ok: true, spectator: true }; }
    if (this.players.length >= 8) return { error: 'This game is full (8 players max)' };
    if (!this.players.length) this.host = id;
    this.spectators.delete(id);
    this.players.push({ id, name, bot: false, color: this.freeColor(), connected: true, card: this.newCard(), yBonus: 0, wins: 0 });
    this.hooks.changed();
    return { ok: true };
  }

  freeColor() { const used = new Set(this.players.map(p => p.color)); return PLAYER_COLORS.find(c => !used.has(c)) || '#999'; }

  addBot(id) {
    if (id !== this.hostId) return 'Only the host can add bots';
    if (!this.between) return 'Bots can only be added between games';
    if (this.players.length >= 8) return 'The table is full';
    const used = new Set(this.players.map(p => p.name));
    this.players.push({ id: `bot-${Date.now()}-${this.players.length}`, name: BOT_NAMES.find(n => !used.has(n)) || 'Bot', bot: true, color: this.freeColor(), connected: true, card: this.newCard(), yBonus: 0, wins: 0 });
    this.hooks.changed();
    return null;
  }

  removeBot(id, botId) {
    if (id !== this.hostId) return 'Only the host can remove bots';
    if (!this.between) return 'Bots can only be removed between games';
    const p = this.findPlayer(botId);
    if (!p || !p.bot) return 'No such bot';
    this.players = this.players.filter(x => x !== p);
    this.hooks.changed();
    return null;
  }

  removePlayer(id) {
    this.spectators.delete(id);
    const p = this.findPlayer(id);
    if (!p) return this.hooks.changed();
    if (this.between) this.players = this.players.filter(x => x !== p);
    else p.connected = false;
    this.hooks.changed();
  }

  setConnected(id, value) {
    const p = this.findPlayer(id);
    if (p) { p.connected = value; this.hooks.changed(); }
  }

  configure(id, s = {}) {
    if (!this.between) return 'Settings can only change between games';
    if (id !== this.hostId) return 'Only the host can change settings';
    if (s.turnTime != null && TURN_TIMES.includes(+s.turnTime)) this.settings.turnTime = +s.turnTime;
    this.hooks.changed();
    return null;
  }

  start(id) {
    if (!this.between) return 'A game is already in progress';
    if (id !== this.hostId) return 'Only the host can start';
    if (!this.players.length) return 'Nobody is playing';
    this.games++;
    for (const p of this.players) { p.card = this.newCard(); p.yBonus = 0; }
    this.current = (this.games - 1) % this.players.length;
    this.round = 1;
    this.winners = null;
    this.phase = 'play';
    this.beginTurn();
    this.addLog(`Game ${this.games} — ${this.cur().name} rolls first.`);
    this.changed();
    return null;
  }

  // ---------- helpers ----------
  addLog(text) {
    this.log.push({ id: ++this.logId, text });
    if (this.log.length > 100) this.log.shift();
  }
  cur() { return this.players[this.current]; }
  changed() { this.syncTimer(); this.scheduleBots(); this.hooks.changed(); }

  beginTurn() {
    this.dice = [1, 1, 1, 1, 1];
    this.held = [false, false, false, false, false];
    this.rollsLeft = 3;
    this.turnSeq = (this.turnSeq || 0) + 1;
  }

  totals(p) {
    const upper = UPPER.reduce((s, c) => s + (p.card[c] || 0), 0);
    const bonus = upper >= UPPER_BONUS_AT ? UPPER_BONUS : 0;
    const lower = LOWER.reduce((s, c) => s + (p.card[c] || 0), 0);
    const yBonus = p.yBonus * YAHTZEE_BONUS;
    return { upper, bonus, lower, yBonus, total: upper + bonus + lower + yBonus };
  }

  // Is this roll a bonus Yahtzee (Yahtzee box already filled)? Then the Joker rules decide where it can go.
  jokerInfo(p, dice) {
    const c = counts(dice);
    const isY = Math.max(...c) === 5;
    if (!isY || p.card.yahtzee === null) return { joker: false };
    const face = dice[0];
    const upperBox = UPPER[face - 1];
    return { joker: true, upperBox, upperOpen: p.card[upperBox] === null, bonus: p.card.yahtzee === 50 };
  }

  // the boxes a player may use right now, with their points
  options(p) {
    const j = this.jokerInfo(p, this.dice);
    const open = CATS.filter(c => p.card[c] === null);
    let allowed = open;
    if (j.joker) {
      // Joker rules: the matching upper box if open; else any lower box at full value; else any upper box (scoring 0)
      if (j.upperOpen) allowed = [j.upperBox];
      else {
        const lowerOpen = open.filter(c => LOWER.includes(c));
        allowed = lowerOpen.length ? lowerOpen : open;
      }
    }
    return Object.fromEntries(allowed.map(c => [c, scoreFor(c, this.dice, j.joker && LOWER.includes(c))]));
  }

  // ---------- actions ----------
  act(id, type, d = {}) {
    const p = this.findPlayer(id);
    if (!p) return 'You are not playing in this game';
    if (this.phase !== 'play') return this.phase === 'over' ? 'The game is over' : 'The game has not started';
    if (d === null || typeof d !== 'object') d = {};
    if (this.cur() !== p) return 'It is not your turn';
    const handler = { roll: this.doRoll, hold: this.doHold, score: this.doScore }[type];
    if (!handler) return 'Unknown action';
    const err = handler.call(this, p, d);
    if (!err) this.changed();
    return err || null;
  }

  doHold(p, d) {
    if (this.rollsLeft === 3) return 'Roll first';
    if (!this.rollsLeft) return 'No rolls left — pick a box to score';
    const i = Number(d.index);
    if (!(i >= 0 && i < 5)) return 'Invalid die';
    this.held[i] = d.held != null ? !!d.held : !this.held[i];
    return null;
  }

  doRoll(p, d) {
    if (!this.rollsLeft) return 'No rolls left — pick a box to score';
    if (Array.isArray(d.held) && this.rollsLeft < 3) this.held = d.held.slice(0, 5).map(Boolean);
    if (this.rollsLeft === 3) this.held = [false, false, false, false, false];
    if (this.held.every(Boolean)) return 'Every die is held — release one to roll';
    this.dice = this.dice.map((v, i) => (this.held[i] ? v : rollDie()));
    this.rollsLeft--;
    this.hooks.fx({ type: 'roll', id: p.id, dice: this.dice, held: this.held });
    if (Math.max(...counts(this.dice)) === 5) this.hooks.fx({ type: 'yahtzee', id: p.id });
    return null;
  }

  doScore(p, d) {
    if (this.rollsLeft === 3) return 'Roll at least once first';
    const opts = this.options(p);
    if (!(d.cat in opts)) {
      if (p.card[d.cat] !== undefined && p.card[d.cat] !== null) return 'That box is already filled';
      const j = this.jokerInfo(p, this.dice);
      return j.joker ? `Bonus Yahtzee: you must use ${j.upperOpen ? LABELS[j.upperBox] : 'a lower box'} (Joker rules)` : 'Pick an open box';
    }
    const j = this.jokerInfo(p, this.dice);
    if (j.joker && j.bonus) {
      p.yBonus++;
      this.addLog(`🎉 ${p.name} rolled a bonus YAHTZEE! +${YAHTZEE_BONUS}`);
    }
    p.card[d.cat] = opts[d.cat];
    this.addLog(`${p.name} scored ${opts[d.cat]} in ${LABELS[d.cat]}.`);
    this.hooks.fx({ type: 'score', id: p.id, cat: d.cat, points: opts[d.cat] });
    this.nextTurn();
    return null;
  }

  nextTurn() {
    const done = this.players.every(x => CATS.every(c => x.card[c] !== null));
    if (done) return this.finish();
    this.current = (this.current + 1) % this.players.length;
    if (this.current === (this.games - 1) % this.players.length) this.round++;
    this.beginTurn();
  }

  finish() {
    this.phase = 'over';
    const best = Math.max(...this.players.map(p => this.totals(p).total));
    this.winners = this.players.filter(p => this.totals(p).total === best).map(p => p.id);
    for (const id of this.winners) this.findPlayer(id).wins++;
    const names = this.winners.map(id => this.findPlayer(id).name).join(' & ');
    this.addLog(`🏆 ${names} win${this.winners.length > 1 ? '' : 's'} with ${best} points!`);
    this.hooks.fx({ type: 'win', ids: this.winners });
  }

  // ---------- bots ----------
  // pick the box that beats its typical score by the most; lean towards the upper bonus
  botPickBox(p) {
    const opts = this.options(p);
    const upperNow = UPPER.reduce((s, c) => s + (p.card[c] || 0), 0);
    const late = CATS.filter(c => p.card[c] === null).length <= 4;
    let best = null, bestVal = -Infinity;
    for (const [cat, pts] of Object.entries(opts)) {
      let v = pts - BASELINE[cat];
      const ui = UPPER.indexOf(cat);
      if (ui >= 0 && upperNow < UPPER_BONUS_AT) v += pts >= (ui + 1) * 3 ? 6 : -2;      // on pace for the bonus
      if (pts === 0) v = -BASELINE[cat] * (late ? 0.6 : 1) - (cat === 'yahtzee' && !late ? 8 : 0);
      if (cat === 'chance' && !late) v -= 4;                                           // keep Chance as a safety net
      if (v > bestVal) { bestVal = v; best = cat; }
    }
    return best;
  }

  // which dice to keep before the next roll
  botHolds(p) {
    const d = this.dice, c = counts(d), open = c2 => p.card[c2] === null;
    const keepFace = f => d.map(v => v === f);
    if (open('largeStraight') && hasRun(d, 5)) return [true, true, true, true, true];
    if (open('yahtzee') || open('fourKind') || open('threeKind')) {
      if (Math.max(...c) === 5) return [true, true, true, true, true];
    }
    if (open('fullHouse') && c.includes(3) && c.includes(2)) return [true, true, true, true, true];
    // chase a straight when we already have four in a row
    if ((open('largeStraight') || open('smallStraight')) && hasRun(d, 4)) {
      for (const start of [3, 2, 1]) {
        const run = [start, start + 1, start + 2, start + 3];
        if (run.every(v => d.includes(v))) {
          const used = new Set();
          return d.map(v => (run.includes(v) && !used.has(v) ? (used.add(v), true) : false));
        }
      }
    }
    // otherwise keep the most common face (ties go to the higher face)
    let face = 6;
    for (let f = 6; f >= 1; f--) if (c[f] > c[face]) face = f;
    if (c[face] === 1) {
      // nothing paired: keep a high die for Chance-like value, or go for a straight run of three
      const set = [...new Set(d)].sort();
      for (const start of [3, 2, 1, 4]) if ([start, start + 1, start + 2].every(v => set.includes(v)) && open('smallStraight')) {
        const used = new Set(), run = [start, start + 1, start + 2];
        return d.map(v => (run.includes(v) && !used.has(v) ? (used.add(v), true) : false));
      }
      return keepFace(Math.max(...d));
    }
    return keepFace(face);
  }

  botStep() {
    const p = this.cur();
    if (this.rollsLeft === 3) return this.act(p.id, 'roll');
    if (this.rollsLeft > 0) {
      // stop early if the roll is already great for an open box
      const opts = this.options(p);
      const great = Object.entries(opts).some(([cat, pts]) => (cat === 'yahtzee' && pts === 50) || (cat === 'largeStraight' && pts === 40) || (cat === 'fullHouse' && pts === 25 && !hasRun(this.dice, 4)));
      if (!great) {
        const held = this.botHolds(p);
        if (!held.every(Boolean)) return this.act(p.id, 'roll', { held });
      }
    }
    return this.act(p.id, 'score', { cat: this.botPickBox(p) });
  }

  scheduleBots() {
    if (this.phase !== 'play' || !this.cur().bot) return;
    if (!this.botMs) {
      if (this.inBotLoop) return;
      this.inBotLoop = true;
      try { let guard = 0; while (this.phase === 'play' && this.cur().bot && guard++ < 5000) this.botStep(); } finally { this.inBotLoop = false; }
      return;
    }
    clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => { if (this.phase === 'play' && this.cur().bot) this.botStep(); }, this.botMs);
    if (this.botTimer.unref) this.botTimer.unref();
  }

  // ---------- turn timer: a slow human gets the computer's move ----------
  timerKey() {
    if (this.phase !== 'play' || this.cur().bot) return null;
    return `${this.turnSeq}:${this.rollsLeft}`;
  }

  syncTimer() {
    const key = this.timerKey();
    if (key === this.timer.key) return;
    clearTimeout(this.timer.handle);
    this.timer = { key, handle: null, deadline: null };
    if (!key || !this.settings.turnTime) return;
    // one clock for the whole turn
    if (!this.turnDeadline || this.turnDeadline.seq !== this.turnSeq) this.turnDeadline = { seq: this.turnSeq, at: Date.now() + this.settings.turnTime * 1000 };
    const ms = Math.max(1000, this.turnDeadline.at - Date.now());
    this.timer.deadline = Date.now() + ms;
    this.timer.handle = setTimeout(() => this.onTimeout(), ms);
    if (this.timer.handle.unref) this.timer.handle.unref();
  }

  onTimeout() {
    this.timer.key = null;
    if (this.phase !== 'play') return;
    const p = this.cur();
    this.addLog(`⏱ ${p.name} ran out of time.`);
    if (this.rollsLeft === 3) this.act(p.id, 'roll');
    this.act(p.id, 'score', { cat: this.botPickBox(p) });
  }

  // ---------- views ----------
  view(viewerId) {
    const me = this.findPlayer(viewerId);
    const base = {
      code: this.code, phase: this.phase, settings: this.settings, hostId: this.hostId, you: viewerId, spectator: !me,
      cats: CATS, upperCats: UPPER, lowerCats: LOWER, labels: LABELS, games: this.games,
      players: this.players.map(p => ({ id: p.id, name: p.name, bot: p.bot, color: p.color, connected: p.connected, card: p.card, yBonus: p.yBonus, wins: p.wins, totals: this.totals(p) })),
      spectators: [...this.spectators.values()],
      log: this.log.slice(-50),
    };
    if (this.phase === 'lobby') return base;
    Object.assign(base, {
      current: this.cur() ? this.cur().id : null, round: this.round, dice: this.dice, held: this.held, rollsLeft: this.rollsLeft, turnSeq: this.turnSeq,
      options: this.phase === 'play' && this.rollsLeft < 3 ? this.options(this.cur()) : {},
      joker: this.phase === 'play' && this.rollsLeft < 3 ? this.jokerInfo(this.cur(), this.dice) : { joker: false },
      winners: this.winners,
      timeLeft: this.timer.deadline ? Math.max(0, this.timer.deadline - Date.now()) : null,
    });
    return base;
  }

  destroy() { clearTimeout(this.timer.handle); clearTimeout(this.botTimer); }
}

module.exports = { Game, scoreFor, CATS, UPPER, LOWER, hasRun };
