/* Symbol-table builder: analyses main.scm and emits js/symbols.js.
 *
 * For every referenced global it records reads/writes/type/category and
 * generates a stable, human-friendly name. Deterministic: same input bytes
 * always produce the same output bytes.
 *
 * Usage: node tools/build_symbols.js   (writes js/symbols.js)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
global.VC_DB = require(path.join(ROOT, "js", "opcodes.js"));
const SCM = require(path.join(ROOT, "js", "scm.js"));

// Opcodes whose var-only arg0 is an INPUT, not a destination (verified against
// the retail script: DECLARE_* / DISPLAY_* only reference their variable).
const READONLY_ARG0 = new Set([
  0x14E, 0x14F, 0x150, 0x151, 0x180, 0x3C3, 0x3C4, 0x4F6, 0x4F7, 0x59C
]);

// Hand-picked names for the most-shared globals. Everything else is generated.
const CURATED = {
  8: "player",
  12: "player_char",
  72: "controller_mode",
  92: "main_tick_ms",
  380: "scratch_pos_x",
  384: "scratch_pos_y",
  388: "scratch_pos_z",
  496: "cutscene_time",
  500: "cutscene_object",
  564: "cutscene_object_2",
  1252: "mission_flag",
  1576: "mission_start_time"
};

function fnv1a(u8) {
  let h = 0x811C9DC5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

function sanitize(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] & 255;
    if (c === 0) break;
    const ch = String.fromCharCode(c).toUpperCase();
    s += /[A-Z0-9_]/.test(ch) ? ch : "_";
  }
  if (!s) return null;
  if (/[0-9]/.test(s.charAt(0))) s = "_" + s;
  return s.length > 24 ? s.slice(0, 24) : s;
}

function slugify(entry, idx) {
  let s = String(entry || "").toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 16).replace(/_+$/g, "");
  return s || ("m" + idx);
}

function isWrite(id, name, argpos, flags) {
  if (flags & 2) return true;
  if (argpos === 0 && (flags & 4) && name.indexOf("IS_") !== 0 &&
      !READONLY_ARG0.has(id)) return true;
  return false;
}

function build() {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, "main.scm")));
  const hdr = SCM.parseHeader(bytes);
  if (!hdr.ok) throw new Error("parseHeader: " + hdr.error);
  const ranges = SCM.missionRanges(hdr);
  const reader = new SCM._debug.Reader(bytes);

  const segs = [{ tag: "MAIN", idx: -1, s: hdr.codeOffset, e: hdr.mainSize }];
  ranges.forEach((rg, i) => segs.push({ tag: "MISSION:" + i, idx: i, s: rg[0], e: rg[1] }));
  segs.forEach(sg => { sg.dec = SCM._debug.decodeSegment(reader, sg.s, sg.e); });

  // mission entry slugs (from SCRIPT_NAME), deduped
  const usedSlugs = new Set(["main", "shared"]);
  const slugs = segs.map(sg => {
    if (sg.idx < 0) return "main";
    let entry = null;
    const ins = sg.dec.insns;
    if (ins.length && ins[0].id === 0x3A4 && !ins[0].not &&
        ins[0].ops.length && ins[0].ops[0].k === "t") {
      entry = sanitize(ins[0].ops[0].raw);
    }
    let slug = slugify(entry, sg.idx), base = slug, n = 2;
    while (usedSlugs.has(slug)) slug = base + "_" + (n++);
    usedSlugs.add(slug);
    return slug;
  });

  // ---- census pass ----
  const G = new Map(); // off -> rec
  function rec(off) {
    let r = G.get(off);
    if (!r) {
      r = { r: 0, w: 0, types: new Set(), writers: new Map(), readers: new Map(),
            secs: new Set(), setVals: [], setDisp: [], selfArith: false };
      G.set(off, r);
    }
    return r;
  }
  const coUse = new Map(); // triple-base candidate -> count
  let insns = 0;
  segs.forEach(sg => {
    sg.dec.insns.forEach(d => {
      insns++;
      const cmd = SCM._debug.cmdById(d.id);
      const args = cmd[1], nspec = args.length;
      const variadic = nspec > 0 && (args[nspec - 1][1] & 1) !== 0;
      const gvars = [];
      for (let k = 0; k < d.ops.length; k++) {
        const op = d.ops[k];
        if (op.k !== "g") continue;
        gvars.push(op.v);
        const spec = k < nspec ? args[k] : (variadic ? args[nspec - 1] : null);
        if (!spec) continue;
        const r = rec(op.v);
        r.types.add(spec[0]);
        r.secs.add(sg.tag);
        const tag = ("000" + d.id.toString(16).toUpperCase()).slice(-4) + ":" + cmd[0];
        if (isWrite(d.id, cmd[0], k, spec[1])) {
          r.w++;
          r.writers.set(tag, (r.writers.get(tag) || 0) + 1);
          if (d.id === 0x04 || d.id === 0x05 || d.id === 0x4AE) {
            const nx = d.ops[k + 1];
            if (nx && (nx.k === "i" || nx.k === "f")) {
              r.setVals.push(nx.v);
              r.setDisp.push(nx.k === "f" ? SCM.formatFloat(nx.v) : String(nx.v));
            }
          }
          if (k === 0 && /^(ADD_|SUB_|MULT_|DIV_)/.test(cmd[0])) r.selfArith = true;
        } else {
          r.r++;
          r.readers.set(tag, (r.readers.get(tag) || 0) + 1);
        }
      }
      gvars.sort((a, b) => a - b);
      for (let i = 0; i + 2 < gvars.length; i++) {
        if (gvars[i + 1] === gvars[i] + 4 && gvars[i + 2] === gvars[i] + 8) {
          coUse.set(gvars[i], (coUse.get(gvars[i]) || 0) + 1);
        }
      }
    });
  });

  const typeOf = r => (r.types.size === 1 ? (r.types.has("F") ? "F" : "I") : "M");

  // ---- triples: same-instruction N/N+4/N+8, all float-only ----
  const tripleAt = new Map(); // member off -> {base, axis}
  const tripleBases = [];
  const bases = Array.from(coUse.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
  bases.forEach(([base]) => {
    const m = [base, base + 4, base + 8];
    if (m.some(o => !G.has(o) || typeOf(G.get(o)) !== "F" || tripleAt.has(o))) return;
    tripleBases.push(base);
    tripleAt.set(base, { base, axis: "x" });
    tripleAt.set(base + 4, { base, axis: "y" });
    tripleAt.set(base + 8, { base, axis: "z" });
  });
  tripleBases.sort((a, b) => a - b);

  // ---- classification ----
  function topWriter(r) {
    let best = "", n = 0;
    r.writers.forEach((c, t) => { if (c > n) { n = c; best = t; } });
    return best;
  }
  function topReader(r) {
    let best = "", n = 0;
    r.readers.forEach((c, t) => { if (c > n) { n = c; best = t; } });
    return best;
  }
  function entityOf(id) {
    const d = SCM.describeCommand(id);
    if (!d) return "";
    for (const a of d.args) {
      if ((a.flags & 2) && a.entity) return a.entity;
    }
    return "";
  }
  const offs = Array.from(G.keys()).sort((a, b) => a - b);
  const info = new Map(); // off -> {cat, x}
  offs.forEach(off => {
    const r = G.get(off);
    const sole = r.writers.size === 1 ? Array.from(r.writers.keys())[0] : null;
    const wname = sole ? sole.slice(5) : "";
    let cat = "", x = "";
    if (r.w === 0) { cat = "uninit"; x = topReader(r); }
    else if (tripleAt.has(off)) {
      cat = "coord";
      const tw = topWriter(r);
      x = tw ? ("triple " + tw) : "triple";
    }
    else if (r.w === 1 && r.r === 0) { cat = "dead"; x = sole || ""; }
    else if (r.w === 1 && sole && /^(0004|0005|04AE):/.test(sole)) {
      cat = "const"; x = r.setDisp.length ? r.setDisp[0] : "?";
    }
    else if (sole && (/^CREATE_/.test(wname) || /^ADD_BLIP/.test(wname))) {
      cat = "handle"; x = entityOf(parseInt(sole.slice(0, 4), 16)) || wname;
    }
    else if (r.w === 1 && sole && wname === "GET_GAME_TIMER") { cat = "timer"; x = sole; }
    else if (r.w === 1 && sole && /^GET_/.test(wname) && wname.indexOf("COORDINATES") >= 0) {
      cat = "coord"; x = sole;
    }
    else if (r.w === 1 && sole && /^(0084|0086|0088|0089|008A|008B):/.test(sole)) {
      cat = "copy"; x = sole;
    }
    else if (r.w === 1 && sole && (/^CSET_/.test(wname) || /^ABS_/.test(wname))) {
      cat = "conv"; x = sole;
    }
    else if (r.w === 1) { cat = "query"; x = sole || ""; }
    else {
      const onlySet = Array.from(r.writers.keys()).every(t => t.indexOf("0004:") === 0);
      const distinct = Array.from(new Set(r.setDisp));
      if (onlySet && distinct.length <= 2 &&
          distinct.every(v => v === "0" || v === "1")) {
        cat = "flag"; x = distinct.sort().join(",");
      } else if (onlySet && distinct.length <= 8) {
        cat = "state"; x = distinct.slice(0, 8).join(",");
      } else if (r.selfArith) { cat = "acc"; x = topWriter(r); }
      else { cat = "var"; x = topWriter(r); }
    }
    info.set(off, { cat, x });
  });

  // ---- naming ----
  const claimed = new Set();
  Object.keys(global.VC_DB.byName).forEach(n => claimed.add(n));
  ["DEFINE", "OBJECTS", "OBJECT", "MISSIONS", "MISSION", "AT", "GLOBAL_SPACE",
   "VAR_INT", "VAR_FLOAT", "HEX", "END", "NOT", "TIMERA", "TIMERB"]
    .forEach(n => claimed.add(n));
  function claim(want) {
    want = String(want);
    const up = want.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(want) || want.length > 40) return null;
    if (!claimed.has(up)) { claimed.add(up); return want; }
    return null;
  }
  function claimUnique(want) {
    let got = claim(want);
    if (got) return got;
    for (let i = 2; i < 10000; i++) {
      got = claim(want + "_" + i);
      if (got) return got;
    }
    throw new Error("claim overflow: " + want);
  }
  function scopeOf(off) {
    const secs = G.get(off).secs;
    if (secs.size === 1) {
      const only = Array.from(secs)[0];
      if (only === "MAIN") return "main";
      return slugs[1 + parseInt(only.slice(8), 10)];
    }
    return "shared";
  }
  const seq = new Map();
  function nextNum(key) {
    const n = (seq.get(key) || 0) + 1;
    seq.set(key, n);
    return n < 10 ? "0" + n : String(n);
  }
  // const int values: unique value -> k_<val>, else k_<val>_<off>
  const constValUse = new Map();
  offs.forEach(off => {
    if (info.get(off).cat !== "const") return;
    const r = G.get(off);
    if (typeOf(r) === "I" && r.setDisp.length) {
      const v = r.setDisp[0];
      const key = "I:" + v;
      if (!constValUse.has(key)) constValUse.set(key, []);
      constValUse.get(key).push(off);
    }
  });
  function floatStem(disp) {
    let s = disp.toLowerCase().replace(/^-/, "neg_").replace(/[^0-9a-z]+/g, "_")
      .replace(/^_+|_+$/g, "").slice(0, 12).replace(/_+$/g, "");
    return s || "f";
  }
  function opStem(opname) {
    let s = opname.toLowerCase().replace(/^(get|store)_/, "")
      .replace(/_in_range$/, "").replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    // truncate to 18 chars, but never mid-word: backtrack to the last '_'
    if (s.length > 18) {
      const cut = s.slice(0, 18);
      const us = cut.lastIndexOf("_");
      s = us >= 6 ? cut.slice(0, us) : cut;
    }
    return s || "op";
  }
  const ENT_SHORT = { CHAR: "char", CAR: "car", OBJECT: "object", PICKUP: "pickup",
    BLIP: "blip", PLAYER: "player", CAR_GENERATOR: "cargen" };

  const names = new Map();
  Object.keys(CURATED).map(Number).forEach(off => {
    if (!G.has(off)) throw new Error("curated offset not referenced: $" + off);
    names.set(off, claimUnique(CURATED[off]));
  });
  const tripleStem = new Map(); // base -> stem
  offs.forEach(off => {
    if (names.has(off)) return;
    const r = G.get(off), { cat, x } = info.get(off);
    const scope = scopeOf(off);
    let want;
    if (cat === "const" && typeOf(r) === "I" && r.setDisp.length) {
      const v = r.setDisp[0];
      want = (constValUse.get("I:" + v) || []).length === 1 ? "k_" + v : "k_" + v + "_" + off;
    } else if (cat === "const") {
      const disp = r.setDisp[0] || "?";
      want = "k_" + floatStem(disp);
      if (claimed.has(want.toUpperCase())) want += "_" + off;
    } else if (cat === "handle") {
      const ent = ENT_SHORT[x] || "h";
      want = ent + "_" + scope + "_" + nextNum("h|" + x + "|" + scope);
    } else if (cat === "timer") {
      want = "time_" + scope + "_" + nextNum("time|" + scope);
    } else if (cat === "coord" && tripleAt.has(off)) {
      const t = tripleAt.get(off);
      if (!tripleStem.has(t.base)) {
        tripleStem.set(t.base, "pos_" + scopeOf(t.base) + "_" + nextNum("pos|" + scopeOf(t.base)));
      }
      want = tripleStem.get(t.base) + "_" + t.axis;
    } else if (cat === "coord") {
      want = "coord_" + scope + "_" + nextNum("coord|" + scope);
    } else if (cat === "query") {
      want = opStem(x.slice(5)) + "_" + scope + "_" + nextNum("q|" + x + "|" + scope);
    } else if (cat === "copy") {
      want = "val_" + scope + "_" + nextNum("val|" + scope);
    } else if (cat === "conv") {
      want = "conv_" + scope + "_" + nextNum("conv|" + scope);
    } else if (cat === "flag") {
      want = "flag_" + scope + "_" + nextNum("flag|" + scope);
    } else if (cat === "state") {
      want = "state_" + scope + "_" + nextNum("state|" + scope);
    } else if (cat === "acc") {
      want = "acc_" + scope + "_" + nextNum("acc|" + scope);
    } else if (cat === "dead") {
      want = "dead_" + scope + "_" + nextNum("dead|" + scope);
    } else if (cat === "uninit") {
      want = "uninit_" + off;
    } else {
      want = "var_" + scope + "_" + nextNum("var|" + scope);
    }
    // sanitize just in case (negative const values etc.)
    want = want.replace(/-/g, "neg").replace(/[^A-Za-z0-9_]/g, "_");
    names.set(off, claimUnique(want));
  });

  const cats = {};
  offs.forEach(off => {
    const c = info.get(off).cat;
    cats[c] = (cats[c] || 0) + 1;
  });
  return {
    meta: {
      version: 1, source: "main.scm", fileSize: bytes.length, fnv: fnv1a(bytes),
      insns, globals: offs.length, triples: tripleBases.length,
      globalMin: offs[0], globalMax: offs[offs.length - 1], cats
    },
    offs,
    get: off => {
      const r = G.get(off), i = info.get(off);
      return { w: r.w, r: r.r, t: typeOf(r), cat: i.cat, name: names.get(off), x: i.x };
    },
    tripleBases
  };
}

function emit(sym) {
  const lines = [];
  lines.push("/* Global symbol table for the retail VC main.scm.");
  lines.push(" * GENERATED by tools/build_symbols.js -- do not edit by hand.");
  lines.push(" * " + sym.meta.globals + " globals, " + sym.meta.triples +
    " XYZ triples, " + sym.meta.insns + " instructions analysed.");
  lines.push(" * Entry: off -> [writes, reads, typeBit, category, autoName, extra]");
  lines.push(" * typeBit: 0 = int-only, 1 = float-only, 2 = mixed (unused today).");
  lines.push(" * Categories: const handle timer coord query copy conv flag state acc var dead uninit.");
  lines.push(" */");
  lines.push("var VC_SYM = (function () {");
  lines.push('"use strict";');
  lines.push("var META = " + JSON.stringify(sym.meta) + ";");
  lines.push("var G = {");
  sym.offs.forEach((off, i) => {
    const e = sym.get(off);
    const t = e.t === "I" ? 0 : (e.t === "F" ? 1 : 2);
    lines.push(JSON.stringify(String(off)) + ":" +
      JSON.stringify([e.w, e.r, t, e.cat, e.name, e.x]) +
      (i + 1 < sym.offs.length ? "," : ""));
  });
  lines.push("};");
  lines.push("var T = " + JSON.stringify(sym.tripleBases) + ";");
  lines.push("function entry(off) {");
  lines.push("  var e = G[off];");
  lines.push("  if (!e) return null;");
  lines.push('  return { w: e[0], r: e[1], t: e[2] === 0 ? "I" : (e[2] === 1 ? "F" : "M"),');
  lines.push("    cat: e[3], name: e[4], x: e[5] };");
  lines.push("}");
  lines.push("function nameOf(off) { var e = G[off]; return e ? e[4] : null; }");
  lines.push("function find(q, max) {");
  lines.push("  q = String(q).toLowerCase();");
  lines.push("  max = max || 50;");
  lines.push("  var out = [];");
  lines.push("  if (!q) return out;");
  lines.push("  for (var k in G) {");
  lines.push("    if (!Object.prototype.hasOwnProperty.call(G, k)) continue;");
  lines.push("    if (G[k][4].toLowerCase().indexOf(q) >= 0) {");
  lines.push('      out.push({ off: +k, name: G[k][4] });');
  lines.push("      if (out.length >= max) break;");
  lines.push("    }");
  lines.push("  }");
  lines.push("  return out;");
  lines.push("}");
  lines.push("return { META: META, G: G, T: T, entry: entry, nameOf: nameOf, find: find };");
  lines.push("})();");
  lines.push('if (typeof module !== "undefined" && module.exports) { module.exports = VC_SYM; }');
  lines.push("");
  return lines.join("\n");
}

function main() {
  const sym = build();
  const out = path.join(ROOT, "js", "symbols.js");
  fs.writeFileSync(out, emit(sym));
  const m = sym.meta;
  console.log("globals: " + m.globals + " | triples: " + m.triples +
    " | insns: " + m.insns + " | fnv: " + m.fnv);
  console.log("cats: " + JSON.stringify(m.cats));
  console.log("wrote " + out + " (" + fs.statSync(out).size + " bytes)");
}

if (require.main === module) main();
module.exports = { build, emit, CURATED };
