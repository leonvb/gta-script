/* Vice City SCM Studio -- core engine (DOM-free, runs in browser & Node).
 *
 * Disassembles / assembles GTA Vice City ("Miami", target byte 'm') main.scm
 * files using the low-level text format documented in the in-app Guide.
 *
 * Format facts implemented here were verified against:
 *  - gta3sc (MIT, thelink2012) disassembler/codegen + gtavc opcode database
 *  - reVC game-engine sources (src/control/Script*.h,cpp)
 *  - gtamods.com SCM_language wiki
 * and validated by round-tripping the retail main.scm (153,058 instructions).
 */
var SCM = (function () {
"use strict";

/* ============================== constants ============================== */

var VERSION = "1.0.0";

var TARGET_MIAMI = 0x6D; // 'm' platform byte after the first header GOTO

var LIMITS = {
  mainSizePC: 225512,   // CTheScripts::SIZE_MAIN_SCRIPT (PC/Xbox)
  mainSizePS2: 205512,  // same on PS2
  missionSize: 35000,   // CTheScripts::SIZE_MISSION_SCRIPT
  maxObjects: 220,      // MAX_NUM_USED_OBJECTS (incl. dummy entry 0)
  maxMissions: 120,     // MAX_NUM_MISSION_SCRIPTS
  maxGlobals: 65536,    // global var offset is u16; size_globals <= 0x10000
  maxLocal: 17,         // 0..15 locals, 16 TIMERA, 17 TIMERB
  maxScripts: 128
};

// operand type bytes in the binary (reVC eScriptParam / gta3sc disassembler)
var OT_END = 0x00, OT_I32 = 0x01, OT_GVAR = 0x02, OT_LVAR = 0x03,
    OT_I8 = 0x04, OT_I16 = 0x05, OT_F32 = 0x06;

// argument spec flags (see tools/build_db.py)
var F_OPT = 1, F_OUT = 2, F_NOCONST = 4, F_NOGLOB = 8, F_NOLOCAL = 16;

/* ============================== tiny utils ============================= */

function hex(n, w) {
  var s = (n >>> 0).toString(16).toUpperCase();
  while (s.length < w) s = "0" + s;
  return s;
}

function fail(msg) { throw new Error(msg); }

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" ||
         ch === "\f" || ch === "\v";
}

// Levenshtein distance for "did you mean" suggestions.
function lev(a, b) {
  if (a === b) return 0;
  var la = a.length, lb = b.length;
  if (!la) return lb; if (!lb) return la;
  var row = [], i, j;
  for (i = 0; i <= lb; i++) row[i] = i;
  for (i = 1; i <= la; i++) {
    var prev = i - 1, cur;
    row[0] = i;
    for (j = 1; j <= lb; j++) {
      cur = row[j];
      var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      var v = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur; row[j] = v;
    }
  }
  return row[lb];
}

/* ============================ opcode database =========================== */

function DB() {
  if (typeof VC_DB === "undefined" || !VC_DB) fail("opcode database (VC_DB) not loaded");
  return VC_DB;
}

function cmdById(id) { var e = DB().ops[id]; return e === undefined ? null : e; }
function cmdIdByName(name) {
  var id = DB().byName[String(name).toUpperCase()];
  return id === undefined ? null : id;
}
function cmdArgs(cmd) { return cmd[1]; }
function cmdName(cmd) { return cmd[0]; }
function cmdUnsupported(cmd) { return cmd.length > 2 && cmd[2] === 1; }
function argType(a) { return a[0]; }
function argFlags(a) { return a[1]; }
function argDesc(a) { return a.length > 2 ? a[2] : ""; }
function argEnum(a) { return a.length > 3 ? a[3] : ""; }
function argEntity(a) { return a.length > 4 ? a[4] : ""; }

function isVariadic(cmd) {
  var a = cmdArgs(cmd);
  return a.length > 0 && (a[a.length - 1][1] & F_OPT) !== 0;
}
function minArgs(cmd) {
  var a = cmdArgs(cmd);
  return (a.length && (a[a.length - 1][1] & F_OPT)) ? a.length - 1 : a.length;
}
// spec of the i-th operand (variadic commands repeat their last arg)
function argSpec(cmd, i) {
  var a = cmdArgs(cmd);
  if (i < a.length) return a[i];
  if (isVariadic(cmd)) return a[a.length - 1];
  return null;
}

/* ============================ binary helpers =========================== */

function Reader(u8) {
  this.buf = u8;
  this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  this.len = u8.byteLength;
}
Reader.prototype._ck = function (o, n) {
  if (o < 0 || o + n > this.len) fail("unexpected end of file at offset " + o);
};
Reader.prototype.u8 = function (o) { this._ck(o, 1); return this.buf[o]; };
Reader.prototype.u16 = function (o) { this._ck(o, 2); return this.dv.getUint16(o, true); };
Reader.prototype.i16 = function (o) { this._ck(o, 2); return this.dv.getInt16(o, true); };
Reader.prototype.u32 = function (o) { this._ck(o, 4); return this.dv.getUint32(o, true); };
Reader.prototype.i32 = function (o) { this._ck(o, 4); return this.dv.getInt32(o, true); };
Reader.prototype.f32 = function (o) { this._ck(o, 4); return this.dv.getFloat32(o, true); };
Reader.prototype.bytes = function (o, n) { this._ck(o, n); return this.buf.subarray(o, o + n); };

function Writer() { this.b = []; }
Writer.prototype.u8 = function (v) { this.b.push(v & 255); };
Writer.prototype.u16 = function (v) { this.u8(v); this.u8(v >> 8); };
Writer.prototype.i16 = function (v) { this.u16(v); };
Writer.prototype.u32 = function (v) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); this.u8(v >> 24); };
Writer.prototype.i32 = function (v) { this.u32(v); };
Writer.prototype.f32 = function (v) {
  var buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, true);
  var a = new Uint8Array(buf);
  this.u8(a[0]); this.u8(a[1]); this.u8(a[2]); this.u8(a[3]);
};
Writer.prototype.raw = function (arr) { for (var i = 0; i < arr.length; i++) this.u8(arr[i]); };
Writer.prototype.fill = function (n, v) { for (var i = 0; i < n; i++) this.u8(v); };
Writer.prototype.len = function () { return this.b.length; };
Writer.prototype.result = function () {
  var u8 = new Uint8Array(this.b.length);
  for (var i = 0; i < this.b.length; i++) u8[i] = this.b[i] & 255;
  return u8;
};

/* ============================ text formatting ========================== */

// Decimal text for a float32 value, rounded to the fewest decimals that still
// parse back (float64 parse + float32 canonicalization, exactly like the
// assembler's fnum path) to the identical float32 bits. Every candidate is
// verified, never assumed: 1999.920043 prints as 1999.92, 0.30000001 as 0.3.
// Whole values keep a ".0" suffix so they still read as floats. Extremes that
// no short decimal captures fall back to the shortest float64 round-trip
// (exponent form), always bit-exact since float64 holds every float32 exactly.
var _ffDV = typeof DataView === "function" ? new DataView(new ArrayBuffer(4)) : null;
function _ffBits(f) { _ffDV.setFloat32(0, f, true); return _ffDV.getUint32(0, true); }
function formatFloat(f) {
  if (typeof f !== "number") f = 0;
  if (isNaN(f)) return "NaN";
  if (!isFinite(f)) return f > 0 ? "Infinity" : "-Infinity";
  if (f === 0) return "0.0";
  var target = _ffBits(f);
  var sign = f < 0 ? "-" : "";
  var a = f < 0 ? -f : f;
  if (a < 1e21) {
    for (var d = 0; d <= 17; d++) {
      var s = sign + a.toFixed(d);
      if (d === 0) s += ".0";
      _ffDV.setFloat32(0, parseFloat(s), true);
      if (_ffDV.getUint32(0, true) === target) return s;
    }
  }
  var fb = String(f);
  if (fb.indexOf(".") < 0 && fb.indexOf("e") < 0 && fb.indexOf("E") < 0) fb += ".0";
  return fb;
}

function isPrintAscii(c) { return c >= 0x20 && c <= 0x7E; }

// quote raw bytes as '....', escaping non-printables (and ' and backslash)
function quoteBytes(bytes, stopAtNul) {
  var s = "'";
  for (var i = 0; i < bytes.length; i++) {
    var c = bytes[i] & 255;
    if (stopAtNul && c === 0) break;
    if (c === 39) s += "\\'";           // '
    else if (c === 92) s += "\\\\";     // backslash
    else if (isPrintAscii(c)) s += String.fromCharCode(c);
    else s += "\\x" + hex(c, 2);
  }
  return s + "'";
}

