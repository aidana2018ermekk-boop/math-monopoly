// =====================================================================
//  МАТЕМАТИКАЛЫҚ МОНОПОЛИЯ — онлайн сервер
//  Node.js 18+ (сыртқы кітапханасыз). Іске қосу:  node server.js
//  Нақты уақыттағы байланыс: Server-Sent Events (сервер → браузер) + HTTP POST (браузер → сервер)
// =====================================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const QS = require('./server/questions');
const G = require('./public/shared.js');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ('m' + crypto.randomInt(100000, 999999));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'session.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_STUDENTS = 300;
const QBYID = new Map(QS.map(q => [q.id, q]));

const DEFAULT_SETTINGS = {tableSize: 4, mode: 'rounds', rounds: 10, target: 3000, diff: 'mix', timer: 30, dice: 1};

/* ------------------------------ STATE ------------------------------ */
let session = null;          // сақталатын күй
const studentStreams = new Map(); // studentId -> Set(res)
const adminStreams = new Set();
const timers = new Map();    // tableId -> timeout
let dirty = false, dashDirty = true;

const rnd = n => crypto.randomInt(0, n);
const now = () => Date.now();
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newId(n = 8) { return crypto.randomBytes(n).toString('hex'); }
function newCode() { return String(crypto.randomInt(100000, 999999)); }

function newSession(settings) {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  session = {
    v: 1, code: newCode(), status: 'lobby', settings: cleanSettings(settings),
    createdAt: now(), startedAt: null, endedAt: null,
    students: {}, tables: {}, tableSeq: 0, moveSeq: 0,
  };
  markDirty(); broadcastAllStudents();
  return session;
}
function cleanSettings(s = {}) {
  const o = {...DEFAULT_SETTINGS};
  const pick = (k, allowed) => { if (allowed.includes(s[k])) o[k] = s[k]; };
  pick('tableSize', [1, 2, 3, 4]); pick('mode', ['rounds', 'target', 'last']);
  pick('rounds', [3, 5, 8, 10, 15, 20, 30]); pick('target', [2000, 3000, 5000]);
  pick('diff', ['mix', '1', '2', '3']); pick('timer', [20, 30, 45, 60]); pick('dice', [1, 2]);
  return o;
}
function markDirty() { dirty = true; dashDirty = true; }

/* --------------------------- PERSISTENCE --------------------------- */
function saveNow() {
  if (!session) return;
  try {
    fs.mkdirSync(DATA_DIR, {recursive: true});
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(session));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    dirty = false;
  } catch (e) { console.error('Сақтау қатесі:', e.message); }
}
function loadSaved() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (s && s.v === 1 && s.students && s.tables) {
      session = s;
      for (const t of Object.values(session.tables)) if (!t.over && t.phaseDeadline) schedule(t, Math.max(1500, t.phaseDeadline - now()));
      console.log(`Сақталған сессия жүктелді: код ${s.code}, студент саны ${Object.keys(s.students).length}`);
    }
  } catch (e) { /* файл жоқ — жаңа сессия */ }
}
setInterval(() => { if (dirty) saveNow(); }, 3000);

/* ------------------------------ HELPERS ---------------------------- */
const stu = id => session.students[id];
const tbl = id => session.tables[id];
const curSid = t => t.players[t.cur];
const isOnline = sid => (studentStreams.get(sid) || new Set()).size > 0;
function propsOf(t, sid) { return Object.keys(t.owners).map(Number).filter(i => t.owners[i] === sid).sort((a, b) => a - b); }
function propValue(t, sid) { return propsOf(t, sid).reduce((s, i) => s + G.CELLS[i].price, 0); }
function hasSet(t, sid, cat) { return G.CELLS.filter(c => c.t === 'prop' && c.cat === cat).every(c => t.owners[c.i] === sid); }
function rentOf(t, i) { const o = t.owners[i]; let r = G.baseRent(i); if (o != null && hasSet(t, o, G.CELLS[i].cat)) r *= 2; return r; }
function addLog(t, text) { t.log.unshift({r: t.round, h: text}); if (t.log.length > 40) t.log.length = 40; }
function activePlayers(t) { return t.players.filter(sid => stu(sid) && stu(sid).active); }
function parseNum(s) {
  s = String(s ?? '').trim().replace(/[−–]/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
  if (!s) return NaN;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]) / parseFloat(m[2]);
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return parseFloat(s);
}
const numText = n => String(n).replace('-', '−');
function chg(sid, delta) { const s = stu(sid); if (s) s.coins += delta; }

