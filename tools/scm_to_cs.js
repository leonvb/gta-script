// Translates retail main.scm MISSION 0/1/2 (INITIAL/INTRO/HOTEL) from main_src.txt
// into a C# "flavour" sketch: typed handles, return values, named globals.
// Flavour rules are documented in the header of the generated file.
// Usage: node tools/scm_to_cs.js   -> writes csharp/Missions0_2.cs
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.VC_DB = require(path.join(ROOT, 'js', 'opcodes.js'));
const SCM = require(path.join(ROOT, 'js', 'scm.js'));
const SYM = require(path.join(ROOT, 'js', 'symbols.js'));

const SRC = fs.readFileSync(path.join(ROOT, 'main_src.txt'), 'utf8').split('\n');
const OUT = path.join(ROOT, 'csharp', 'Missions0_2.cs');
const warnings = [];
const warn = (m) => warnings.push(m);

// ---------- small utils ----------
const CS_KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue ' +
  'decimal default delegate do double else enum event explicit extern false finally fixed float for ' +
  'foreach goto if implicit in int interface internal is lock long namespace new null object operator ' +
  'out override params private protected public readonly ref return sbyte sealed short sizeof ' +
  'stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ' +
  'ushort using virtual void volatile while').split(' '));
const pascal = (s) => s.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
const camel = (s) => { const p = pascal(s); return p ? p[0].toLowerCase() + p.slice(1) : p; };
const lcfirst = (s) => s ? s[0].toLowerCase() + s.slice(1) : s;
const ident = (s) => CS_KEYWORDS.has(s) ? '@' + s : s;
const cleanIdent = (s) => {
  let r = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(r)) r = '_' + r;
  return ident(r);
};

// ---------- opcode metadata ----------
function opInfo(hexh) {
  const d = SCM.describeCommand(parseInt(hexh, 16));
  if (!d) throw new Error('unknown opcode ' + hexh);
  const ov = SPEC_OVERRIDE[hexh];
  if (ov) for (const [i, patch] of Object.entries(ov)) Object.assign(d.args[i], patch);
  return d;
}
// DB quirks corrected for the flavour mapping (descs swapped upstream):
// 016A DO_FADE <duration ms> <FADE mode> -- duration is wrongly tagged Bool,
// mode wrongly tagged Time.
const SPEC_OVERRIDE = {
  '016A': { 0: { desc: 'Time' }, 1: { desc: '' } }
};
const methodName = (opname) => pascal(opname);

// Entities -> handle struct names (all get bidirectional implicit int conversions,
// so handle/int mixing always compiles).
const ENTITY_STRUCT = {
  PLAYER: 'Player', CHAR: 'Char', CAR: 'Car', OBJECT: 'Obj', GANG_ZONE: 'GangZone',
  CAR_PARK: 'CarPark', CAR_GENERATOR: 'CarGen', BLIP: 'Blip', SOUND: 'Sound',
  PICKUP: 'Pickup', GARAGE: 'Garage', PHONE: 'Phone', COLL: 'Coll',
  SCRIPT_FIRE: 'ScriptFire', SPHERE: 'Sphere', OBJECT_PATH: 'ObjectPath'
};
// Enums -> C# enum names + member prefix/suffix to strip.
const ENUM_CS = {};
const ENUM_PRETTY = {
  CARCOLOUR: 'CarColour', CHANGECAMMODE: 'ChangeCamMode', DRIVINGMODE: 'DrivingMode',
  PEDTYPE: 'PedType', WEAPONTYPE: 'WeaponType', SETPIECE: 'SetPiece', PEDGRP: 'PedGroup'
};
for (const e of Object.keys(VC_DB.enums)) {
  if (e === 'MODEL' || e === 'DEFAULTMODEL') continue; // -> Model struct, not enum
  ENUM_CS[e] = ENUM_PRETTY[e] || pascal(e);
}
// Hand-split single-token compounds (keyed by stripped raw member) so call sites read well.
const MEMBER_PRETTY = {
  DRIVINGMODE: { STOPFORCARS: 'StopForCars', SLOWDOWNFORCARS: 'SlowDownForCars', AVOIDCARS: 'AvoidCars', PLOUGHTHROUGH: 'PloughThrough', STOPFORCARS_IGNORELIGHTS: 'StopForCarsIgnoreLights' },
  SETPIECE: { NONE: 'None', TWOCOPCARSINALLEY: 'TwoCopCarsInAlley', CARBLOCKINGPLAYERFROMSIDE: 'CarBlockingPlayerFromSide', CARRAMMINGPLAYERFROMSIDE: 'CarRammingPlayerFromSide', CREATECOPPERONFOOT: 'CreateCopperOnFoot', CREATETWOCOPPERSONFOOT: 'CreateTwoCoppersOnFoot', TWOCARSBLOCKINGPLAYERFROMSIDE: 'TwoCarsBlockingPlayerFromSide', TWOCARSRAMMINGPLAYERFROMSIDE: 'TwoCarsRammingPlayerFromSide' },
  PEDTYPE: { CIVMALE: 'CivMale', CIVFEMALE: 'CivFemale' },
  WEAPONTYPE: { BRASSKNUCKLE: 'BrassKnuckle', GOLFCLUB: 'GolfClub', NIGHTSTICK: 'Nightstick', BASEBALLBAT: 'BaseballBat', CHAINSAW: 'Chainsaw', TEARGAS: 'TearGas', SNIPERRIFLE: 'SniperRifle', LASERSCOPE: 'LaserScope', ROCKETLAUNCHER: 'RocketLauncher', FLAMETHROWER: 'Flamethrower', MINIGUN: 'Minigun', HELICANNON: 'HeliCannon', RAMMEDBYCAR: 'RammedByCar', RUNOVERBYCAR: 'RunOverByCar', ANYMELEE: 'AnyMelee', ANYWEAPON: 'AnyWeapon' },
  PEDGRP: { OCEAND1: 'OceanD1', OCEAND1_NIGHT: 'OceanD1Night', OCEAND2: 'OceanD2', OCEAND2_NIGHT: 'OceanD2Night' },
  CARCOLOUR: { POLICECARBLUE: 'PoliceCarBlue', CHERRYRED: 'CherryRed', MIDNIGHTBLUE: 'MidnightBlue', TEMPLECURTAINPURPLE: 'TempleCurtainPurple', TAXIYELLOW: 'TaxiYellow', STRIKINGBLUE: 'StrikingBlue', LIGHTBLUEGREY: 'LightBlueGrey' }
};
function enumMember(e, value) {
  const table = VC_DB.enums[e] || {};
  const hit = Object.keys(table).find(k => table[k] === value);
  if (hit === undefined) return null;
  let m = hit;
  const pre = e + '_';
  if (m.startsWith(pre)) m = m.slice(pre.length);
  if (e === 'PEDGRP' && m.endsWith('_PEDGRP')) m = m.slice(0, -7);
  if (MEMBER_PRETTY[e] && MEMBER_PRETTY[e][m]) return MEMBER_PRETTY[e][m];
  m = pascal(m);
  if (!m) m = 'V' + value;
  if (/^[0-9]/.test(m)) m = '_' + m;
  return m;
}