/* ============================ SCM file header ========================== */

function parseHeader(u8) {
  var r = new Reader(u8);
  try {
    if (r.len < 64) fail("file too small to be a main.scm");
    var seg2 = r.u32(3);
    if (seg2 < 8 || seg2 >= r.len) fail("bad globals segment offset (" + seg2 + ")");
    var seg3 = r.u32(seg2 + 3);
    if (seg3 <= seg2 || seg3 >= r.len) fail("bad models segment offset (" + seg3 + ")");
    var code = r.u32(seg3 + 3);
    if (code <= seg3 || code >= r.len) fail("bad code segment offset (" + code + ")");
    var targetId = r.u8(7);
    var count = r.u32(seg2 + 8);
    if (count < 1 || count > LIMITS.maxObjects) fail("bad object count (" + count + ")");
    var models = [];
    for (var i = 0; i < count - 1; i++) {
      var raw = r.bytes(seg2 + 36 + 24 * i, 24);
      var end = 0;
      while (end < 24 && raw[end] !== 0) end++;
      var name = "";
      for (var k = 0; k < end; k++) name += String.fromCharCode(raw[k]);
      models.push(name);
    }
    var mainSize = r.u32(seg3 + 8);
    if (mainSize <= code || mainSize > r.len) fail("bad main size (" + mainSize + ")");
    var largest = r.u32(seg3 + 12);
    var n = r.u16(seg3 + 16);
    if (n > LIMITS.maxMissions) fail("bad mission count (" + n + ")");
    var moffs = [];
    for (var m = 0; m < n; m++) {
      var mo = r.u32(seg3 + 20 + 4 * m);
      if (mo < mainSize || mo > r.len) fail("mission " + m + " offset out of range (" + mo + ")");
      moffs.push(mo);
    }
    return {
      ok: true, sizeGlobals: seg2, segModels: seg3, codeOffset: code,
      targetId: targetId, objectCount: count, models: models,
      mainSize: mainSize, largestMission: largest, numMissions: n,
      missionOffsets: moffs, fileSize: r.len
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// mission code ranges in table order: [start, end) using sorted bounds
function missionRanges(hdr) {
  var sorted = hdr.missionOffsets.slice().sort(function (a, b) { return a - b; });
  var ranges = [];
  for (var i = 0; i < hdr.missionOffsets.length; i++) {
    var s = hdr.missionOffsets[i];
    var e = hdr.fileSize;
    for (var j = 0; j < sorted.length; j++) {
      if (sorted[j] > s) { e = sorted[j]; break; }
    }
    ranges.push([s, e]);
  }
  return ranges;
}

/* ============================== disassembler =========================== */

function DecError(offset, msg) { this.offset = offset; this.msg = msg; }

function decodeOne(r, pos, end) {
  if (pos + 2 > end) throw new DecError(pos, "truncated opcode");
  var op = r.u16(pos);
  var not = (op & 0x8000) !== 0;
  var id = op & 0x7FFF;
  var cmd = cmdById(id);
  if (!cmd) throw new DecError(pos, "unknown opcode " + hex(id, 4) + " (raw " + hex(op, 4) + ")");
  var ops = [];
  var p = pos + 2, ai = 0;
  var nspec = cmdArgs(cmd).length;
  var variadic = isVariadic(cmd);
  for (;;) {
    if (ai >= nspec && !variadic) break;
    var spec = argSpec(cmd, ai);
    if (!spec) break;
    var at = argType(spec);
    var lastOpt = variadic && ai >= nspec - 1;
    if (p >= end) throw new DecError(pos, "truncated operands for " + cmdName(cmd));
    var b = r.u8(p);
    // VC text labels have NO type prefix: raw 8 bytes inline.
    if (at === "T" && b > 0x06) {
      if (p + 8 > end) throw new DecError(pos, "truncated text label");
      ops.push({ k: "t", raw: Array.prototype.slice.call(r.bytes(p, 8)) });
      p += 8;
    } else {
      p++;
      if (b === OT_END) {
        if (!lastOpt) throw new DecError(pos, "unexpected end-of-args in " + cmdName(cmd));
        break; // EOAL terminates variadics
      }
      if (b === OT_I32) { ops.push({ k: "i", w: 4, v: r.i32(p) }); p += 4; }
      else if (b === OT_I8) { ops.push({ k: "i", w: 1, v: (r.u8(p) << 24) >> 24 }); p += 1; }
      else if (b === OT_I16) { ops.push({ k: "i", w: 2, v: r.i16(p) }); p += 2; }
      else if (b === OT_F32) { ops.push({ k: "f", v: r.f32(p) }); p += 4; }
      else if (b === OT_GVAR) { ops.push({ k: "g", v: r.u16(p) }); p += 2; }
      else if (b === OT_LVAR) { ops.push({ k: "l", v: r.u16(p) }); p += 2; }
      else throw new DecError(pos, "bad operand type " + hex(b, 2) + " in " + cmdName(cmd));
    }
    if (lastOpt) continue; // variadic: keep consuming the same spec
    ai++;
    if (ai >= nspec && !variadic) break;
    if (ai > nspec + 400) throw new DecError(pos, "runaway variadic args in " + cmdName(cmd));
  }
  return { id: id, name: cmdName(cmd), not: not, ops: ops, size: p - pos };
}

// linear sweep; on failure the REST of the segment becomes a HEX blob
function decodeSegment(r, start, end) {
  var insns = [], pos = start, hexBlob = null;
  while (pos < end) {
    var d;
    try {
      d = decodeOne(r, pos, end);
    } catch (e) {
      hexBlob = { start: pos, bytes: Array.prototype.slice.call(r.bytes(pos, end - pos)) };
      break;
    }
    d.off = pos;
    insns.push(d);
    pos += d.size;
  }
  return { insns: insns, hexBlob: hexBlob };
}

function sanitizeLabel(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) {
    var c = bytes[i] & 255;
    if (c === 0) break;
    var ch = String.fromCharCode(c).toUpperCase();
    s += /[A-Z0-9_]/.test(ch) ? ch : "_";
  }
  if (!s) return null;
  if (/[0-9]/.test(s.charAt(0))) s = "_" + s;
  return s.length > 24 ? s.slice(0, 24) : s;
}

function makeNamer() {
  var used = {};
  return {
    claim: function (want) {
      want = String(want).toUpperCase();
      var base = want, i = 2;
      while (used[want]) { want = base + "_" + (i++); }
      used[want] = 1;
      return want;
    }
  };
}

function fmtLocalVar(i) {
  if (i === 16) return "TIMERA";
  if (i === 17) return "TIMERB";
  return i + "@";
}

function disassemble(u8) {
  var hdr = parseHeader(u8);
  if (!hdr.ok) return { ok: false, error: hdr.error };
  var warnings = [];
  if (hdr.targetId !== TARGET_MIAMI) {
    warnings.push("platform byte is 0x" + hex(hdr.targetId, 2) +
      ", expected 0x6D ('m' = Vice City); continuing anyway, but non-VC files may decode incorrectly.");
  }
  var r = new Reader(u8);
  var ranges = missionRanges(hdr);

  var main = decodeSegment(r, hdr.codeOffset, hdr.mainSize);
  if (main.hexBlob) {
    warnings.push("main block: could not decode at offset " + main.hexBlob.start +
      " (" + main.hexBlob.bytes.length + " bytes kept as HEX).");
  }
  var missions = [], mi;
  for (mi = 0; mi < hdr.numMissions; mi++) {
    var seg = decodeSegment(r, ranges[mi][0], ranges[mi][1]);
    if (seg.hexBlob) {
      warnings.push("mission " + mi + ": could not decode at offset " + seg.hexBlob.start +
        " (" + seg.hexBlob.bytes.length + " bytes kept as HEX).");
    }
    missions.push(seg);
  }

  // ---- collect label targets ----
  function targetsOf(seg, isMission) {
    var abs = {}, loc = {}, mainRefs = {};
    for (var i = 0; i < seg.insns.length; i++) {
      var d = seg.insns[i];
      var cmd = cmdById(d.id);
      var nspec = cmdArgs(cmd).length;
      var variadic = isVariadic(cmd);
      for (var k = 0; k < d.ops.length; k++) {
        var spec = k < nspec ? cmdArgs(cmd)[k] : (variadic ? cmdArgs(cmd)[nspec - 1] : null);
        if (!spec || argType(spec) !== "L") continue;
        var v = d.ops[k].v;
        if (!isMission) abs[v] = 1;
        else if (v < 0) loc[-v] = 1;
        else mainRefs[v] = 1;
      }
    }
    return { abs: abs, loc: loc, mainRefs: mainRefs };
  }
  var mainT = targetsOf(main, false);
  var misT = missions.map(function (s) { return targetsOf(s, true); });

  Object.keys(mainT.abs).forEach(function (k) {
    var v = +k;
    if (v < hdr.codeOffset || v >= hdr.mainSize) {
      warnings.push("main block jumps to " + v + " which is outside the main block; kept numeric.");
      delete mainT.abs[k];
    }
  });
  for (var q = 0; q < missions.length; q++) {
    (function (qi) {
      var size = ranges[qi][1] - ranges[qi][0];
      Object.keys(misT[qi].loc).forEach(function (k) {
        if (+k < 0 || +k >= size) {
          warnings.push("mission " + qi + " jumps to local offset " + k + " outside the mission; kept numeric.");
          delete misT[qi].loc[k];
        }
      });
      Object.keys(misT[qi].mainRefs).forEach(function (k) {
        var v = +k;
        if (v < hdr.codeOffset || v >= hdr.mainSize) {
          warnings.push("mission " + qi + " references " + v + " outside the main block; kept numeric.");
          delete misT[qi].mainRefs[k];
        }
      });
    })(q);
  }

  // ---- name labels ----
  function byOff(seg) {
    var m = {};
    seg.insns.forEach(function (d) { m[d.off] = d; });
    return m;
  }
  var mainByOff = byOff(main);
  function scriptNameAt(d) {
    if (d && d.id === 0x3A4 && !d.not && d.ops.length && d.ops[0].k === "t") {
      return sanitizeLabel(d.ops[0].raw);
    }
    return null;
  }

  var namerMain = makeNamer();
  var mainNames = {};
  mainNames[hdr.codeOffset] = namerMain.claim("MAIN");
  Object.keys(mainT.abs).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
    if (mainNames[t] !== undefined) return;
    mainNames[t] = namerMain.claim(scriptNameAt(mainByOff[t]) || ("MAIN_" + hex(t, 8)));
  });
  for (var mri = 0; mri < missions.length; mri++) {
    Object.keys(misT[mri].mainRefs).map(Number).forEach(function (t) {
      if (mainNames[t] === undefined) {
        mainNames[t] = namerMain.claim(scriptNameAt(mainByOff[t]) || ("MAIN_" + hex(t, 8)));
      }
    });
  }

  var misNames = [], misEntries = [];
  for (var mi2 = 0; mi2 < missions.length; mi2++) {
    var sg = missions[mi2], base = ranges[mi2][0];
    var namer = makeNamer(), names = {};
    var entry = null;
    if (sg.insns.length && sg.insns[0].off === base) entry = scriptNameAt(sg.insns[0]);
    names[0] = namer.claim(entry || ("MISSION_" + mi2));
    var loc = {};
    sg.insns.forEach(function (d) { loc[d.off - base] = d; });
    Object.keys(misT[mi2].loc).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
      if (names[t] !== undefined) return;
      names[t] = namer.claim(scriptNameAt(loc[t]) || ("L_" + t.toString(16).toUpperCase()));
    });
    // avoid collisions with referenced main labels (mission scope wins on assembly)
    var refMain = {};
    Object.keys(misT[mi2].mainRefs).forEach(function (k) { refMain[mainNames[+k]] = 1; });
    Object.keys(names).forEach(function (k) {
      if (refMain[names[k]]) {
        var old = names[k];
        names[k] = namer.claim(old + "_");
        warnings.push("mission " + mi2 + ": local label " + old + " renamed to " + names[k] +
          " to avoid clashing with a main-block label.");
      }
    });
    misNames.push(names);
    misEntries.push(names[0]);
  }

  // ---- operand text ----
  var modelById = DB().modelsById;
  function fmtOperand(op, spec, ctx) {
    var at = spec ? argType(spec) : "I";
    if (op.k === "i") {
      if (at === "L") {
        var v = op.v;
        if (!ctx.isMission) {
          return mainNames[v] !== undefined ? "@" + mainNames[v] : String(v);
        }
        if (v < 0) {
          return ctx.names[-v] !== undefined ? "@" + ctx.names[-v] : String(v);
        }
        return mainNames[v] !== undefined ? "@" + mainNames[v] : String(v);
      }
      var en = spec ? argEnum(spec) : "";
      if ((at === "I" || at === "C" || at === "P") && (en === "MODEL" || en === "DEFAULTMODEL")) {
        var vv = op.v;
        if (vv >= 0 && modelById[vv] !== undefined) return "#" + modelById[vv];
        if (vv < 0 && hdr.models[-vv - 1] !== undefined && hdr.models[-vv - 1] !== "") {
          return "#" + hdr.models[-vv - 1];
        }
      }
      return String(op.v);
    }
    if (op.k === "f") return formatFloat(op.v);
    if (op.k === "g") return "$" + op.v;
    if (op.k === "l") return (op.v <= LIMITS.maxLocal) ? fmtLocalVar(op.v) : op.v + "@";
    if (op.k === "t") return quoteBytes(op.raw, true);
    return "?";
  }

  function fmtInsn(d, ctx) {
    var cmd = cmdById(d.id);
    var parts = [];
    var nspec = cmdArgs(cmd).length;
    var variadic = isVariadic(cmd);
    for (var k = 0; k < d.ops.length; k++) {
      var spec = k < nspec ? cmdArgs(cmd)[k] : (variadic ? cmdArgs(cmd)[nspec - 1] : null);
      parts.push(fmtOperand(d.ops[k], spec, ctx));
    }
    return (d.not ? "NOT " : "") + hex(d.id, 4) + ": " + d.name +
      (parts.length ? " " + parts.join(" ") : "");
  }

  function fmtHexBlob(blob) {
    var lines = ["HEX"], row = "";
    for (var i = 0; i < blob.bytes.length; i++) {
      row += hex(blob.bytes[i], 2) + " ";
      if (row.length >= 48) { lines.push(row.trim()); row = ""; }
    }
    if (row) lines.push(row.trim());
    lines.push("END");
    return lines;
  }

  // ---- emit sections ----
  var sections = [];
  var stats = {
    mainInsns: main.insns.length, mainLabels: 0, totalInsns: main.insns.length,
    missions: [], notCount: 0,
    globals: { refs: 0, uniq: 0, min: 0, max: 0 }
  };
  var gMin = Infinity, gMax = -1, gSet = {}, gRefs = 0;
  function scanVars(seg) {
    seg.insns.forEach(function (d) {
      if (d.not) stats.notCount++;
      d.ops.forEach(function (op) {
        if (op.k === "g") {
          gRefs++;
          gSet[op.v] = 1;
          if (op.v < gMin) gMin = op.v;
          if (op.v > gMax) gMax = op.v;
        }
      });
    });
  }
  scanVars(main);
  missions.forEach(scanVars);
  stats.globals = { refs: gRefs, uniq: Object.keys(gSet).length,
    min: gRefs ? gMin : 0, max: gRefs ? gMax : 0 };

  var hl = [];
  hl.push("//===== SECTION:HEADER =====");
  hl.push("// Vice City main.scm -- header (auto-generated, editable with care)");
  hl.push("// file: " + hdr.fileSize + " bytes | globals: " + hdr.sizeGlobals +
    " | objects: " + hdr.objectCount + " | missions: " + hdr.numMissions);
  hl.push("");
  hl.push("DEFINE GLOBAL_SPACE " + hdr.sizeGlobals);
  hl.push("");
  hl.push("DEFINE OBJECTS " + hdr.objectCount);
  hl.push("DEFINE OBJECT DUMMY");
  hdr.models.forEach(function (m) { hl.push("DEFINE OBJECT " + (m === "" ? "DUMMY" : m)); });
  hl.push("");
  hl.push("DEFINE MISSIONS " + hdr.numMissions);
  for (var di = 0; di < hdr.numMissions; di++) {
    hl.push("DEFINE MISSION " + di + " AT @" + misEntries[di]);
  }
  sections.push({ id: "header", kind: "header", title: "HEADER", lines: hl });

  var ml = [];
  ml.push("//===== SECTION:MAIN =====");
  ml.push("// MAIN thread block -- " + main.insns.length + " instructions, offsets " +
    hdr.codeOffset + ".." + hdr.mainSize);
  var lastOff = -1;
  main.insns.forEach(function (d) {
    if (mainNames[d.off] !== undefined && d.off !== lastOff) {
      ml.push(":" + mainNames[d.off]);
      stats.mainLabels++;
    }
    ml.push(fmtInsn(d, { isMission: false }));
    lastOff = d.off;
  });
  if (main.hexBlob) {
    if (mainNames[main.hexBlob.start] !== undefined) ml.push(":" + mainNames[main.hexBlob.start]);
    fmtHexBlob(main.hexBlob).forEach(function (l) { ml.push(l); });
  }
  sections.push({ id: "main", kind: "main", title: "MAIN", lines: ml });

  for (var mi3 = 0; mi3 < missions.length; mi3++) {
    var sg = missions[mi3], base3 = ranges[mi3][0], size3 = ranges[mi3][1] - base3;
    var names3 = misNames[mi3];
    var ll = [];
    ll.push("//===== SECTION:MISSION " + mi3 + " =====");
    ll.push("// MISSION " + mi3 + " @" + misEntries[mi3] + " -- offset " + base3 + ", " + size3 +
      " bytes, " + sg.insns.length + " instructions");
    var ctx = { isMission: true, names: names3 };
    if (!sg.insns.length && !sg.hexBlob) {
      ll.push(":" + misEntries[mi3]);
      ll.push("// (empty mission)");
    }
    sg.insns.forEach(function (d) {
      var lo = d.off - base3;
      if (names3[lo] !== undefined) ll.push(":" + names3[lo]);
      ll.push(fmtInsn(d, ctx));
    });
    if (sg.hexBlob) {
      var hlo = sg.hexBlob.start - base3;
      if (names3[hlo] !== undefined) ll.push(":" + names3[hlo]);
      fmtHexBlob(sg.hexBlob).forEach(function (l) { ll.push(l); });
    }
    sections.push({ id: "mission:" + mi3, kind: "mission", index: mi3,
      title: "MISSION " + mi3, lines: ll });
    stats.missions.push({ index: mi3, name: misEntries[mi3], offset: base3,
      size: size3, insns: sg.insns.length });
    stats.totalInsns += sg.insns.length;
  }

  return { ok: true, sections: sections, header: hdr, stats: stats, warnings: warnings };
}