/* ------------------------------ TABLES ----------------------------- */
function makeTable(players) {
  const id = 't' + (++session.tableSeq);
  const t = {
    id, num: session.tableSeq, players: [], cur: 0, round: 1, owners: {}, phase: 'roll',
    q: null, result: null, used: [], log: [], move: null, over: false, endReason: '', phaseDeadline: null,
  };
  session.tables[id] = t;
  players.forEach(sid => seatPlayer(t, sid));
  addLog(t, `Ойын басталды! Әр ойыншыда ${G.START_COINS} тиын.`);
  setRollPhase(t);
  return t;
}
function seatPlayer(t, sid) {
  const s = stu(sid);
  s.tableId = t.id; s.seat = t.players.length; s.coins = G.START_COINS; s.pos = 0; s.active = true; s.skip = 0;
  t.players.push(sid);
}
function formTables() {
  const ids = shuffle(Object.keys(session.students).filter(id => !stu(id).kicked));
  const size = session.settings.tableSize;
  const n = Math.max(1, Math.ceil(ids.length / size));
  const groups = Array.from({length: n}, () => []);
  ids.forEach((id, k) => groups[k % n].push(id));
  groups.filter(g => g.length).forEach(g => makeTable(g));
}
function placeLateStudent(sid) {
  const size = session.settings.tableSize;
  const open = Object.values(session.tables).filter(t => !t.over && t.players.length < size)
    .sort((a, b) => a.players.length - b.players.length)[0];
  if (open) { seatPlayer(open, sid); addLog(open, `${stu(sid).name} үстелге қосылды.`); broadcastTable(open); }
  else broadcastTable(makeTable([sid]));
}

