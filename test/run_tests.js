/* Node test harness for the SCM core engine (js/scm.js + js/opcodes.js).
 * Run: node test/run_tests.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

global.VC_DB = require("../js/opcodes.js");
const SCM = require("../js/scm.js");

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.log("  FAIL:", msg); }
}
function eq(a, b, msg) {
  if (a === b) { passed++; }
  else { failed++; console.log("  FAIL: " + msg + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }
}

const ROOT = path.join(__dirname, "..");
const mainPath = path.join(ROOT, "main.scm");

console.log("== load & header ==");
const orig = new Uint8Array(fs.readFileSync(mainPath));
eq(orig.length, 1269133, "main.scm size");
const hdr = SCM.parseHeader(orig);
ok(hdr.ok, "parseHeader ok: " + (hdr.error || ""));
if (hdr.ok) {
  eq(hdr.sizeGlobals, 0x8620, "sizeGlobals");
  eq(hdr.codeOffset, 0x9AE4, "codeOffset");
  eq(hdr.objectCount, 204, "objectCount");
  eq(hdr.models.length, 203, "models");
  eq(hdr.models[0], "DTN_STADDOORA", "model[0]");
  eq(hdr.mainSize, 0x31F34, "mainSize");
  eq(hdr.numMissions, 97, "numMissions");
  eq(hdr.missionOffsets[0], 0x31F34, "mission0 off");
}

console.log("== disassemble ==");
let t0 = Date.now();
const dis = SCM.disassemble(orig);
console.log("   disassemble took " + (Date.now() - t0) + "ms");
ok(dis.ok, "disassemble ok: " + (dis.error || ""));
let src = "";
if (dis.ok) {
  eq(dis.sections.length, 99, "section count (header+main+97)");
  eq(dis.stats.totalInsns, 153058, "total insns");
  eq(dis.stats.mainInsns, 20625, "main insns");
  eq(dis.stats.globals.min, 8, "global min");
  eq(dis.stats.globals.max, 34332, "global max");
  eq(dis.warnings.length, 0, "no disasm warnings (got " + dis.warnings.length + ": " + dis.warnings.slice(0, 3).join(" | ") + ")");
  const allLines = dis.sections.map(s => s.lines).flat();
  console.log("   total lines: " + allLines.length);
  const main = dis.sections[1].lines;
  ok(main[0].indexOf("SECTION:MAIN") >= 0, "main marker");
  eq(main[2], ":MAIN", "first label");
  eq(main[3], "03A4: SCRIPT_NAME 'MAIN'", "first insn: " + main[3]);
  eq(dis.sections[2].lines[2], ":INITIAL", "mission0 entry");
  const htxt = dis.sections[0].lines.join("\n");
  for (const m of dis.stats.missions) {
    if (!htxt.includes("DEFINE MISSION " + m.index + " AT @" + m.name)) {
      ok(false, "mission table " + m.index);
    }
  }
  passed++;
  src = dis.sections.map(s => s.lines.join("\n")).join("\n");
}

console.log("== assemble (round-trip) ==");
t0 = Date.now();
const asm = SCM.assemble(src);
console.log("   assemble took " + (Date.now() - t0) + "ms");
ok(asm.ok, "assemble ok, errors: " + JSON.stringify((asm.errors || []).slice(0, 3)));
if (asm.ok) {
  eq(asm.bytes.length, orig.length, "round-trip size");
  fs.writeFileSync("/tmp/rt.scm", asm.bytes);
  const dis2 = SCM.disassemble(asm.bytes);
  ok(dis2.ok, "re-disassemble ok");
  const src2 = dis2.sections.map(s => s.lines.join("\n")).join("\n");
  const asm2 = SCM.assemble(src2);
  ok(asm2.ok, "re-assemble ok: " + JSON.stringify((asm2.errors || []).slice(0, 2)));
  if (asm2.ok) {
    let same = asm2.bytes.length === asm.bytes.length;
    if (same) for (let i = 0; i < asm.bytes.length; i++) {
      if (asm2.bytes[i] !== asm.bytes[i]) { same = false; break; }
    }
    ok(same, "fixpoint: second assembly byte-identical");
  }
  console.log("   warnings: " + asm.warnings.length);
  asm.warnings.slice(0, 5).forEach(w => console.log("     -", w.msg));
}

console.log("== unit: minimal file ==");
{
  const t = [
    "DEFINE GLOBAL_SPACE 16",
    "DEFINE OBJECTS 1",
    "DEFINE OBJECT DUMMY",
    "DEFINE MISSIONS 1",
    "DEFINE MISSION 0 AT @M0",
    ":MAIN",
    "03A4: SCRIPT_NAME 'MAIN'",
    "0001: WAIT 250",
    "0002: GOTO @MAIN",
    ":M0",
    "03A4: SCRIPT_NAME 'M0'",
    "004E: TERMINATE_THIS_SCRIPT",
  ].join("\n");
  const a = SCM.assemble(t);
  ok(a.ok, "minimal assembles: " + JSON.stringify(a.errors));
  if (a.ok) {
    const h = SCM.parseHeader(a.bytes);
    ok(h.ok && h.numMissions === 1, "minimal header reparses");
    const d = SCM.disassemble(a.bytes);
    ok(d.ok && d.stats.totalInsns === 5, "minimal round-trip insns");
  }
}

console.log("== unit: operands ==");
{
  const t = [
    "DEFINE GLOBAL_SPACE 64",
    "DEFINE OBJECTS 2",
    "DEFINE OBJECT DUMMY",
    "DEFINE OBJECT MYMODEL",
    "DEFINE MISSIONS 0",
    "VAR_INT $foo",
    "VAR_FLOAT bar",
    ":MAIN",
    "0004: SET_VAR_INT $foo 127",
    "SET_VAR_INT $8 -128",
    "SET_VAR_INT $12 128",
    "SET_VAR_INT $16 -129",
    "SET_VAR_INT $20 32767",
    "SET_VAR_INT $24 -32768",
    "SET_VAR_INT $28 32768",
    "SET_VAR_INT $32 0x7FFFFFFF",
    "SET_VAR_INT $36 -2147483648",
    "SET_VAR_FLOAT $bar -0.0",
    "SET_VAR_FLOAT $40 83.0",
    "SET_VAR_FLOAT $44 1e3",
    "SET_LVAR_INT_TO_VAR_INT 0@ $foo",
    "SET_LVAR_INT_TO_LVAR_INT 15@ TIMERA",
    "SET_LVAR_INT_TO_LVAR_INT 1@ TIMERB",
    "SET_LVAR_INT_TO_LVAR_INT 2@ 16@",
    "SET_LVAR_INT TIMERA 0",
    "REQUEST_MODEL #ADMIRAL",
    "REQUEST_MODEL MYMODEL",
    "REQUEST_MODEL #MYMODEL",
    "DO_FADE TRUE 1000",
    "NOT IS_CHAR_DEAD $foo",
    "8001: WAIT 0",
  ].join("\n");
  const a = SCM.assemble(t);
  ok(a.ok, "operands assemble: " + JSON.stringify(a.errors));
  if (a.ok) {
    const d = SCM.disassemble(a.bytes);
    ok(d.ok, "operands re-disassemble");
    const txt = d.sections.map(s => s.lines.join("\n")).join("\n");
    ok(txt.includes("SET_VAR_INT $8 127"), "i8 round-trip");
    ok(txt.includes("SET_VAR_INT $28 32768"), "i32 round-trip");
    ok(txt.includes("REQUEST_MODEL #ADMIRAL"), "default model round-trip");
    ok(txt.includes("REQUEST_MODEL #MYMODEL"), "level model round-trip");
    ok(txt.includes("NOT 0001: WAIT 0"), "NOT via 8xxx round-trip");
    ok(txt.includes("SET_VAR_FLOAT $44 1000.0"), "float exp round-trip");
  }
}

console.log("== unit: float bit fidelity ==");
{
  // every distinct float in retail main.scm must survive text round-trip
  const r = new SCM._debug.Reader(orig);
  const seen = new Set();
  const h = SCM.parseHeader(orig);
  const ranges = SCM.missionRanges(h);
  const segs = [[h.codeOffset, h.mainSize]];
  ranges.forEach(rg => segs.push(rg));
  for (const [s, e] of segs) {
    const seg = SCM._debug.decodeSegment(r, s, e);
    for (const d of seg.insns) for (const op of d.ops) {
      if (op.k === "f") {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, op.v, true);
        seen.add(new DataView(buf).getUint32(0, true));
      }
    }
  }
  console.log("   distinct floats: " + seen.size);
  let bad = 0;
  for (const bits of seen) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, bits, true);
    const f = new DataView(buf).getFloat32(0, true);
    const s = SCM.formatFloat(f);
    const back = new DataView(new ArrayBuffer(4));
    back.setFloat32(0, parseFloat(s), true);
    if (back.getUint32(0, true) !== bits) { bad++; if (bad < 4) console.log("   BAD", bits.toString(16), s); }
  }
  eq(bad, 0, "float text round-trip losses");
}

console.log("== unit: errors ==");
function asmErr(lines, want) {
  const a = SCM.assemble(lines.join("\n"));
  if (a.ok) { ok(false, "expected error (" + want + "), got OK"); return null; }
  const msgs = a.errors.map(e => e.msg).join(" // ");
  ok(msgs.toLowerCase().includes(want.toLowerCase()),
    "error contains '" + want + "' (got: " + msgs.slice(0, 160) + ")");
  return a.errors[0];
}
const HDR = [
  "DEFINE GLOBAL_SPACE 64", "DEFINE OBJECTS 1", "DEFINE OBJECT DUMMY",
  "DEFINE MISSIONS 0", ":MAIN",
];
asmErr(HDR.concat(["0001: WAIT @NOPE"]), "not allowed here");
asmErr(HDR.concat(["0001: WAIT 0", "0002: GOTO @WRONGA"]), "undefined label");
asmErr(HDR.concat([":WRONGA", "0001: WAIT 0", "0002: GOTO @WRONGB"]), "did you mean");
asmErr(HDR.concat([":DUP", ":DUP", "0001: WAIT 0"]), "duplicate label");
asmErr(HDR.concat(["00B2: 0"]), "unknown opcode");
asmErr(HDR.concat(["03A4: SCRIPT_NAME MAIN"]), "expected 'text label'");
asmErr(HDR.concat(["03A4: SCRIPT_NAME 'TOOLONG12'"]), "bad text label");
asmErr(HDR.concat(["0001: WAIT 1 2"]), "takes 1 argument");
asmErr(HDR.concat(["0004: SET_VAR_INT 5 6"]), "a variable is required here");
asmErr(HDR.concat(["0004: SET_VAR_INT $4 6"]), "offset 4 < 8");
asmErr(HDR.concat(["0004: SET_VAR_INT $10 6"]), "not 4-aligned");
asmErr(HDR.concat(["0004: SET_VAR_INT $100 6"]), "too small");
asmErr(HDR.concat(["SET_LVAR_INT 18@ 1"]), "out of range");
asmErr(HDR.concat(["REQUEST_MODEL #NOPE_XYZ"]), "unknown model");
asmErr(HDR.concat(["0001: WAIT FROBNICATE"]), "unknown identifier");
asmErr([":MAIN", "HEX", "ZZ", "END"].concat(HDR.slice(0, 4)), "bad hex");
asmErr(HDR.concat(["HEX", "A4 03"]), "HEX block without END");
{
  // HEX round-trip preserves bytes exactly
  const t = HDR.concat(["HEX", "A4 03 00 11 22 33", "END", "0001: WAIT 0"]);
  const a = SCM.assemble(t.join("\n"));
  ok(a.ok, "HEX block assembles: " + JSON.stringify(a.errors));
}
{
  // mission-local offset 0
  const t = HDR.slice(0, 3).concat([
    "DEFINE MISSIONS 1", "DEFINE MISSION 0 AT @M0", ":MAIN",
    "0001: WAIT 0", ":M0", "0002: GOTO @M0",
  ]);
  asmErr(t, "cannot encode offset 0");
}
{
  // mission order violation
  const t = HDR.slice(0, 3).concat([
    "DEFINE MISSIONS 2", "DEFINE MISSION 0 AT @A", "DEFINE MISSION 1 AT @B",
    ":MAIN", ":B", "0001: WAIT 0", ":A", "004E: TERMINATE_THIS_SCRIPT",
  ]);
  asmErr(t, "not found after the previous");
}
{
  // main code cannot reach mission labels
  const t = HDR.slice(0, 3).concat([
    "DEFINE MISSIONS 1", "DEFINE MISSION 0 AT @M0", ":MAIN",
    "0002: GOTO @INNER", ":M0", ":INNER", "004E: TERMINATE_THIS_SCRIPT",
  ]);
  const a = SCM.assemble(t.join("\n"));
  ok(!a.ok && /mission 0/.test(a.errors.map(e => e.msg).join()),
    "main->mission ref suggests mission scope");
}
{
  // mission CAN reference main labels (positive absolute)
  const t = HDR.slice(0, 3).concat([
    "DEFINE MISSIONS 1", "DEFINE MISSION 0 AT @M0", ":MAIN",
    ":SHARED", "0001: WAIT 0", ":M0", "0002: GOTO @SHARED",
  ]);
  const a = SCM.assemble(t.join("\n"));
  ok(a.ok, "mission->main ref assembles: " + JSON.stringify(a.errors));
}

console.log("== unit: reference API ==");
eq(SCM.commandList().length, 1424, "command count");
{
  const d = SCM.describeCommand(0x3A4);
  eq(d.name, "SCRIPT_NAME", "describe 03A4");
  eq(d.args.length, 1, "03A4 nargs");
  eq(d.args[0].type, "T", "03A4 arg0 TEXT_LABEL");
}

console.log("== symbols ==");
const VC_SYM = require("../js/symbols.js");
{
  eq(VC_SYM.META.globals, 8480, "symbol globals");
  eq(VC_SYM.META.insns, 153058, "symbol insns");
  eq(VC_SYM.META.triples, 483, "symbol triples");
  eq(VC_SYM.META.fileSize, 1269133, "symbol fileSize");
  // fnv must match a fresh hash of main.scm
  let h = 0x811C9DC5;
  for (let i = 0; i < orig.length; i++) { h ^= orig[i]; h = Math.imul(h, 0x01000193); }
  eq(VC_SYM.META.fnv, ("0000000" + (h >>> 0).toString(16)).slice(-8), "symbol fnv");
  const spot = [
    [8, 1, 6040, "handle", "player"],
    [12, 8, 635, "var", "player_char"],
    [92, 1, 85, "const", "main_tick_ms"],
    [380, 73, 220, "coord", "scratch_pos_x"],
    [496, 1309, 1214, "var", "cutscene_time"],
    [500, 67, 70, "handle", "cutscene_object"],
    [1252, 232, 174, "flag", "mission_flag"],
    [26912, 0, 1, "uninit", "uninit_26912"],
  ];
  for (const [off, w, r, cat, name] of spot) {
    const e = VC_SYM.entry(off);
    ok(!!e, "entry $" + off);
    if (e) {
      eq(e.w, w, "$" + off + " writes");
      eq(e.r, r, "$" + off + " reads");
      eq(e.cat, cat, "$" + off + " cat");
      eq(e.name, name, "$" + off + " name");
    }
  }
  eq(VC_SYM.entry(99999), null, "unknown offset -> null");
  // every name: valid identifier, unique, no opcode/reserved collision
  const seen = new Set();
  const reserved = ["DEFINE", "OBJECTS", "OBJECT", "MISSIONS", "MISSION", "AT",
    "GLOBAL_SPACE", "VAR_INT", "VAR_FLOAT", "HEX", "END", "NOT", "TIMERA", "TIMERB"];
  let bad = 0;
  for (const k of Object.keys(VC_SYM.G)) {
    const n = VC_SYM.G[k][4];
    const up = n.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || n.length > 40) { bad++; console.log("  BADNAME", k, n); }
    if (seen.has(up)) { bad++; console.log("  DUP", k, n); }
    seen.add(up);
    if (global.VC_DB.byName[up] !== undefined) { bad++; console.log("  OPCOLLIDE", k, n); }
    if (reserved.indexOf(up) >= 0) { bad++; console.log("  DIRCIDE", k, n); }
  }
  eq(bad, 0, "name validity/uniqueness (" + seen.size + " names)");
  eq(VC_SYM.find("player_char", 10).length >= 1, true, "find() hits");
  eq(VC_SYM.find("player_char", 10)[0].off, 12, "find() offset");
  ok(VC_SYM.T.indexOf(380) >= 0, "triple base 380 listed");
}

console.log("== symbols: generator determinism & freshness ==");
{
  const builder = require("../tools/build_symbols.js");
  const a = builder.emit(builder.build());
  const b = builder.emit(builder.build());
  eq(a, b, "two builds are byte-identical");
  const committed = fs.readFileSync(path.join(ROOT, "js", "symbols.js"), "utf8");
  eq(a, committed, "committed js/symbols.js matches a fresh build");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