// ---------- source parsing ----------
// Parses one instruction line -> {op(hex), name, not, args[]}. Returns null for labels/comments/blank.
function parseInsn(line) {
  const m = line.match(/^(NOT )?([0-9A-F]{4}): (\S+)(.*)$/);
  if (!m) return null;
  const rest = m[4].trim();
  const args = [];
  if (rest) {
    // text args are single-quoted without spaces in this corpus; split carefully anyway
    let cur = '', quote = false;
    for (const ch of rest) {
      if (ch === "'") { quote = !quote; cur += ch; }
      else if ((ch === ' ' || ch === '\t') && !quote) { if (cur) { args.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) args.push(cur);
  }
  return { op: m[2], name: m[3], not: !!m[1], args };
}
function isLabel(line) { return /^:[A-Za-z0-9_]+$/.test(line.trim()); }
function labelName(line) { return line.trim().slice(1); }

// ---------- mission extraction ----------
function missionSpan(n) {
  const marker = `//===== SECTION:MISSION ${n} =====`;
  const a = SRC.indexOf(marker);
  if (a < 0) throw new Error('section not found: ' + marker);
  const nextMarker = `//===== SECTION:MISSION ${n + 1} =====`;
  let b = SRC.indexOf(nextMarker);
  if (b < 0) b = SRC.length;
  return [a, b]; // [inclusive, exclusive), 0-based
}
const MISSIONS = [
  { n: 0, cls: 'Mission0_Initial', subNames: {} },
  { n: 1, cls: 'Mission1_Intro', subNames: { L_386B: 'UpdateSkipState' } },
  { n: 2, cls: 'Mission2_Hotel', subNames: {} }
];
for (const M of MISSIONS) {
  const [a, b] = missionSpan(M.n);
  M.lines = SRC.slice(a, b);
  const hdr = M.lines.find(l => l.startsWith(`// MISSION ${M.n} @`));
  M.doc = hdr ? hdr.slice(3) : `MISSION ${M.n}`;
  const entry = M.lines.find(l => /^:(INITIAL|INTRO|[A-Z0-9_]+)$/.test(l.trim()) && !l.trim().startsWith(':L_'));
  M.entry = entry ? labelName(entry) : ('MISSION_' + M.n);
}

// ---------- pass A: per-mission inventory ----------
for (const M of MISSIONS) {
  M.globals = new Set(); M.models = new Set(); M.lvars = new Set();
  M.gosubs = new Set(); M.labels = []; M.ops = new Set(); M.texts = new Set();
  M.andorBlocks = 0;
  for (const ln of M.lines) {
    if (isLabel(ln)) { M.labels.push(labelName(ln)); continue; }
    const ins = parseInsn(ln);
    if (!ins) continue;
    M.ops.add(ins.op);
    if (ins.op === '00D6') M.andorBlocks++;
    if (ins.op === '0050') M.gosubs.add(ins.args[0].slice(1));
    for (const t of ins.args) {
      if (/^\$[0-9]+$/.test(t)) M.globals.add(+t.slice(1));
      else if (/^#[A-Za-z0-9_]+$/.test(t)) M.models.add(t.slice(1));
      else if (/^[0-9]+@$/.test(t)) M.lvars.add(t);
      else if (/^'.*'$/.test(t)) M.texts.add(t);
    }
    if (/\bTIMERA\b|\bTIMERB\b/.test(ln)) { if (/\bTIMERA\b/.test(ln)) M.lvars.add('TIMERA'); if (/\bTIMERB\b/.test(ln)) M.lvars.add('TIMERB'); }
  }
}

// ---------- pass B: entity inference (whole file) for handle typing ----------
const gVotes = new Map();   // off -> Set(entity)
const lVotes = new Map();   // missionN + ':' + lvar -> Set(entity)
const vote = (map, k, e) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(e); };
for (let mi = 0; mi < 97; mi++) {
  const [a, b] = missionSpan(mi);
  for (let i = a; i < b; i++) {
    const ins = parseInsn(SRC[i]);
    if (!ins || ins.op === '00D6') continue;
    const info = opInfo(ins.op);
    if (ins.args.length !== info.args.length) {
      // variadic/optional (START_NEW_SCRIPT's P args); only L/P trailing may be missing
      const missingOptional = ins.args.length < info.args.length &&
        info.args.slice(ins.args.length).every(x => x.type === 'P' || (x.flags & 1));
      if (!missingOptional) throw new Error(`arity mismatch ${ins.op} ${ins.name}: have ${ins.args.length}, want ${info.args.length} (line ${i + 1})`);
    }
    ins.args.forEach((tok, ai) => {
      const spec = info.args[ai];
      if (!spec || !spec.entity) return;
      if (/^\$[0-9]+$/.test(tok)) vote(gVotes, +tok.slice(1), spec.entity);
      else if (/^[0-9]+@$/.test(tok)) vote(lVotes, mi + ':' + tok, spec.entity);
    });
  }
}
// globals mutated by in-place arithmetic must stay int/float, never struct
const gArith = new Set();
for (let mi = 0; mi < 97; mi++) {
  const [a, b] = missionSpan(mi);
  for (let i = a; i < b; i++) {
    const ins = parseInsn(SRC[i]);
    if (!ins) continue;
    const id = parseInt(ins.op, 16);
    const mathy = (id >= 8 && id <= 23) || (id >= 88 && id <= 131) || (id >= 148 && id <= 151);
    if (mathy && /^\$[0-9]+$/.test(ins.args[0])) gArith.add(+ins.args[0].slice(1));
  }
}
function globalType(off) {
  const e = SYM.entry(off);
  if (!e) throw new Error('no symbol for $' + off);
  const votes = gVotes.get(off);
  if (votes && votes.size === 1 && !gArith.has(off) && e.t === 'I') {
    const ent = [...votes][0];
    if (ENTITY_STRUCT[ent]) return { cs: ENTITY_STRUCT[ent], kind: 'struct', entity: ent };
  }
  if (votes && votes.size > 1) warn(`$${off} (${e.name}) has conflicting entity votes [${[...votes]}]; kept int`);
  if (votes && votes.size === 1 && gArith.has(off)) warn(`$${off} (${e.name}) used in arithmetic; kept int despite ${[...votes]} vote`);
  return e.t === 'F' ? { cs: 'float', kind: 'float' } : { cs: 'int', kind: 'int' };
}
const GTYPE = new Map(); // off -> {cs, kind, entity?}
for (const M of MISSIONS) for (const off of M.globals) if (!GTYPE.has(off)) GTYPE.set(off, globalType(off));

// lvar types per mission: SET_LVAR_* + entity votes + outputs
function lvarTypes(M) {
  const types = new Map(); // '0@' -> {cs, kind, entity?}
  for (const lv of M.lvars) {
    if (lv === 'TIMERA' || lv === 'TIMERB') continue;
    const votes = lVotes.get(M.n + ':' + lv);
    let t = { cs: 'int', kind: 'int' };
    if (votes && votes.size === 1 && ENTITY_STRUCT[[...votes][0]]) {
      t = { cs: ENTITY_STRUCT[[...votes][0]], kind: 'struct', entity: [...votes][0] };
    }
    types.set(lv, t);
  }
  // SET_LVAR_FLOAT forces float; outputs confirm (assert agreement)
  for (const ln of M.lines) {
    const ins = parseInsn(ln);
    if (!ins) continue;
    if ((ins.op === '0006' || ins.op === '0007') && /^[0-9]+@$/.test(ins.args[0])) {
      const want = ins.op === '0007' ? 'float' : 'int';
      const cur = types.get(ins.args[0]);
      if (cur && cur.kind === 'int' && want === 'float') types.set(ins.args[0], { cs: 'float', kind: 'float' });
    }
  }
  return types;
}
for (const M of MISSIONS) M.lvarTypes = lvarTypes(M);
const lvarName = (lv) => lv === 'TIMERA' ? 'Scm.TimerA' : lv === 'TIMERB' ? 'Scm.TimerB' : 'l' + lv.slice(0, -1);

// ---------- pass B2: ops used as conditions (need bool returns) ----------
const condOpSet = new Set();
for (const M of MISSIONS) {
  for (let i = 0; i < M.lines.length; i++) {
    const m = M.lines[i].match(/^00D6: ANDOR (-?\d+)/);
    if (!m) continue;
    const v = +m[1], n = v >= 20 ? v - 19 : v + 1;
    for (let k = 1; k <= n; k++) {
      const c = parseInsn(M.lines[i + k]);
      if (c) condOpSet.add(c.op);
    }
  }
}

// ---------- pass C: emission ----------
// Which enums / structs / models / API ops are actually needed by M0-2?
const needEnums = new Set(), needStructs = new Set(), needModels = new Set(), needOps = new Set();
for (const M of MISSIONS) {
  for (const off of M.globals) { const t = GTYPE.get(off); if (t.kind === 'struct') needStructs.add(t.entity); }
  for (const [, t] of M.lvarTypes) if (t.kind === 'struct') needStructs.add(t.entity);
  for (const m of M.models) needModels.add(m);
  for (const ln of M.lines) {
    const ins = parseInsn(ln);
    if (!ins) continue;
    const info = opInfo(ins.op);
    info.args.forEach((a) => {
      if (a.enm && ENUM_CS[a.enm]) needEnums.add(a.enm);
      if (a.entity && ENTITY_STRUCT[a.entity]) needStructs.add(a.entity);
    });
  }
}
const SPECIAL_OPS = new Set(['0002', '0004', '0005', '0006', '0007', '004D', '004F', '0050', '0051', '00D6']);
// WAIT (0001) stays an API call; START_NEW_SCRIPT (004F) is hardcoded below (params array).
// + arithmetic/copy/compare families handled by name pattern (see emitInsn)
for (const M of MISSIONS) for (const op of M.ops) needOps.add(op);

function escStr(t) {
  const inner = t.slice(1, -1);
  return '"' + inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function fmtFloat(tok) {
  if (/^[+-]?[0-9]+$/.test(tok)) return tok + '.0f';
  return tok + 'f';
}
// Render one argument token given its spec; returns C# expr.
function renderArg(M, spec, tok, ctx) {
  const isOut = (spec.flags & 2) !== 0;
  if (isOut) throw new Error('renderArg called on output arg');
  if (spec.type === 'T') {
    if (!/^'.*'$/.test(tok)) warn(`T-arg got non-text token ${tok} in ${ctx}`);
    return escStr(/^'.*'$/.test(tok) ? tok : `'${tok}'`);
  }
  if (spec.type === 'L') return tok.startsWith('@') ? tok.slice(1) : tok; // goto/gosub/script-name sites special-case
  if (tok.startsWith('#')) {
    const m = tok.slice(1);
    if (!needModels.has(m)) throw new Error('model not collected: ' + m);
    return 'Model.' + m;
  }
  if (tok.startsWith('@')) return escStr(`'${tok.slice(1)}'`); // START_NEW_SCRIPT label -> script name
  let base, baseKind; // int | float | struct(entity) | literal
  let m;
  if ((m = tok.match(/^\$([0-9]+)$/))) {
    const off = +m[1], e = SYM.entry(off), t = GTYPE.get(off);
    if (!e || !t) throw new Error('unknown global ' + tok);
    base = 'Globals.' + cleanIdent(e.name); baseKind = t.kind; base = { e: base, ent: t.entity };
  } else if (/^([0-9]+@|TIMERA|TIMERB)$/.test(tok)) {
    base = lvarName(tok);
    if (tok === 'TIMERA' || tok === 'TIMERB') baseKind = 'int';
    else { const t = M.lvarTypes.get(tok); baseKind = t.kind; base = { e: base, ent: t.entity }; }
    if (typeof base === 'string') base = { e: base, ent: undefined };
  } else if (/^[+-]?[0-9]+$/.test(tok)) { base = { e: tok, ent: undefined }; baseKind = 'intlit'; }
  else if (/^[+-]?[0-9]*\.[0-9]+$/.test(tok)) { base = { e: fmtFloat(tok), ent: undefined }; baseKind = 'floatlit'; }
  else throw new Error(`unparseable token ${tok} in ${ctx}`);

  // bool params
  if (spec.type === 'I' && spec.desc === 'Bool') {
    if (baseKind === 'intlit') {
      if (tok !== '0' && tok !== '1') warn(`Bool literal ${tok} in ${ctx}`);
      return tok === '1' ? 'true' : tok === '0' ? 'false' : `(${tok} != 0)`;
    }
    return `${base.e} != 0`;
  }
  // enum params (non-model enums)
  if (spec.type === 'I' && spec.enm && ENUM_CS[spec.enm]) {
    const cs = ENUM_CS[spec.enm];
    if (baseKind === 'intlit') {
      const mem = enumMember(spec.enm, +tok);
      return mem ? `${cs}.${mem}` : `(${cs})${tok}`;
    }
    if (baseKind === 'struct') return `(${cs})(int)${base.e}`;
    if (baseKind === 'float') return `(${cs})(int)${base.e}`;
    return `(${cs})${base.e}`;
  }
  // float params
  if (spec.type === 'F') {
    if (baseKind === 'floatlit' || baseKind === 'float') return base.e;
    if (baseKind === 'intlit') return fmtFloat(tok);
    if (baseKind === 'int') return `(float)${base.e}`;
    warn(`struct passed to float param in ${ctx}`);
    return `(float)(int)${base.e}`;
  }
  // int params (plain or entity)
  if (spec.type === 'I' || spec.type === 'C') {
    if (baseKind === 'floatlit') { warn(`float literal to int param in ${ctx}`); return `(int)${base.e}`; }
    if (baseKind === 'float') return `(int)${base.e}`;
    if (spec.entity && ENTITY_STRUCT[spec.entity]) {
      if (baseKind === 'struct' && base.ent === spec.entity) return base.e;
      if (baseKind === 'struct') { warn(`struct type mismatch (${base.ent}->${spec.entity}) in ${ctx}`); return `(int)${base.e}`; }
      return base.e; // int / intlit convert implicitly to the handle struct
    }
    if (baseKind === 'struct') return base.e; // implicit struct -> int
    return base.e;
  }
  warn(`unhandled spec type ${spec.type} in ${ctx}`);
  return base.e;
}
function renderTarget(M, tok, ctx) {
  if (/^\$[0-9]+$/.test(tok)) {
    const e = SYM.entry(+tok.slice(1));
    return 'Globals.' + cleanIdent(e.name);
  }
  if (/^([0-9]+@|TIMERA|TIMERB)$/.test(tok)) return lvarName(tok);
  throw new Error(`bad output target ${tok} in ${ctx}`);
}

// comparison ops -> C# operators
function compareOp(opname) {
  if (opname.includes('_NOT_EQUAL_')) return '!=';
  if (opname.includes('_EQUAL_TO_')) return '==';
  if (opname.includes('_GREATER_OR_EQUAL_')) return '>=';
  if (opname.includes('_GREATER_THAN_')) return '>';
  return null;
}
function renderCondition(M, ins, ctx) {
  const info = opInfo(ins.op);
  const cmp = compareOp(ins.name);
  let expr;
  if (cmp && info.args.length === 2) {
    let a = renderArg(M, info.args[0], ins.args[0], ctx);
    let b = renderArg(M, info.args[1], ins.args[1], ctx);
    // relational ops need ints, not handle structs
    if (cmp === '>' || cmp === '>=') {
      const wrap = (spec, tok, r) => {
        if (/^\$[0-9]+$/.test(tok) && GTYPE.get(+tok.slice(1)).kind === 'struct') return `(int)${r}`;
        if (/^[0-9]+@$/.test(tok) && M.lvarTypes.get(tok).kind === 'struct') return `(int)${r}`;
        return r;
      };
      a = wrap(info.args[0], ins.args[0], a);
      b = wrap(info.args[1], ins.args[1], b);
    }
    expr = `${a} ${cmp} ${b}`;
  } else {
    expr = renderCall(M, ins, null, ctx);
  }
  return ins.not ? `!${expr.startsWith('Scm.') ? expr : `(${expr})`}` : expr;
}
function renderCall(M, ins, outTarget, ctx) {
  const info = opInfo(ins.op);
  const parts = [];
  ins.args.forEach((tok, i) => {
    const spec = info.args[i];
    if (!spec) throw new Error(`extra arg ${tok} for ${ins.op} in ${ctx}`);
    if (spec.flags & 2) {
      if (outTarget === undefined) throw new Error(`unexpected output arg in ${ctx}`);
      return; // consumed as assignment target / out var
    }
    parts.push(renderArg(M, spec, tok, ctx));
  });
  return `Scm.${methodName(ins.name)}(${parts.join(', ')})`;
}

function emitMission(M) {
  const L = [];
  const subLabels = new Set(M.gosubs);
  // validate subroutine ranges: target label .. first RETURN, single RETURN, last line of range
  const idxOf = {};
  M.lines.forEach((ln, i) => { if (isLabel(ln)) idxOf[labelName(ln)] = i; });
  for (const s of subLabels) {
    if (!(s in idxOf)) throw new Error(`gosub target missing: ${s}`);
    let ret = -1, n = 0;
    for (let i = idxOf[s]; i < M.lines.length; i++) {
      const ins = parseInsn(M.lines[i]);
      if (ins && ins.op === '0051') { n++; if (ret < 0) ret = i; }
      if (isLabel(M.lines[i]) && i > idxOf[s] && subLabels.has(labelName(M.lines[i]))) break;
    }
    if (n !== 1) throw new Error(`sub ${s}: expected 1 RETURN, found ${n}`);
    M['subEnd_' + s] = ret;
  }
  const inSub = (i) => {
    for (const s of subLabels) if (i >= idxOf[s] && i <= M['subEnd_' + s]) return s;
    return null;
  };
  const emitRange = (a, b, out, stats) => {
    for (let i = a; i <= b; i++) {
      const ln = M.lines[i], ctx = `${M.cls} line ${i + 1}`;
      if (!ln.trim() || ln.trim().startsWith('//')) continue;
      if (isLabel(ln)) {
        const lb = labelName(ln);
        if (lb === M.entry) continue;
        if (subLabels.has(lb)) continue; // becomes a method
        out.push(`            ${lb}:;`); // label + null statement keeps C# happy before `}`
        stats.labels++;
        continue;
      }
      const ins = parseInsn(ln);
      if (!ins) throw new Error('unparsed line: ' + ln);
      stats.insns++;
      const id = parseInt(ins.op, 16);
      // ANDOR block
      if (ins.op === '00D6') {
        const v = +ins.args[0];
        const n = v >= 20 ? v - 19 : v + 1;
        const isOr = v >= 20;
        if (!(n >= 1 && n <= 8)) throw new Error(`bad ANDOR ${v} in ${ctx}`);
        const conds = [];
        for (let k = 1; k <= n; k++) {
          const c = parseInsn(M.lines[i + k]);
          if (!c) throw new Error(`bad condition line ${ctx}+${k}`);
          conds.push(renderCondition(M, c, ctx));
          stats.insns++;
        }
        const g = parseInsn(M.lines[i + n + 1]);
        if (!g || g.op !== '004D') throw new Error(`ANDOR not followed by GOTO_IF_FALSE in ${ctx}`);
        stats.insns++;
        const joiner = isOr ? ' || ' : ' && ';
        let guard;
        if (conds.length === 1 && conds[0].startsWith('!')) {
          guard = conds[0].slice(1); // !(!x) -> x
        } else {
          const test = conds.join(joiner);
          guard = conds.length === 1 && /^Scm\.\w+\(.*\)$/.test(test) ? `!${test}` : `!(${test})`;
        }
        out.push(`            if (${guard}) goto ${g.args[0].slice(1)};`);
        stats.ifs++;
        i += n + 1;
        continue;
      }
      const arith = (id >= 8 && id <= 23) || (id >= 88 && id <= 119);
      const mathName = arith && !ins.name.includes('TIMED') ? ins.name : null;
      if (mathName && (mathName.startsWith('ADD_') || mathName.startsWith('SUB_') ||
          mathName.startsWith('MULT_') || mathName.startsWith('DIV_'))) {
        const op = mathName.startsWith('ADD_') ? '+=' : mathName.startsWith('SUB_') ? '-=' :
          mathName.startsWith('MULT_') ? '*=' : '/=';
        const info = opInfo(ins.op);
        const t = renderTarget(M, ins.args[0], ctx);
        const v = renderArg(M, info.args[1], ins.args[1], ctx);
        out.push(`            ${t} ${op} ${v};`);
        continue;
      }
      if (/^(SET|CSET)_.*_TO_/.test(ins.name) && ins.args.length === 2) {
        const t = renderTarget(M, ins.args[0], ctx);
        const info = opInfo(ins.op);
        let v = renderArg(M, info.args[1], ins.args[1], ctx);
        if (ins.name.startsWith('CSET_')) {
          const toFloat = info.args[0].type === 'F';
          v = toFloat ? `(float)${v}` : `(int)${v}`;
        }
        out.push(`            ${t} = ${v};`);
        continue;
      }
      if (ins.name.startsWith('ABS_')) {
        const t = renderTarget(M, ins.args[0], ctx);
        out.push(`            ${t} = Scm.Abs(${t});`);
        continue;
      }
      switch (ins.op) {
        case '0001': { // WAIT
          const info = opInfo(ins.op);
          out.push(`            Scm.Wait(${renderArg(M, info.args[0], ins.args[0], ctx)});`);
          break;
        }
        case '0002': out.push(`            goto ${ins.args[0].slice(1)};`); break;
        case '0004': case '0005': case '0006': case '0007': {
          const info = opInfo(ins.op);
          const t = renderTarget(M, ins.args[0], ctx);
          out.push(`            ${t} = ${renderArg(M, info.args[1], ins.args[1], ctx)};`);
          break;
        }
        case '004F': { // START_NEW_SCRIPT @label
          const extra = ins.args.slice(1).map(t => ', ' + t).join('');
          out.push(`            Scm.StartNewScript(${escStr(`'${ins.args[0].slice(1)}'`) + extra});`);
          break;
        }
        case '0050': { // GOSUB -> method call
          const s = ins.args[0].slice(1);
          out.push(`            ${M.subNames[s] || ('Sub_' + s)}();`);
          break;
        }
        case '0051': out.push('            return;'); break;
        default: {
          const info = opInfo(ins.op);
          const outs = info.args.map((a, i) => (a.flags & 2) ? i : -1).filter(i => i >= 0);
          if (outs.length === 0) {
            if (compareOp(ins.name)) warn(`comparison ${ins.name} as statement in ${ctx}`);
            out.push(`            ${renderCall(M, ins, null, ctx)};`);
          } else if (outs.length === 1 && outs[0] === ins.args.length - 1 && outs[0] === info.args.length - 1) {
            const t = renderTarget(M, ins.args[outs[0]], ctx);
            out.push(`            ${t} = ${renderCall(M, ins, t, ctx)};`);
          } else {
            throw new Error(`unsupported output shape ${ins.op} ${ins.name} in ${ctx}`);
          }
        }
      }
    }
  };
  const stats = { insns: 0, ifs: 0, labels: 0 };
  L.push(`    /// <summary>${M.doc.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</summary>`);
  L.push(`    public static class ${M.cls}`);
  L.push('    {');
  // main range: from entry label to (first sub label || end)
  const mainEndDefault = M.lines.length - 1;
  let mainEnd = mainEndDefault;
  for (const s of subLabels) mainEnd = Math.min(mainEnd, idxOf[s] - 1);
  const entryIdx = idxOf[M.entry];
  L.push('        public static void Main()');
  L.push('        {');
  const lvs = [...M.lvars].filter(l => l !== 'TIMERA' && l !== 'TIMERB')
    .sort((a, b) => parseInt(a) - parseInt(b));
  for (const lv of lvs) {
    const t = M.lvarTypes.get(lv);
    L.push(`            ${t.cs} ${lvarName(lv)} = default; // ${lv}`);
  }
  if (lvs.length) L.push('');
  const body = [];
  emitRange(entryIdx + 1, mainEnd, body, stats);
  L.push(...body);
  L.push('        }');
  for (const s of subLabels) {
    L.push('');
    L.push(`        // Subroutine @${s}: polled every frame while a cutscene runs.`);
    L.push(`        // $52: 0 = waiting for the player to release the skip buttons,`);
    L.push('        //      1 = armed, 2 = cutscene skipped (engine flag seen).');
    L.push(`        private static void ${M.subNames[s] || ('Sub_' + s)}()`);
    L.push('        {');
    const sb = [];
    emitRange(idxOf[s] + 1, M['subEnd_' + s], sb, stats);
    L.push(...sb);
    L.push('        }');
  }
  L.push('    }');
  return { code: L.join('\n'), stats };
}

// ---------- API signatures ----------
function apiSigs() {
  const ops = [...needOps].filter(op =>
    !SPECIAL_OPS.has(op) &&
    !/^(SET|CSET)_.*_TO_/.test(opInfo(op).name) &&
    !opInfo(op).name.startsWith('ABS_') &&
    !(opInfo(op).name.includes('TIMED') && /^(ADD|SUB)_/.test(opInfo(op).name)) &&
    !((parseInt(op, 16) >= 8 && parseInt(op, 16) <= 23) || (parseInt(op, 16) >= 88 && parseInt(op, 16) <= 119))
  ).sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
  // TIMED/ABS fallback note: none appear in M0-2; Abs() declared below anyway.
  const L = [];
  const usedNames = new Set();
  for (const op of ops) {
    const info = opInfo(op);
    const mname = methodName(info.name);
    if (usedNames.has(mname)) throw new Error('method name clash: ' + mname);
    usedNames.add(mname);
    const params = [];
    let ret = 'void';
    const hasOut = info.args.some(a => a.flags & 2);
    if (!hasOut && condOpSet.has(op)) ret = 'bool'; // predicates used in ANDOR blocks
    const seen = new Set();
    info.args.forEach((a, i) => {
      if (a.flags & 2) { // single last output -> return value (validated at emit)
        ret = csTypeOf(a);
        return;
      }
      let pname;
      if (a.desc === 'Bool') pname = 'flag';
      else if (a.desc) pname = camel(a.desc.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/ +/g, '_'));
      else if (a.type === 'T') pname = 'text';
      else if (a.enm && ENUM_CS[a.enm]) pname = lcfirst(ENUM_CS[a.enm]);
      else if (a.enm) pname = 'model';
      else if (a.entity) pname = lcfirst(ENTITY_STRUCT[a.entity]);
      else pname = 'arg' + i;
      if (pname === 'char') pname = 'character'; // C# keyword
      if (!pname) pname = 'arg' + i;
      pname = cleanIdent(pname);
      if (seen.has(pname)) { let k = 2; while (seen.has(pname + k)) k++; pname = pname + k; }
      seen.add(pname);
      params.push(`${csTypeOf(a)} ${pname}`);
    });
    L.push(`        /// <summary><c>${op}: ${info.name}</c></summary>`);
    L.push(`        public static ${ret} ${mname}(${params.join(', ')}) => throw new NotImplementedException();`);
  }
  return L.join('\n');
}
function csTypeOf(a) {
  if (a.type === 'F') return 'float';
  if (a.type === 'T') return 'string';
  if (a.type === 'L') return 'string'; // only START_NEW_SCRIPT's script label reaches here
  if (a.type === 'P') return 'int[]';
  if (a.type === 'I' || a.type === 'C') {
    if (a.desc === 'Bool') return 'bool';
    if (a.enm && ENUM_CS[a.enm]) return ENUM_CS[a.enm];
    if (a.enm) return 'Model'; // MODEL / DEFAULTMODEL
    if (a.entity && ENTITY_STRUCT[a.entity]) return ENTITY_STRUCT[a.entity];
    return 'int';
  }
  return 'int';
}

// ---------- file assembly ----------
const out = [];
out.push('// <auto-generated by tools/scm_to_cs.js -- DO NOT EDIT>');
out.push('// C# flavour sketch of the retail Vice City MISSION 0 (INITIAL),');
out.push('// MISSION 1 (INTRO) and MISSION 2 (HOTEL): the full game-opening');
out.push('// sequence, translated 1:1 from main_src.txt.');
out.push('//');
out.push('// Flavour rules used here:');
out.push('// - Every opcode is a static Scm.Method(); opcodes that write a variable');
out.push('//   return the value instead (x = Scm.GetCutsceneTime();).');
out.push('// - SCM int/float split is preserved: int stays int, float stays float.');
out.push('// - Entity handles are distinct structs (Car, Char, Obj, ...) with');
out.push('//   implicit int conversions, so handle/int mixing still compiles.');
out.push('// - Globals keep their friendly symbol names (Globals.mission_flag);');
out.push('//   the $offset, category and read/write stats ride along in comments.');
out.push('// - Models are Model.ADMIRAL etc.; text labels are plain strings.');
out.push('// - Control flow is preserved as-is (labels/goto/if), GOSUB becomes a');
out.push('//   private method call. A fancier compiler could structure the loops;');
out.push('//   this sketch stays line-faithful so the logic can be checked.');
out.push('// - This file is never executed as C# (methods throw); it is the input');
out.push('//   a flavour compiler would lower back to SCM assembly/bytecode.');
out.push('using System;');
out.push('');
out.push('namespace VcFlavour');
out.push('{');
// handle structs
for (const ent of Object.keys(ENTITY_STRUCT)) {
  if (!needStructs.has(ent)) continue;
  const N = ENTITY_STRUCT[ent];
  out.push(`    /// <summary>SCM ${ent} handle (an int on the wire).</summary>`);
  out.push(`    public readonly struct ${N} : IEquatable<${N}>`);
  out.push('    {');
  out.push('        public readonly int Handle;');
  out.push(`        public ${N}(int handle) { Handle = handle; }`);
  out.push(`        public static implicit operator int(${N} v) => v.Handle;`);
  out.push(`        public static implicit operator ${N}(int v) => new ${N}(v);`);
  out.push(`        public static bool operator ==(${N} a, ${N} b) => a.Handle == b.Handle;`);
  out.push(`        public static bool operator !=(${N} a, ${N} b) => a.Handle != b.Handle;`);
  out.push(`        public static bool operator ==(${N} a, int b) => a.Handle == b;`);
  out.push(`        public static bool operator !=(${N} a, int b) => a.Handle != b;`);
  out.push(`        public static bool operator ==(int a, ${N} b) => a == b.Handle;`);
  out.push(`        public static bool operator !=(int a, ${N} b) => a != b.Handle;`);
  out.push(`        public bool Equals(${N} other) => Handle == other.Handle;`);
  out.push(`        public override bool Equals(object obj) => obj is ${N} o && o.Handle == Handle;`);
  out.push('        public override int GetHashCode() => Handle;');
  out.push(`        public override string ToString() => "${N}(" + Handle + ")";`);
  out.push('    }');
}
// Model struct
out.push('    /// <summary>SCM model reference (#NAME in assembly).</summary>');
out.push('    public readonly struct Model : IEquatable<Model>');
out.push('    {');
out.push('        public readonly int Id;');
out.push('        public readonly string Name;');
out.push('        public Model(int id, string name = null) { Id = id; Name = name; }');
out.push('        public static implicit operator int(Model v) => v.Id;');
out.push('        public static implicit operator Model(int v) => new Model(v);');
out.push('        public bool Equals(Model other) => Id == other.Id && Name == other.Name;');
out.push('        public override bool Equals(object obj) => obj is Model o && Equals(o);');
out.push('        public override int GetHashCode() => Id;');
out.push('        public override string ToString() => Name ?? ("model:" + Id);');
for (const mname of [...needModels].sort()) {
  const id = VC_DB.models[mname];
  if (id === undefined) out.push(`        public static readonly Model ${mname} = new Model(-1, "${mname}"); // id resolved by the flavour compiler`);
  else out.push(`        public static readonly Model ${mname} = new Model(${id}, "${mname}");`);
}
out.push('    }');
// enums
for (const e of [...needEnums].sort()) {
  const cs = ENUM_CS[e];
  out.push(`    public enum ${cs}`);
  out.push('    {');
  const table = VC_DB.enums[e];
  const seenMem = new Set();
  for (const [raw, val] of Object.entries(table)) {
    let mem = enumMember(e, val);
    if (seenMem.has(mem)) mem = `${mem}_${val}`;
    seenMem.add(mem);
    out.push(`        ${mem} = ${val}, // ${raw}`);
  }
  out.push('    }');
}
// Scm API
out.push('    /// <summary>One method per opcode used by these missions.</summary>');
out.push('    public static class Scm');
out.push('    {');
out.push('        public static int TimerA { get; set; } // TIMERA');
out.push('        public static int TimerB { get; set; } // TIMERB');
out.push('        public static void StartNewScript(string label, params int[] args) => throw new NotImplementedException();');
out.push('        public static int Abs(int v) => throw new NotImplementedException();');
out.push('        public static float Abs(float v) => throw new NotImplementedException();');
out.push(apiSigs());
out.push('    }');
// Globals
const allG = [...new Set(MISSIONS.flatMap(M => [...M.globals]))].sort((a, b) => a - b);
out.push(`    /// <summary>${allG.length} globals referenced by missions 0-2.</summary>`);
out.push('    public static class Globals');
out.push('    {');
for (const off of allG) {
  const e = SYM.entry(off), t = GTYPE.get(off);
  out.push(`        public static ${t.cs} ${cleanIdent(e.name)}; // $${off} - ${e.cat} - w${e.w} r${e.r}`);
}
out.push('    }');
// missions
let totalInsns = 0, totalIfs = 0, totalLabels = 0;
for (const M of MISSIONS) {
  const { code, stats } = emitMission(M);
  out.push(code);
  totalInsns += stats.insns; totalIfs += stats.ifs; totalLabels += stats.labels;
}
out.push('}');
out.push('');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n'));
console.log('wrote', OUT);
console.log(`globals=${allG.length} models=${needModels.size} enums=${needEnums.size} structs=${needStructs.size}`);
console.log(`insns=${totalInsns} ifs=${totalIfs} labels=${totalLabels}`);
const expect = MISSIONS.reduce((s, M) => s + M.lines.filter(l => parseInsn(l)).length, 0);
console.log(`source insns=${expect} ${expect === totalInsns ? 'MATCH' : 'MISMATCH!'}`);
if (warnings.length) {
  console.log(`warnings (${warnings.length}):`);
  [...new Set(warnings)].slice(0, 40).forEach(w => console.log('  -', w));
}