/* ---------------------------- TURN FLOW ---------------------------- */
function schedule(t, ms) {
  clearTimeout(timers.get(t.id));
  timers.set(t.id, setTimeout(() => onTimeout(t.id), ms));
}
function onTimeout(tid) {
  if (!session) return;
  const t = tbl(tid); if (!t || t.over) return;
  if (t.phase === 'roll') doRoll(t, true);
  else if (t.phase === 'question') doAnswer(t, null, true);
  else if (t.phase === 'result') doContinue(t, false);
  broadcastTable(t);
}
function setRollPhase(t) {
  t.phase = 'roll'; t.q = null; t.result = null;
  const sid = curSid(t);
  const wait = isOnline(sid) ? 45000 : 12000; // кезегіндегі ойыншы жауап бермесе, сүйек автоматты лақтырылады
  t.phaseDeadline = now() + wait; schedule(t, wait);
}
function doRoll(t, auto) {
  const sid = curSid(t), p = stu(sid);
  if (p.skip > 0) {
    p.skip--; addLog(t, `${p.name} Ойлану бөлмесінде — кезек өтті.`);
    endTurn(t); return;
  }
  const dice = Array.from({length: session.settings.dice}, () => 1 + rnd(6));
  const steps = dice.reduce((a, b) => a + b, 0);
  const from = p.pos;
  for (let k = 0; k < steps; k++) {
    p.pos = (p.pos + 1) % G.N_CELLS;
    if (p.pos === 0) { chg(sid, G.START_BONUS); addLog(t, `${p.name} Бастаудан өтті (+${G.START_BONUS}).`); }
  }
  t.move = {id: ++session.moveSeq, pid: sid, from, steps, dice};
  addLog(t, `${p.name} 🎲 ${steps} лақтырды${auto ? ' (автоматты)' : ''}.`);
  startQuestion(t, steps);
  // желіден шығып кеткен ойыншы үстелді ұзақ ұстап тұрмасын
  if (auto && !isOnline(sid)) { t.q.deadline = now() + 4000; t.phaseDeadline = t.q.deadline + 600; schedule(t, t.phaseDeadline - now()); }
}
function questionSpec(cell) {
  const fixed = session.settings.diff === 'mix' ? null : Number(session.settings.diff);
  const D = def => fixed || def;
  switch (cell.t) {
    case 'prop': return {cat: cell.cat, d: D(cell.tier), mult: 1};
    case 'chal': return {cat: null, d: D(3), mult: 2};
    case 'bonus': case 'pen': return {cat: null, d: D(2), mult: 1};
    case 'gojail': return {cat: null, d: D(3), mult: 1};
    case 'jail': return {cat: null, d: D(2), mult: 1};
    default: return {cat: null, d: D(1), mult: 1};
  }
}
function pickQuestion(t, cat, d) {
  const pool = QS.filter(q => !cat || q.c === cat);
  const fresh = pool.filter(q => !t.used.includes(q.id));
  let cand = fresh.filter(q => q.d === d);
  if (!cand.length) cand = fresh;
  if (!cand.length) {
    const ids = new Set(pool.map(q => q.id));
    t.used = t.used.filter(id => !ids.has(id));
    cand = pool.filter(q => q.d === d); if (!cand.length) cand = pool;
  }
  const q = cand[rnd(cand.length)];
  t.used.push(q.id);
  return q;
}
function startQuestion(t, steps) {
  const p = stu(curSid(t)), cell = G.CELLS[p.pos];
  const spec = questionSpec(cell);
  const q = pickQuestion(t, spec.cat, spec.d);
  const total = session.settings.timer + (q.d - 1) * 10;
  const grace = 1800 + steps * 230; // клиенттегі сүйек пен жүріс анимациясына уақыт
  t.q = {qid: q.id, order: q.type === 'mc' ? shuffle([0, 1, 2, 3]) : null, mult: spec.mult, cell: p.pos, total, deadline: now() + grace + total * 1000};
  t.phase = 'question'; t.result = null;
  t.phaseDeadline = t.q.deadline + 600; schedule(t, t.phaseDeadline - now());
}
function doAnswer(t, value, timeout) {
  if (t.phase !== 'question') return;
  const sid = curSid(t), p = stu(sid), q = QBYID.get(t.q.qid), cell = G.CELLS[t.q.cell];
  let correct = false, given = '';
  if (!timeout) {
    if (q.type === 'mc') {
      const j = Number(value);
      if (!(j >= 0 && j < 4)) return;
      correct = t.q.order[j] === 0; given = q.o[t.q.order[j]];
    } else {
      const v = parseNum(value); if (isNaN(v)) return;
      correct = Math.abs(v - q.a) < 1e-3; given = String(value).slice(0, 30);
    }
  }
  const r = G.REWARD[q.d], delta = correct ? r.win * t.q.mult : -r.lose * t.q.mult;
  chg(sid, delta);
  if (correct) p.ok++; else p.bad++;
  p.answers.push({qid: q.id, c: q.c, d: q.d, ok: correct, given: timeout ? '(уақыт бітті)' : given, t: now(), table: t.num});
  addLog(t, `${p.name}: ${correct ? 'дұрыс' : (timeout ? 'уақыт бітті' : 'қате')} (${G.CATS[q.c].name}) ${delta > 0 ? '+' : '−'}${Math.abs(delta)}`);

  const effects = []; let canBuy = false;
  const others = activePlayers(t).filter(o => o !== sid);
  switch (cell.t) {
    case 'prop': {
      const o = t.owners[cell.i];
      if (o == null) {
        if (p.coins >= cell.price) { canBuy = true; effects.push(`«${cell.name}» бос. Сатып аласыз ба? Бағасы: ${cell.price} тиын.`); }
        else effects.push(`«${cell.name}» бос, бірақ тиын жеткіліксіз (бағасы ${cell.price}).`);
      } else if (o !== sid) {
        let rent = rentOf(t, cell.i); const full = rent;
        if (correct) rent = Math.round(rent / 2);
        chg(sid, -rent); chg(o, rent);
        effects.push(`«${cell.name}» — ${stu(o).name} ойыншысының мүлкі. Жалдау ақысы: −${rent}${correct ? ` (дұрыс жауап үшін 50% жеңілдік, толық бағасы ${full})` : ''}.`);
        addLog(t, `${p.name} → ${stu(o).name}: жалдау ақысы ${rent}`);
      } else effects.push(`Бұл — өз мүлкіңіз («${cell.name}»).`);
      break;
    }
    case 'bonus': case 'pen': {
      const good = cell.t === 'bonus';
      const deck = good ? G.BONUS_CARDS : G.PEN_CARDS, c = deck[rnd(deck.length)];
      let v = c.v; let note = '';
      if (!good && correct && c.k !== 'jail') { v = Math.round(v / 2); note = ' Дұрыс жауап үшін айыппұл екі есе азайды.'; }
      if (c.k === 'money') chg(sid, v);
      else if (c.k === 'each') {
        if (good) { others.forEach(o => chg(o, -v)); chg(sid, v * others.length); }
        else { others.forEach(o => chg(o, v)); chg(sid, -v * others.length); }
      } else if (c.k === 'start') { p.pos = 0; chg(sid, G.START_BONUS); }
      else if (c.k === 'jail') {
        if (correct) note = ' Дұрыс жауап сізді құтқарды — Ойлану бөлмесіне бармайсыз!';
        else { p.pos = G.JAIL; p.skip = 1; }
      }
      effects.push(`${good ? '🎁 Сыйлық картасы' : '⚠️ Айыппұл картасы'}: ${c.t}${note}`);
      addLog(t, `${p.name}: ${good ? 'сыйлық' : 'айыппұл'} картасы`);
      break;
    }
    case 'rest': if (correct) { chg(sid, 50); effects.push('☕ Демалыс сыйы: +50 тиын.'); } break;
    case 'gojail':
      if (correct) effects.push('🛡️ Дұрыс жауап сізді Ойлану бөлмесінен құтқарды!');
      else { p.pos = G.JAIL; p.skip = 1; effects.push('🚨 Қате жауап — Ойлану бөлмесіне барасыз, келесі кезек өтеді.'); addLog(t, `${p.name} Ойлану бөлмесіне жіберілді.`); }
      break;
    case 'chal': effects.push('⚡ Сынақ: сыйақы мен айыппұл екі есе болды.'); break;
    default: break;
  }
  t.result = {
    correct, timeout: !!timeout, given: timeout ? '' : given, delta,
    answer: q.type === 'mc' ? q.o[0] : numText(q.a), expl: q.e,
    correctIdx: q.type === 'mc' ? t.q.order.indexOf(0) : null,
    chosenIdx: q.type === 'mc' && !timeout ? Number(value) : null,
    effects, canBuy, cell: cell.i, price: cell.price || 0,
  };
  t.phase = 'result';
  const wait = isOnline(sid) ? 35000 : 6000;
  t.phaseDeadline = now() + wait; schedule(t, wait);
}
function doContinue(t, buy) {
  if (t.phase !== 'result') return;
  const sid = curSid(t), p = stu(sid), r = t.result, cell = G.CELLS[r.cell];
  if (r.canBuy && buy && t.owners[cell.i] == null && p.coins >= cell.price) {
    t.owners[cell.i] = sid; chg(sid, -cell.price);
    addLog(t, `${p.name} «${cell.name}» мүлкін сатып алды (−${cell.price}).`);
  }
  endTurn(t);
}
function endTurn(t) {
  // банкрот
  for (const sid of t.players) {
    const s = stu(sid);
    if (s && s.active && s.coins < 0) {
      s.active = false; propsOf(t, sid).forEach(i => delete t.owners[i]);
      addLog(t, `💥 ${s.name} банкрот болды!`);
    }
  }
  const st = session.settings, alive = activePlayers(t);
  if (t.players.length > 1 && alive.length <= 1) return finishTable(t, alive.length ? `${stu(alive[0]).name} жалғыз қалды!` : 'Барлығы банкрот болды.');
  if (!alive.length) return finishTable(t, 'Ойыншы қалмады.');
  if (st.mode === 'target') {
    const reached = alive.map(stu).filter(s => s.coins >= st.target).sort((a, b) => b.coins - a.coins);
    if (reached.length) return finishTable(t, `${reached[0].name} ${st.target} тиынға жетті!`);
  }
  let n = t.cur;
  do { n = (n + 1) % t.players.length; } while (!stu(t.players[n]) || !stu(t.players[n]).active);
  if (n <= t.cur) {
    t.round++;
    if (t.round > st.rounds) { t.round = st.rounds; return finishTable(t, `${st.rounds} раунд аяқталды!`); }
    addLog(t, `— ${t.round}-раунд басталды —`);
  }
  t.cur = n;
  setRollPhase(t);
  broadcastTable(t);
}
function finishTable(t, reason) {
  t.over = true; t.phase = 'over'; t.endReason = reason; t.q = null; t.result = null; t.phaseDeadline = null;
  clearTimeout(timers.get(t.id)); timers.delete(t.id);
  addLog(t, `🏁 Ойын аяқталды: ${reason}`);
  if (session.status === 'running' && Object.values(session.tables).every(x => x.over)) {
    session.status = 'ended'; session.endedAt = now();
    broadcastAllStudents();
  } else broadcastTable(t);
  markDirty();
}
function endSession() {
  for (const t of Object.values(session.tables)) if (!t.over) {
    t.over = true; t.phase = 'over'; t.endReason = 'Мұғалім ойынды аяқтады.'; t.q = null; t.result = null; t.phaseDeadline = null;
    clearTimeout(timers.get(t.id)); timers.delete(t.id);
  }
  session.status = 'ended'; session.endedAt = now();
  markDirty(); broadcastAllStudents();
}