/* =============================== assembler ============================= */

function stripComments(text) {
  var lines = String(text).split(/\r\n|\r|\n/);
  var out = [];
  var inBlock = false, blockStart = 0;
  var errors = [];
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li], res = "", i = 0, inStr = false;
    while (i < line.length) {
      var c = line.charAt(i), n = line.charAt(i + 1);
      if (inBlock) {
        if (c === "*" && n === "/") { inBlock = false; i += 2; } else i++;
        continue;
      }
      if (inStr) {
        res += c;
        if (c === "\\" && i + 1 < line.length) { res += line.charAt(i + 1); i += 2; continue; }
        if (c === "'") inStr = false;
        i++;
        continue;
      }
      if (c === "/" && n === "/") break;
      if (c === "/" && n === "*") { inBlock = true; blockStart = li + 1; i += 2; continue; }
      if (c === "'") inStr = true;
      res += c;
      i++;
    }
    out.push(res);
  }
  if (inBlock) errors.push({ line: blockStart, msg: "unterminated /* comment" });
  return { lines: out, errors: errors };
}

var RE_OPNUM = /^([0-9A-Fa-f]{4}):$/;
var RE_INT = /^[+-]?(0[xX][0-9A-Fa-f]+|\d+)$/;
var RE_FLOAT = /^[+-]?(\d+\.\d*|\d*\.\d+|\d+)([eE][+-]?\d+)?$/;
var RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RE_LABELNM = /^[A-Za-z0-9_]+$/;
var RE_LVAR = /^(\d{1,3})@$/;