/* ------------------------------ RANKING ---------------------------- */
function ranking() {
  return Object.values(session.students).filter(s => !s.kicked)
    .sort((a, b) => (b.coins - a.coins) || (b.ok - a.ok) || (a.bad - b.bad) || a.name.localeCompare(b.name));
}

/* ------------------------------ VIEWS ------------------------------ */
function studentView(sid) {
  const s = stu(sid);
  if (!s || s.kicked) return {kicked: true};
  const base = {
    me: {id: sid, name: s.name}, status: session.status, settings: session.settings, serverNow: now(),
    students: Object.values(session.students).filter(x => !x.kicked).length,
  };
  if (session.status === 'ended') {
    const r = ranking(); base.overall = {rank: r.findIndex(x => x.id === sid) + 1, total: r.length,
      top: r.slice(0, 10).map(x => ({name: x.name, coins: x.coins, ok: x.ok, bad: x.bad}))};
  }
  const t = s.tableId && tbl(s.tableId);
  if (!t) return base;
  const view = {
    id: t.id, num: t.num, round: t.round, cur: curSid(t), phase: t.phase, owners: t.owners,
    log: t.log.slice(0, 25), move: t.move, over: t.over, endReason: t.endReason,
    deadlineIn: t.phaseDeadline ? t.phaseDeadline - now() : null,
    players: t.players.map((pid, k) => {
      const p = stu(pid);
      return {id: pid, name: p.name, color: G.COLORS[k % 4], token: G.TOKENS[k % 4], coins: p.coins, pos: p.pos,
        active: p.active, skip: p.skip, ok: p.ok, bad: p.bad, online: isOnline(pid), props: propsOf(t, pid)};
    }),
  };
  if (t.q && (t.phase === 'question' || t.phase === 'result')) {
    const q = QBYID.get(t.q.qid);
    view.q = {c: q.c, d: q.d, text: q.q, type: q.type, mult: t.q.mult, cell: t.q.cell, total: t.q.total,
      leftMs: t.q.deadline - now(), opts: q.type === 'mc' ? t.q.order.map(j => q.o[j]) : null,
      win: G.REWARD[q.d].win * t.q.mult, lose: G.REWARD[q.d].lose * t.q.mult};
  }
  if (t.phase === 'result') view.result = t.result;
  base.table = view;
  return base;
}
function dashboard() {
  const r = ranking();
  const catStats = {}; Object.keys(G.CATS).forEach(c => catStats[c] = {ok: 0, bad: 0});
  const qStats = new Map();
  let totalOk = 0, totalBad = 0;
  for (const s of r) for (const a of s.answers) {
    catStats[a.c][a.ok ? 'ok' : 'bad']++; a.ok ? totalOk++ : totalBad++;
    const x = qStats.get(a.qid) || {ok: 0, bad: 0}; x[a.ok ? 'ok' : 'bad']++; qStats.set(a.qid, x);
  }
  const hardest = [...qStats.entries()].filter(([, x]) => x.bad > 0)
    .sort((a, b) => (b[1].bad - a[1].bad) || (a[1].ok - b[1].ok)).slice(0, 8)
    .map(([qid, x]) => ({qid, c: QBYID.get(qid).c, q: QBYID.get(qid).q, ok: x.ok, bad: x.bad}));
  return {
    code: session.code, status: session.status, settings: session.settings, serverNow: now(),
    startedAt: session.startedAt, endedAt: session.endedAt,
    totals: {students: r.length, online: r.filter(s => isOnline(s.id)).length, ok: totalOk, bad: totalBad,
      tables: Object.keys(session.tables).length, tablesOver: Object.values(session.tables).filter(t => t.over).length},
    students: r.map((s, k) => {
      const t = s.tableId && tbl(s.tableId);
      let state = 'lobby';
      if (t) state = t.over ? 'over' : !s.active ? 'bankrupt' : curSid(t) === s.id ? (t.phase === 'question' ? 'answering' : 'turn') : 'waiting';
      return {id: s.id, rank: k + 1, name: s.name, table: t ? t.num : null, round: t ? t.round : null, coins: s.coins,
        ok: s.ok, bad: s.bad, props: t ? propsOf(t, s.id).length : 0, propValue: t ? propValue(t, s.id) : 0,
        pos: t ? s.pos : null, cell: t ? G.CELLS[s.pos].name : '', online: isOnline(s.id), state};
    }),
    catStats, hardest,
  };
}
function studentDetail(sid) {
  const s = stu(sid); if (!s) return null;
  return {name: s.name, coins: s.coins, ok: s.ok, bad: s.bad,
    answers: s.answers.slice().reverse().map(a => {
      const q = QBYID.get(a.qid);
      return {c: a.c, d: a.d, ok: a.ok, given: a.given, q: q.q, answer: q.type === 'mc' ? q.o[0] : numText(q.a), expl: q.e, t: a.t, table: a.table};
    })};
}

/* ------------------------------ SSE -------------------------------- */
function sse(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }
function sendStudent(sid) { const set = studentStreams.get(sid); if (!set || !set.size) return; const v = studentView(sid); for (const res of set) sse(res, 'state', v); }
function broadcastTable(t) { markDirty(); for (const sid of t.players) sendStudent(sid); }
let allTimer = null;
function broadcastAllStudents() { // жиі шақырылса да, 300 мс ішінде бір рет жібереді
  markDirty();
  if (allTimer) return;
  allTimer = setTimeout(() => { allTimer = null; if (session) for (const sid of studentStreams.keys()) sendStudent(sid); }, 300);
}
setInterval(() => {
  if (!session || !dashDirty || !adminStreams.size) return;
  dashDirty = false; const d = dashboard();
  for (const res of adminStreams) sse(res, 'dash', d);
}, 1000);
setInterval(() => { // байланысты сақтау
  for (const set of studentStreams.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (e) {} }
  for (const res of adminStreams) { try { res.write(': ping\n\n'); } catch (e) {} }
}, 20000);

/* ------------------------------ HTTP ------------------------------- */
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'};
function send(res, code, obj) { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
function isAdmin(req, url) {
  const k = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  const a = Buffer.from(String(k)), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function studentByToken(token) {
  if (!session || !token) return null;
  return Object.values(session.students).find(s => s.token === token && !s.kicked) || null;
}
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }

async function handleApi(req, res, url) {
  const p = url.pathname;
  // ---------- студент ----------
  if (p === '/api/info') return send(res, 200, {session: !!session, status: session ? session.status : null});
  if (p === '/api/join' && req.method === 'POST') {
    const b = await readBody(req);
    if (!session) return send(res, 400, {error: 'Мұғалім әлі ойын ашқан жоқ.'});
    if (String(b.code || '').trim() !== session.code) return send(res, 400, {error: 'Ойын коды қате.'});
    const existing = studentByToken(b.token);
    if (existing) return send(res, 200, {token: existing.token, id: existing.id});
    let name = cleanName(b.name);
    if (name.length < 2) return send(res, 400, {error: 'Аты-жөніңізді жазыңыз (кемінде 2 әріп).'});
    const list = Object.values(session.students);
    if (list.length >= MAX_STUDENTS) return send(res, 400, {error: 'Ойынға қосылушылар саны шегіне жетті.'});
    if (session.status === 'ended') return send(res, 400, {error: 'Ойын аяқталды.'});
    const base = name; let k = 2; while (list.some(s => s.name.toLowerCase() === name.toLowerCase())) name = `${base} (${k++})`;
    const s = {id: 's' + newId(5), token: newId(16), name, joinedAt: now(), tableId: null, seat: null,
      coins: G.START_COINS, pos: 0, active: true, skip: 0, ok: 0, bad: 0, answers: [], kicked: false};
    session.students[s.id] = s;
    if (session.status === 'running') placeLateStudent(s.id);
    broadcastAllStudents();
    return send(res, 200, {token: s.token, id: s.id});
  }
  if (p === '/api/stream') {
    const s = studentByToken(url.searchParams.get('token'));
    if (!s) return send(res, 401, {error: 'Қайта кіріңіз.'});
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
    res.write('retry: 2000\n\n');
    if (!studentStreams.has(s.id)) studentStreams.set(s.id, new Set());
    studentStreams.get(s.id).add(res);
    sendStudent(s.id);
    const t = s.tableId && tbl(s.tableId); if (t) broadcastTable(t); else dashDirty = true;
    req.on('close', () => {
      const set = studentStreams.get(s.id); if (set) { set.delete(res); if (!set.size) studentStreams.delete(s.id); }
      if (session) { const t2 = s.tableId && tbl(s.tableId); if (t2) broadcastTable(t2); dashDirty = true; }
    });
    return;
  }
  if (p === '/api/act' && req.method === 'POST') {
    const b = await readBody(req);
    const s = studentByToken(b.token);
    if (!s) return send(res, 401, {error: 'Қайта кіріңіз.'});
    const t = s.tableId && tbl(s.tableId);
    if (!t || t.over || session.status !== 'running') return send(res, 400, {error: 'Ойын жүріп жатқан жоқ.'});
    if (curSid(t) !== s.id) return send(res, 400, {error: 'Қазір сіздің кезегіңіз емес.'});
    if (b.action === 'roll' && t.phase === 'roll') doRoll(t, false);
    else if (b.action === 'answer' && t.phase === 'question') {
      if (now() > t.q.deadline + 1500) doAnswer(t, null, true); else doAnswer(t, b.value, false);
      if (t.phase === 'question') return send(res, 400, {error: 'Жауап форматы қате.'});
    }
    else if (b.action === 'continue' && t.phase === 'result') doContinue(t, !!b.buy);
    else return send(res, 400, {error: 'Бұл әрекет қазір мүмкін емес.'});
    broadcastTable(t);
    return send(res, 200, {ok: true});
  }
  // ---------- мұғалім ----------
  if (p.startsWith('/api/admin/')) {
    if (p === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req);
      const ok = (() => { const a = Buffer.from(String(b.password || '')), c = Buffer.from(ADMIN_PASSWORD); return a.length === c.length && crypto.timingSafeEqual(a, c); })();
      return ok ? send(res, 200, {ok: true, hasSession: !!session}) : send(res, 401, {error: 'Құпия сөз қате.'});
    }
    if (!isAdmin(req, url)) return send(res, 401, {error: 'Құпия сөз қате.'});
    if (p === '/api/admin/stream') {
      res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
      res.write('retry: 2000\n\n');
      adminStreams.add(res);
      sse(res, 'dash', session ? dashboard() : null);
      req.on('close', () => adminStreams.delete(res));
      return;
    }
    if (p === '/api/admin/new' && req.method === 'POST') {
      const b = await readBody(req); newSession(b.settings); return send(res, 200, {ok: true, code: session.code});
    }
    if (!session) return send(res, 400, {error: 'Алдымен жаңа сессия ашыңыз.'});
    if (p === '/api/admin/settings' && req.method === 'POST') {
      if (session.status !== 'lobby') return send(res, 400, {error: 'Ойын басталған соң баптауды өзгертуге болмайды.'});
      const b = await readBody(req); session.settings = cleanSettings(b.settings); markDirty(); broadcastAllStudents();
      return send(res, 200, {ok: true});
    }
    if (p === '/api/admin/start' && req.method === 'POST') {
      if (session.status !== 'lobby') return send(res, 400, {error: 'Ойын басталып қойған.'});
      if (!Object.values(session.students).some(s => !s.kicked)) return send(res, 400, {error: 'Әзірге бірде-бір студент қосылған жоқ.'});
      const b = await readBody(req); if (b.settings) session.settings = cleanSettings(b.settings);
      session.status = 'running'; session.startedAt = now();
      formTables(); markDirty(); broadcastAllStudents();
      return send(res, 200, {ok: true});
    }
    if (p === '/api/admin/end' && req.method === 'POST') {
      if (session.status !== 'running') return send(res, 400, {error: 'Ойын жүріп жатқан жоқ.'});
      endSession(); return send(res, 200, {ok: true});
    }
    if (p === '/api/admin/kick' && req.method === 'POST') {
      const b = await readBody(req); const s = stu(b.id);
      if (!s) return send(res, 404, {error: 'Студент табылмады.'});
      s.kicked = true;
      const t = s.tableId && tbl(s.tableId);
      if (t && !t.over) {
        const wasCur = curSid(t) === s.id;
        if (s.active) { s.active = false; propsOf(t, s.id).forEach(i => delete t.owners[i]); addLog(t, `${s.name} ойыннан шығарылды.`); }
        if (wasCur) endTurn(t); else broadcastTable(t);
      }
      for (const res2 of studentStreams.get(s.id) || []) sse(res2, 'state', {kicked: true});
      markDirty(); broadcastAllStudents();
      return send(res, 200, {ok: true});
    }
    if (p === '/api/admin/student') {
      const d = studentDetail(url.searchParams.get('id'));
      return d ? send(res, 200, d) : send(res, 404, {error: 'Студент табылмады.'});
    }
    if (p === '/api/admin/export.csv') {
      const rows = [['Орын', 'Аты-жөні', 'Үстел', 'Тиын', 'Дұрыс', 'Қате', 'Дәлдік %', 'Мүлік саны', 'Мүлік құны']];
      dashboard().students.forEach(s => rows.push([s.rank, s.name, s.table ?? '', s.coins, s.ok, s.bad,
        s.ok + s.bad ? Math.round(100 * s.ok / (s.ok + s.bad)) : '', s.props, s.propValue]));
      const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
      res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="natizheler.csv"'});
      return res.end(csv);
    }
  }
  send(res, 404, {error: 'Табылмады'});
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/teacher' || p === '/mugalim') p = '/teacher.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}); return res.end('Табылмады'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url).catch(e => { console.error(e); try { send(res, 500, {error: 'Сервер қатесі'}); } catch (_) {} });
  else serveStatic(req, res, url);
});
server.keepAliveTimeout = 65000;

loadSaved();
server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n==============================================');
  console.log('  МАТЕМАТИКАЛЫҚ МОНОПОЛИЯ — сервер іске қосылды');
  console.log('==============================================');
  console.log(`  Студенттерге арналған сілтеме:`);
  console.log(`     http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`     http://${ip}:${PORT}`));
  console.log(`  Мұғалім панелі:  http://localhost:${PORT}/teacher`);
  console.log(`  Мұғалімнің құпия сөзі:  ${ADMIN_PASSWORD}`);
  console.log('==============================================\n');
});
module.exports = {server};