// split an instruction line into tokens (quotes respected, commas separate)
function tokenizeArgs(s, lineNo, errors) {
  var toks = [], i = 0;
  while (i < s.length) {
    while (i < s.length && (isSpace(s.charAt(i)) || s.charAt(i) === ",")) i++;
    if (i >= s.length) break;
    var c = s.charAt(i);
    if (c === "'") {
      var j = i + 1, val = "";
      var closed = false;
      while (j < s.length) {
        var d = s.charAt(j);
        if (d === "\\" && j + 1 < s.length) { val += d + s.charAt(j + 1); j += 2; continue; }
        if (d === "'") { closed = true; j++; break; }
        val += d; j++;
      }
      if (!closed) { errors.push({ line: lineNo, msg: "unterminated 'string'" }); return null; }
      toks.push({ t: "str", v: val });
      i = j;
    } else {
      var k = i;
      while (k < s.length && !isSpace(s.charAt(k)) && s.charAt(k) !== ",") k++;
      toks.push({ t: "w", v: s.slice(i, k) });
      i = k;
    }
  }
  return toks;
}

function parseNumber(word) {
  if (RE_INT.test(word)) {
    var v = (word.charAt(0) === "-" || word.charAt(0) === "+") ?
      parseInt(word.slice(0, 1) + word.slice(1).replace(/^0[xX]/, "0x"), 0) :
      parseInt(word, 0);
    // parseInt(s, 0) is legacy; do it manually to be safe:
    var neg = word.charAt(0) === "-";
    var body = (word.charAt(0) === "-" || word.charAt(0) === "+") ? word.slice(1) : word;
    if (/^0[xX]/.test(body)) v = parseInt(body.slice(2), 16);
    else v = parseInt(body, 10);
    if (neg) v = -v;
    if (!isFinite(v) || Math.floor(v) !== v) return null;
    return { isFloat: false, v: v };
  }
  if (RE_FLOAT.test(word)) {
    var f = parseFloat(word);
    if (!isFinite(f) && word.toUpperCase().indexOf("INF") < 0 && isNaN(f)) return null;
    return { isFloat: true, v: f };
  }
  return null;
}

// decode '...' escapes (\\ \' \xNN) into byte array; null on error
function decodeStringBody(body) {
  var out = [];
  for (var i = 0; i < body.length; i++) {
    var c = body.charAt(i);
    if (c !== "\\") {
      var code = body.charCodeAt(i);
      if (code > 255) return null;
      out.push(code);
      continue;
    }
    var e = body.charAt(i + 1);
    if (e === "\\") { out.push(92); i++; }
    else if (e === "'") { out.push(39); i++; }
    else if (e === "x" || e === "X") {
      var hx = body.substr(i + 2, 2);
      if (!/^[0-9A-Fa-f]{2}$/.test(hx)) return null;
      out.push(parseInt(hx, 16));
      i += 3;
    }
    else return null;
  }
  return out;
}

// classify one argument word token into a value node
function classifyWord(word, lineNo, errors) {
  if (!word) return null;
  var c0 = word.charAt(0);
  if (c0 === "@") {
    var nm = word.slice(1);
    if (!nm || !RE_LABELNM.test(nm)) {
      errors.push({ line: lineNo, msg: "bad label reference '" + word + "'" }); return null;
    }
    return { k: "label", name: nm.toUpperCase() };
  }
  if (c0 === "$") {
    var rest = word.slice(1);
    if (!rest) { errors.push({ line: lineNo, msg: "bad variable '" + word + "'" }); return null; }
    if (/^\d+$/.test(rest)) return { k: "gnum", off: parseInt(rest, 10) };
    if (!RE_LABELNM.test(rest)) {
      errors.push({ line: lineNo, msg: "bad variable name '" + word + "'" }); return null;
    }
    return { k: "gname", name: rest.toUpperCase() };
  }
  if (c0 === "#") {
    var mn = word.slice(1);
    if (!mn || !RE_LABELNM.test(mn)) {
      errors.push({ line: lineNo, msg: "bad model reference '" + word + "'" }); return null;
    }
    return { k: "model", name: mn.toUpperCase() };
  }
  var lv = RE_LVAR.exec(word);
  if (lv) return { k: "lvar", idx: parseInt(lv[1], 10) };
  var up = word.toUpperCase();
  if (up === "TIMERA") return { k: "lvar", idx: 16 };
  if (up === "TIMERB") return { k: "lvar", idx: 17 };
  var num = parseNumber(word);
  if (num) return num.isFloat ? { k: "fnum", v: num.v } : { k: "inum", v: num.v };
  if (/^[0-9]/.test(word)) {
    errors.push({ line: lineNo, msg: "bad number '" + word + "'" }); return null;
  }
  if (!RE_IDENT.test(word)) {
    errors.push({ line: lineNo, msg: "unexpected '" + word + "'" }); return null;
  }
  return { k: "ident", name: word.toUpperCase() };
}

// ---- pass 1: lines -> items ----
function asmPass1(lines, errors) {
  var items = [];
  var inHex = false, hexBytes = [], hexStart = 0;
  for (var li = 0; li < lines.length; li++) {
    var lineNo = li + 1;
    var s = lines[li];
    if (!s || !s.trim()) continue;
    var toks = tokenizeArgs(s, lineNo, errors);
    if (!toks) continue;
    if (!toks.length) continue;

    if (inHex) {
      if (toks.length === 1 && toks[0].t === "w" && toks[0].v.toUpperCase() === "END") {
        items.push({ t: "hex", bytes: hexBytes, line: hexStart });
        inHex = false; hexBytes = [];
        continue;
      }
      var blob = "";
      for (var bi = 0; bi < toks.length; bi++) {
        if (toks[bi].t !== "w") {
          errors.push({ line: lineNo, msg: "only hex bytes allowed inside HEX..END" });
          blob = null; break;
        }
        blob += toks[bi].v;
      }
      if (blob === null) continue;
      if (!/^[0-9A-Fa-f]*$/.test(blob) || blob.length % 2 !== 0) {
        errors.push({ line: lineNo, msg: "bad hex data '" + blob.slice(0, 32) + "'" });
        continue;
      }
      for (var hx = 0; hx < blob.length; hx += 2) {
        hexBytes.push(parseInt(blob.substr(hx, 2), 16));
      }
      continue;
    }

    var ti = 0;
    // label definition?
    if (toks[0].t === "w" && toks[0].v.charAt(0) === ":") {
      var lnm = toks[0].v.slice(1);
      if (!lnm || !RE_LABELNM.test(lnm)) {
        errors.push({ line: lineNo, msg: "bad label definition '" + toks[0].v + "'" });
        continue;
      }
      items.push({ t: "label", name: lnm.toUpperCase(), line: lineNo });
      ti = 1;
      if (ti >= toks.length) continue;
    }
    // directives (must come first on the logical line, after optional label)
    if (toks[ti] && toks[ti].t === "w") {
      var kw = toks[ti].v.toUpperCase();
      if (kw === "DEFINE" || kw === "VAR_INT" || kw === "VAR_FLOAT" ||
          kw === "HEX" || kw === "END") {
        if (kw === "HEX") {
          if (toks.length > ti + 1) {
            errors.push({ line: lineNo, msg: "HEX takes no arguments" }); continue;
          }
          inHex = true; hexBytes = []; hexStart = lineNo;
          continue;
        }
        if (kw === "END") { errors.push({ line: lineNo, msg: "END without HEX" }); continue; }
        if (kw === "VAR_INT" || kw === "VAR_FLOAT") {
          var names = [];
          for (var vi = ti + 1; vi < toks.length; vi++) {
            if (toks[vi].t !== "w") {
              errors.push({ line: lineNo, msg: "bad variable name in " + kw }); names = null; break;
            }
            var w = toks[vi].v;
            if (w.charAt(0) === "$") w = w.slice(1);
            if (!w || !RE_LABELNM.test(w) || /^\d+$/.test(w)) {
              errors.push({ line: lineNo, msg: "bad variable name '" + toks[vi].v + "' in " + kw });
              names = null; break;
            }
            names.push(w.toUpperCase());
          }
          if (!names) continue;
          if (!names.length) {
            errors.push({ line: lineNo, msg: kw + " needs at least one name" }); continue;
          }
          items.push({ t: kw === "VAR_INT" ? "vari" : "varf", names: names, line: lineNo });
          continue;
        }
        // DEFINE ...
        var rest = toks.slice(ti + 1);
        var sub = rest.length && rest[0].t === "w" ? rest[0].v.toUpperCase() : "";
        if (sub === "GLOBAL_SPACE" && rest.length === 2 && rest[1].t === "w") {
          var gs = parseNumber(rest[1].v);
          if (!gs || gs.isFloat || gs.v < 8 || gs.v > LIMITS.maxGlobals || gs.v % 4 !== 0) {
            errors.push({ line: lineNo, msg: "DEFINE GLOBAL_SPACE needs a multiple of 4 in 8.." + LIMITS.maxGlobals });
            continue;
          }
          items.push({ t: "gspace", n: gs.v, line: lineNo });
          continue;
        }
        if (sub === "OBJECTS" && rest.length === 2 && rest[1].t === "w") {
          var oc = parseNumber(rest[1].v);
          if (!oc || oc.isFloat || oc.v < 1 || oc.v > LIMITS.maxObjects) {
            errors.push({ line: lineNo, msg: "DEFINE OBJECTS needs 1.." + LIMITS.maxObjects }); continue;
          }
          items.push({ t: "objects", n: oc.v, line: lineNo });
          continue;
        }
        if (sub === "OBJECT" && rest.length === 2 && rest[0].t === "w") {
          // NOTE: rest[0] is "OBJECT"; the name is rest[1]. Names with spaces
          // are impossible (tokenizer splits), which matches the 24-byte field.
          var onm = rest[1].t === "w" ? rest[1].v : "";
          if (!onm || !RE_LABELNM.test(onm) || onm.length > 23) {
            errors.push({ line: lineNo, msg: "bad object name (1-23 chars, A-Z 0-9 _)" }); continue;
          }
          items.push({ t: "object", name: onm.toUpperCase(), line: lineNo });
          continue;
        }
        if (sub === "MISSIONS" && rest.length === 2 && rest[1].t === "w") {
          var mc = parseNumber(rest[1].v);
          if (!mc || mc.isFloat || mc.v < 0 || mc.v > LIMITS.maxMissions) {
            errors.push({ line: lineNo, msg: "DEFINE MISSIONS needs 0.." + LIMITS.maxMissions }); continue;
          }
          items.push({ t: "missions", n: mc.v, line: lineNo });
          continue;
        }
        if (sub === "MISSION" && rest.length === 4 && rest[0].t === "w") {
          var mIx = rest[1].t === "w" ? parseNumber(rest[1].v) : null;
          var atOk = rest[2].t === "w" && rest[2].v.toUpperCase() === "AT";
          var lab = rest[3].t === "w" ? rest[3].v : "";
          if (!mIx || mIx.isFloat || mIx.v < 0 || !atOk ||
              lab.charAt(0) !== "@" || !RE_LABELNM.test(lab.slice(1))) {
            errors.push({ line: lineNo, msg: "usage: DEFINE MISSION <n> AT @<label>" }); continue;
          }
          items.push({ t: "mission", idx: mIx.v, label: lab.slice(1).toUpperCase(), line: lineNo });
          continue;
        }
        errors.push({ line: lineNo, msg: "bad DEFINE directive" });
        continue;
      }
    }
    // instruction: [NOT] [XXXX:] [NAME] args...
    var not = false, idGiven = null, nameGiven = null;
    if (toks[ti] && toks[ti].t === "w" && toks[ti].v.toUpperCase() === "NOT") { not = true; ti++; }
    if (toks[ti] && toks[ti].t === "w") {
      var mnum = RE_OPNUM.exec(toks[ti].v);
      if (mnum) {
        idGiven = parseInt(mnum[1], 16);
        if (idGiven & 0x8000) { not = true; idGiven &= 0x7FFF; }
        ti++;
      }
    }
    if (toks[ti] && toks[ti].t === "w" && RE_IDENT.test(toks[ti].v) && cmdIdByName(toks[ti].v) !== null) {
      nameGiven = toks[ti].v.toUpperCase();
      ti++;
    }
    if (idGiven === null && nameGiven === null) {
      var got = toks[ti] ? toks[ti].v : "(end of line)";
      errors.push({ line: lineNo, msg: "expected an opcode, got '" + got + "'" });
      continue;
    }
    var id = idGiven !== null ? idGiven : cmdIdByName(nameGiven);
    if (idGiven !== null && nameGiven !== null && cmdIdByName(nameGiven) !== idGiven) {
      errors.push({ line: lineNo, msg: hex(idGiven, 4) + " is " + (cmdById(idGiven) ? cmdName(cmdById(idGiven)) : "?") +
        ", not " + nameGiven });
      continue;
    }
    var cmd = cmdById(id);
    if (!cmd) { errors.push({ line: lineNo, msg: "unknown opcode " + hex(id, 4) }); continue; }
    var rawArgs = toks.slice(ti);
    var vals = [];
    var badArg = false;
    for (var ai2 = 0; ai2 < rawArgs.length; ai2++) {
      var rt = rawArgs[ai2], vv = null;
      if (rt.t === "str") vv = { k: "str", body: rt.v };
      else vv = classifyWord(rt.v, lineNo, errors);
      if (!vv) { badArg = true; break; }
      vals.push(vv);
    }
    if (badArg) continue;
    items.push({ t: "insn", id: id, name: cmdName(cmd), not: not, args: vals, line: lineNo });
  }
  if (inHex) errors.push({ line: hexStart, msg: "HEX block without END" });
  return items;
}

// resolve a bare identifier for an INT/CONSTANT/PARAM argument
function resolveIdent(name, spec, levelModels, forConstant) {
  var db = DB();
  var en = spec ? argEnum(spec) : "";
  var isModelArg = en === "MODEL" || en === "DEFAULTMODEL";
  if (isModelArg && !forConstant) {
    if (db.models[name] !== undefined) return { v: db.models[name] };
    var li = levelIndexOf(name, levelModels);
    if (li >= 0) return { v: -(li + 1) };
  }
  if (en && db.enums[en] && db.enums[en][name] !== undefined) {
    return { v: db.enums[en][name] };
  }
  for (var gi = 0; gi < db.enumGlobals.length; gi++) {
    var g = db.enums[db.enumGlobals[gi]];
    if (g && g[name] !== undefined) return { v: g[name] };
  }
  if (forConstant) {
    var keys = Object.keys(db.enums);
    for (var ei = 0; ei < keys.length; ei++) {
      var e = db.enums[keys[ei]];
      if (e[name] !== undefined) return { v: e[name] };
    }
    if (db.models[name] !== undefined) return { v: db.models[name] };
    var lj = levelIndexOf(name, levelModels);
    if (lj >= 0) return { v: -(lj + 1) };
  }
  return null;
}

function levelIndexOf(name, levelModels) {
  for (var i = 0; i < levelModels.length; i++) {
    if (levelModels[i] === name) return i;
  }
  return -1;
}

function widthForInt(v) {
  if (v >= -128 && v <= 127) return 1;
  if (v >= -32768 && v <= 32767) return 2;
  return 4;
}

// ---- fast single-section check for live editing ----
// Runs the line-local front end (comment stripping + pass 1) plus the same
// argument-count validation the full assembler applies, and section-local
// label sanity (undefined references, duplicate definitions). Deliberately
// NOT a full assemble: no cross-section mission layout, no encoding, so it
// stays fast enough to run while typing. `lines` is one section's text
// lines; reported line numbers are 1-based within it. `externals` is an
// optional list of label names defined elsewhere but visible here (the
// assembler lets missions reference main-block labels). Label findings are
// warnings, never errors: only the full assemble sees every namespace.
function checkSection(lines, externals) {
  var errors = [], warnings = [];
  var stripped = stripComments(lines.join("\n"));
  errors = stripped.errors.slice();
  var items = asmPass1(stripped.lines, errors);
  var i, it, k;
  for (i = 0; i < items.length; i++) {
    it = items[i];
    if (it.t !== "insn") continue;
    var cmd = cmdById(it.id);
    if (!cmd) continue; // unknown opcode already reported by pass 1
    var need = cmdArgs(cmd).length, variadic = isVariadic(cmd);
    if ((!variadic && it.args.length !== need) ||
        (variadic && it.args.length < need - 1)) {
      errors.push({ line: it.line, msg: cmdName(cmd) + " takes " +
        (variadic ? "at least " + (need - 1) : need) + " argument(s), got " + it.args.length });
    }
  }
  var defs = {}, dups = {};
  for (i = 0; i < items.length; i++) {
    it = items[i];
    if (it.t !== "label") continue;
    if (defs[it.name]) dups[it.name] = it.line;
    else defs[it.name] = it.line;
  }
  Object.keys(dups).forEach(function (dn) {
    warnings.push({ line: dups[dn], msg: "duplicate label :" + dn + " in this section" });
  });
  if (externals) {
    for (var e = 0; e < externals.length; e++) {
      defs[String(externals[e]).toUpperCase()] = -1; // visible, defined elsewhere
    }
  }
  var missing = {};
  for (i = 0; i < items.length; i++) {
    it = items[i];
    if (it.t !== "insn") continue;
    for (k = 0; k < it.args.length; k++) {
      if (it.args[k].k !== "label" || defs[it.args[k].name] || missing[it.args[k].name]) continue;
      missing[it.args[k].name] = 1;
      warnings.push({ line: it.line, msg: "label @" + it.args[k].name + " is not defined in this section" });
    }
  }
  warnings.sort(function (a, b) { return a.line - b.line; });
  return { errors: errors, warnings: warnings };
}

function assemble(text) {
  var errors = [], warnings = [];
  if (typeof text !== "string") {
    return { ok: false, errors: [{ line: 0, msg: "assemble() needs source text" }], warnings: [] };
  }
  var stripped = stripComments(text.charAt(0) === "\uFEFF" ? text.slice(1) : text);
  errors = stripped.errors.slice();
  var items = asmPass1(stripped.lines, errors);

  // ---- pass 2: header data ----
  var gspace = null, gspaceLine = 0;
  var objCount = null, objNames = [], missionsCount = null, misTable = {};
  var varNames = {}, varOrder = [];
  if (!errors.length) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.t === "gspace") {
        if (gspace !== null) { errors.push({ line: it.line, msg: "duplicate DEFINE GLOBAL_SPACE" }); break; }
        gspace = it.n; gspaceLine = it.line;
      } else if (it.t === "objects") {
        if (objCount !== null) { errors.push({ line: it.line, msg: "duplicate DEFINE OBJECTS" }); break; }
        objCount = it.n;
      } else if (it.t === "object") {
        objNames.push(it.name);
      } else if (it.t === "missions") {
        if (missionsCount !== null) { errors.push({ line: it.line, msg: "duplicate DEFINE MISSIONS" }); break; }
        missionsCount = it.n;
      } else if (it.t === "mission") {
        if (misTable[it.idx] !== undefined) {
          errors.push({ line: it.line, msg: "duplicate DEFINE MISSION " + it.idx }); break;
        }
        misTable[it.idx] = { label: it.label, line: it.line };
      } else if (it.t === "vari" || it.t === "varf") {
        for (var vi = 0; vi < it.names.length; vi++) {
          var vn = it.names[vi];
          if (varNames[vn] !== undefined) {
            errors.push({ line: it.line, msg: "duplicate variable $" + vn }); break;
          }
          varNames[vn] = { off: 8 + varOrder.length * 4, type: it.t === "vari" ? "I" : "F" };
          varOrder.push(vn);
        }
        if (errors.length) break;
      }
    }
  }
  if (!errors.length) {
    if (objCount === null) errors.push({ line: 0, msg: "missing DEFINE OBJECTS <n>" });
    else if (objNames.length !== objCount) {
      errors.push({ line: 0, msg: "DEFINE OBJECTS " + objCount + " but " + objNames.length + " DEFINE OBJECT lines" });
    }
    if (missionsCount === null) errors.push({ line: 0, msg: "missing DEFINE MISSIONS <n>" });
    else {
      for (var mi = 0; mi < missionsCount; mi++) {
        if (misTable[mi] === undefined) {
          errors.push({ line: 0, msg: "missing DEFINE MISSION " + mi + " AT @<label>" });
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors: errors, warnings: warnings };

  var levelModels = objNames.slice(1); // index 0 is the dummy slot
  var numMissions = missionsCount;

  // ---- pass 3: split code into main + missions ----
  var pos = []; // positional items
  items.forEach(function (it) {
    if (it.t === "label" || it.t === "insn" || it.t === "hex") pos.push(it);
  });
  // defocus: map label name -> list of positions (global scan)
  var defs = {};
  pos.forEach(function (it, idx) {
    if (it.t === "label") {
      (defs[it.name] = defs[it.name] || []).push(idx);
    }
  });
  // NOTE: the same label name in different namespaces (main block vs each
  // mission) is legal by design, so no warnings here; same-namespace
  // duplicates become hard errors below.
  // entry positions in table order
  var entryPos = [];
  var searchFrom = -1;
  for (var ei = 0; ei < numMissions; ei++) {
    var want = misTable[ei].label;
    var list = defs[want] || [];
    var found = -1;
    for (var li = 0; li < list.length; li++) {
      if (list[li] > searchFrom) { found = list[li]; break; }
    }
    if (found < 0) {
      errors.push({ line: misTable[ei].line,
        msg: "mission " + ei + " entry @" + want + " not found after the previous mission entry" });
      return { ok: false, errors: errors, warnings: warnings };
    }
    entryPos.push(found);
    searchFrom = found;
  }
  // build segments
  var segments = []; // {items, isMission, index}
  var mainItems = entryPos.length ? pos.slice(0, entryPos[0]) : pos.slice();
  segments.push({ items: mainItems, isMission: false, index: -1 });
  for (var si = 0; si < entryPos.length; si++) {
    var end = si + 1 < entryPos.length ? entryPos[si + 1] : pos.length;
    segments.push({ items: pos.slice(entryPos[si], end), isMission: true, index: si });
  }
  // per-namespace label maps + duplicate errors
  segments.forEach(function (sg) {
    sg.labels = {};
    sg.items.forEach(function (it) {
      if (it.t === "label") {
        if (sg.labels[it.name] !== undefined) {
          errors.push({ line: it.line, msg: "duplicate label :" + it.name +
            (sg.isMission ? " in mission " + sg.index : " in main block") });
        } else sg.labels[it.name] = it;
      }
    });
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings };

  // ---- pass 4: resolve values, compute sizes ----
  var aliased = {};
  function gvarOff(vn, line) {
    if (vn.k === "gnum") return vn.off;
    var e = varNames[vn.name];
    if (!e) {
      errors.push({ line: line, msg: "undeclared global $" + vn.name +
        " (declare with VAR_INT/VAR_FLOAT or use $<offset>)" });
      return null;
    }
    return e.off;
  }
  function resolveArg(val, spec, line) {
    var at = argType(spec), fl = argFlags(spec);
    function noVar(kind) {
      errors.push({ line: line, msg: kind + " variable not allowed here" });
      return null;
    }
    if (at === "L") {
      if (val.k !== "label") {
        errors.push({ line: line, msg: "expected @label, got '" + valText(val) + "'" });
        return null;
      }
      return { k: "L", name: val.name, size: 5 };
    }
    if (at === "T") {
      if (val.k !== "str") {
        errors.push({ line: line, msg: "expected 'text label', got '" + valText(val) + "'" });
        return null;
      }
      var bytes = decodeStringBody(val.body);
      if (bytes === null || bytes.length > 8) {
        errors.push({ line: line, msg: "bad text label (max 8 chars, \\xNN escapes allowed)" });
        return null;
      }
      return { k: "T", bytes: bytes, size: 8 };
    }
    // I / F / C / P
    if (val.k === "gnum" || val.k === "gname") {
      if (at === "C") {
        errors.push({ line: line, msg: "constant expected, got variable " + valText(val) });
        return null;
      }
      if (fl & F_NOGLOB) return noVar("global");
      var off = gvarOff(val, line);
      if (off === null) return null;
      if (off < 8) { errors.push({ line: line, msg: "global offset " + off + " < 8 (engine minimum)" }); return null; }
      if (off % 4 !== 0) { errors.push({ line: line, msg: "global offset " + off + " not 4-aligned" }); return null; }
      if (off > 65532) { errors.push({ line: line, msg: "global offset " + off + " exceeds u16 range" }); return null; }
      if (val.k === "gnum") {
        for (var ni = 0; ni < varOrder.length; ni++) {
          if (varNames[varOrder[ni]].off === off && !aliased[off]) {
            aliased[off] = 1;
            warnings.push({ line: line, msg: "$" + off + " aliases declared $" + varOrder[ni] });
          }
        }
      }
      return { k: "G", off: off, size: 3 };
    }
    if (val.k === "lvar") {
      if (at === "C") {
        errors.push({ line: line, msg: "constant expected, got variable " + valText(val) });
        return null;
      }
      if (fl & F_NOLOCAL) return noVar("local");
      if (val.idx < 0 || val.idx > LIMITS.maxLocal) {
        errors.push({ line: line, msg: "local var " + val.idx + "@ out of range (0@..17@/TIMERA/TIMERB)" });
        return null;
      }
      return { k: "V", idx: val.idx, size: 3 };
    }
    if (val.k === "label") {
      errors.push({ line: line, msg: "@label not allowed here" });
      return null;
    }
    if (val.k === "str") {
      errors.push({ line: line, msg: "'text' only allowed for text-label arguments" });
      return null;
    }
    // numbers / idents / models
    var num = null;
    if (val.k === "inum" || val.k === "fnum") num = val;
    else if (val.k === "model") {
      var dbm = DB();
      if (dbm.models[val.name] !== undefined) num = { k: "inum", v: dbm.models[val.name] };
      else {
        var li2 = levelIndexOf(val.name, levelModels);
        if (li2 < 0) {
          errors.push({ line: line, msg: "unknown model #" + val.name +
            " (add DEFINE OBJECT " + val.name + " or check the name)" });
          return null;
        }
        num = { k: "inum", v: -(li2 + 1) };
      }
    } else if (val.k === "ident") {
      var rslv = resolveIdent(val.name, spec, levelModels, at === "C");
      if (!rslv) {
        var hint = (argEnum(spec) === "MODEL" || argEnum(spec) === "DEFAULTMODEL") ?
          " (not a known model; add DEFINE OBJECT " + val.name + " or use a number)" :
          " (not a known constant; use #NAME for models)";
        errors.push({ line: line, msg: "unknown identifier '" + val.name + "'" + hint });
        return null;
      }
      num = { k: "inum", v: rslv.v };
    }
    if (!num) return null;
    if (fl & F_OUT) {
      errors.push({ line: line, msg: "this argument outputs a value, so it must be a variable" });
      return null;
    }
    if (fl & F_NOCONST) {
      errors.push({ line: line, msg: "a variable is required here, got '" + valText(val) + "'" });
      return null;
    }
    if (at === "F") {
      if (val.k === "ident" || val.k === "model") {
        errors.push({ line: line, msg: "a number is required here, got '" + valText(val) + "'" });
        return null;
      }
      var fv = num.k === "fnum" ? num.v : num.v;
      if (!isFinite(fv)) { errors.push({ line: line, msg: "bad float '" + valText(val) + "'" }); return null; }
      // canonicalize through float32
      var fb = new ArrayBuffer(4);
      new DataView(fb).setFloat32(0, fv, true);
      fv = new DataView(fb).getFloat32(0, true);
      return { k: "F", v: fv, size: 5 };
    }
    // I / C / P
    var iv;
    if (num.k === "fnum") {
      if (Math.floor(num.v) !== num.v) {
        errors.push({ line: line, msg: "expected an integer, got " + num.v });
        return null;
      }
      iv = num.v;
    } else iv = num.v;
    if (iv < -2147483648 || iv > 2147483647) {
      errors.push({ line: line, msg: "integer " + iv + " out of 32-bit range" });
      return null;
    }
    return { k: "N", v: iv | 0, size: 1 + widthForInt(iv | 0) };
  }

  function valText(val) {
    if (val.k === "inum" || val.k === "fnum") return String(val.v);
    if (val.k === "label") return "@" + val.name;
    if (val.k === "gnum") return "$" + val.off;
    if (val.k === "gname") return "$" + val.name;
    if (val.k === "lvar") return fmtLocalVar(val.idx);
    if (val.k === "model") return "#" + val.name;
    if (val.k === "ident") return val.name;
    if (val.k === "str") return "'" + val.body + "'";
    return "?";
  }

  segments.forEach(function (sg) {
    sg.items.forEach(function (it) {
      if (it.t === "hex") { it.size = it.bytes.length; return; }
      if (it.t !== "insn") return;
      var cmd = cmdById(it.id);
      var need = cmdArgs(cmd).length, variadic = isVariadic(cmd);
      if ((!variadic && it.args.length !== need) ||
          (variadic && it.args.length < need - 1)) {
        errors.push({ line: it.line, msg: cmdName(cmd) + " takes " +
          (variadic ? "at least " + (need - 1) : need) + " argument(s), got " + it.args.length });
        return;
      }
      it.res = [];
      var bad = false;
      for (var k = 0; k < it.args.length; k++) {
        var spec = argSpec(cmd, k);
        var rv = resolveArg(it.args[k], spec, it.line);
        if (!rv) { bad = true; break; }
        it.res.push(rv);
      }
      if (bad) return;
      it.size = 2;
      it.res.forEach(function (rv) { it.size += rv.size; });
      if (variadic) it.size += 1; // EOAL terminator
    });
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings };

  // ---- offsets within each segment ----
  segments.forEach(function (sg) {
    var off = 0;
    sg.items.forEach(function (it) {
      if (it.t === "label") { it.pos = off; return; }
      it.pos = off;
      off += it.size;
    });
    sg.codeLen = off;
  });

  // ---- global space ----
  var need = 8;
  segments.forEach(function (sg) {
    sg.items.forEach(function (it) {
      if (it.t !== "insn" || !it.res) return;
      it.res.forEach(function (rv) {
        if (rv.k === "G" && rv.off + 4 > need) need = rv.off + 4;
      });
    });
  });
  if (varOrder.length && 8 + varOrder.length * 4 > need) need = 8 + varOrder.length * 4;
  var sizeGlobals = gspace !== null ? gspace : need;
  if (sizeGlobals < need) {
    errors.push({ line: gspaceLine, msg: "DEFINE GLOBAL_SPACE " + sizeGlobals +
      " too small; need at least " + need });
    return { ok: false, errors: errors, warnings: warnings };
  }

  // ---- label values ----
  function suggest(name, sg) {
    var cands = [];
    function consider(map, where) {
      Object.keys(map).forEach(function (n) {
        var d = lev(name, n);
        if (d <= 3) cands.push({ n: n, d: d, w: where });
      });
    }
    consider(segments[0].labels, "main block");
    segments.forEach(function (s) {
      if (s.isMission) consider(s.labels, "mission " + s.index);
    });
    cands.sort(function (a, b) { return a.d - b.d; });
    return cands.slice(0, 3).map(function (c) { return "@" + c.n + " (" + c.w + ")"; });
  }
  var labelErr = false;
  segments.forEach(function (sg) {
    sg.items.forEach(function (it) {
      if (it.t !== "insn" || !it.res) return;
      it.res.forEach(function (rv) {
        if (rv.k !== "L") return;
        var hit = sg.labels[rv.name];
        if (hit) {
          if (!sg.isMission) rv.value = null; // absolute: filled after layout
          else {
            if (hit.pos === 0) {
              errors.push({ line: it.line, msg: "@" + rv.name +
                " is at the very start of mission " + sg.index +
                "; the engine cannot encode offset 0" });
              labelErr = true; return;
            }
            rv.value = -hit.pos;
          }
          return;
        }
        if (sg.isMission && segments[0].labels[rv.name]) {
          rv.value = null; // main-block absolute: filled after layout
          rv.mainRef = true;
          return;
        }
        var s = suggest(rv.name, sg);
        errors.push({ line: it.line, msg: "undefined label @" + rv.name +
          (s.length ? "; did you mean " + s.join(", ") + "?" : "") });
        labelErr = true;
      });
    });
  });
  if (labelErr || errors.length) return { ok: false, errors: errors, warnings: warnings };

  // ---- layout ----
  var hdrLen = 8 + (sizeGlobals - 8) + 8 + 4 + 24 * objCount +
    8 + 4 + 4 + 2 + 2 + 4 * numMissions;
  var mainBase = hdrLen;
  var mainLen = segments[0].codeLen;
  var mainSize = mainBase + mainLen;
  var misBase = [], acc = mainSize, largest = 0;
  segments.forEach(function (sg) {
    if (!sg.isMission) return;
    misBase.push(acc);
    acc += sg.codeLen;
    if (sg.codeLen > largest) largest = sg.codeLen;
  });

  // fill absolute label values
  function absOf(sg, name) {
    var base = sg.isMission ? misBase[sg.index] : mainBase;
    return base + sg.labels[name].pos;
  }
  segments.forEach(function (sg) {
    sg.items.forEach(function (it) {
      if (it.t !== "insn" || !it.res) return;
      it.res.forEach(function (rv) {
        if (rv.k !== "L" || rv.value !== null) return;
        rv.value = rv.mainRef ? absOf(segments[0], rv.name) : absOf(sg, rv.name);
      });
    });
  });

  // trailing-label warnings
  segments.forEach(function (sg) {
    sg.items.forEach(function (it) {
      if (it.t === "label" && it.pos === sg.codeLen) {
        warnings.push({ line: it.line, msg: ":" + it.name + " points at the end of " +
          (sg.isMission ? "mission " + sg.index : "the main block") + " (jumping there crashes)" });
      }
    });
  });

  // ---- budgets ----
  if (mainSize > LIMITS.mainSizePC) {
    errors.push({ line: 0, msg: "main block is " + mainSize + " bytes, over the PC limit " +
      LIMITS.mainSizePC + " -- the game cannot load it" });
    return { ok: false, errors: errors, warnings: warnings };
  }
  if (mainSize > LIMITS.mainSizePS2) {
    warnings.push({ line: 0, msg: "main block is " + mainSize + " bytes (PS2 limit " +
      LIMITS.mainSizePS2 + ", PC limit " + LIMITS.mainSizePC + ")" });
  }
  segments.forEach(function (sg) {
    if (sg.isMission && sg.codeLen > LIMITS.missionSize) {
      errors.push({ line: 0, msg: "mission " + sg.index + " is " + sg.codeLen +
        " bytes, over the limit " + LIMITS.missionSize });
    }
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings };

  // ---- emit ----
  var w = new Writer();
  function skipper(target) {
    w.u16(0x0002); w.u8(OT_I32); w.i32(target);
  }
  skipper(sizeGlobals);
  w.u8(TARGET_MIAMI);
  w.fill(sizeGlobals - 8, 0);
  var seg2 = w.len();
  skipper(seg2 + 8 + 4 + 24 * objCount);
  w.u8(0);
  w.u32(objCount);
  w.fill(24, 0); // dummy entry 0
  for (var oi = 1; oi < objCount; oi++) {
    var onm = objNames[oi];
    if (onm === "DUMMY") { w.fill(24, 0); continue; }
    for (var ci = 0; ci < 24; ci++) {
      w.u8(ci < onm.length ? onm.charCodeAt(ci) & 255 : 0);
    }
  }
  var seg3 = w.len();
  skipper(seg3 + 8 + 4 + 4 + 2 + 2 + 4 * numMissions);
  w.u8(0);
  w.u32(mainSize);
  w.u32(largest);
  w.u16(numMissions);
  w.u16(0);
  for (var mi2 = 0; mi2 < numMissions; mi2++) w.u32(misBase[mi2]);

  segments.forEach(function (sg) {
    sg.items.forEach(function (it) {
      if (it.t === "hex") { w.raw(it.bytes); return; }
      if (it.t !== "insn") return;
      var cmd = cmdById(it.id);
      w.u16(it.id | (it.not ? 0x8000 : 0));
      it.res.forEach(function (rv) {
        if (rv.k === "N") {
          var v = rv.v | 0;
          if (v >= -128 && v <= 127) { w.u8(OT_I8); w.u8(v); }
          else if (v >= -32768 && v <= 32767) { w.u8(OT_I16); w.i16(v); }
          else { w.u8(OT_I32); w.i32(v); }
        }
        else if (rv.k === "F") { w.u8(OT_F32); w.f32(rv.v); }
        else if (rv.k === "G") { w.u8(OT_GVAR); w.u16(rv.off); }
        else if (rv.k === "V") { w.u8(OT_LVAR); w.u16(rv.idx); }
        else if (rv.k === "L") { w.u8(OT_I32); w.i32(rv.value); }
        else if (rv.k === "T") {
          w.raw(rv.bytes);
          for (var p = rv.bytes.length; p < 8; p++) w.u8(0);
        }
      });
      if (isVariadic(cmd)) w.u8(OT_END);
    });
  });

  var stats = {
    sizeGlobals: sizeGlobals, objectCount: objCount, numMissions: numMissions,
    mainSize: mainSize, mainLen: mainLen, codeOffset: mainBase,
    largestMission: largest, fileSize: w.len()
  };
  return { ok: true, bytes: w.result(), errors: [], warnings: warnings, stats: stats };
}

/* ============================ reference API ============================ */

function describeCommand(id) {
  var cmd = cmdById(id);
  if (!cmd) return null;
  return {
    id: id, name: cmdName(cmd), unsupported: cmdUnsupported(cmd),
    args: cmdArgs(cmd).map(function (a) {
      return { type: argType(a), flags: argFlags(a), desc: argDesc(a),
        enm: argEnum(a), entity: argEntity(a) };
    })
  };
}

function commandList() {
  var out = [];
  var ops = DB().ops;
  Object.keys(ops).forEach(function (k) {
    var cmd = ops[k];
    out.push({ id: +k, name: cmdName(cmd), nargs: cmdArgs(cmd).length,
      variadic: isVariadic(cmd), unsupported: cmdUnsupported(cmd) });
  });
  out.sort(function (a, b) { return a.id - b.id; });
  return out;
}

return {
  VERSION: VERSION,
  LIMITS: LIMITS,
  parseHeader: parseHeader,
  missionRanges: missionRanges,
  disassemble: disassemble,
  assemble: assemble,
  checkSection: checkSection,
  describeCommand: describeCommand,
  commandList: commandList,
  formatFloat: formatFloat,
  _debug: { Reader: Reader, decodeSegment: decodeSegment, cmdById: cmdById }
};

})();
if (typeof module !== "undefined" && module.exports) { module.exports = SCM; }
