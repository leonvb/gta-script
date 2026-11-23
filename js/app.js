/* VC SCM Studio -- application wiring (browser only). */
(function () {
"use strict";

var $ = function (id) { return document.getElementById(id); };

var S = {
  fileName: "main.scm",
  bytes: null,
  header: null,
  stats: null,
  disWarnings: [],
  sections: [],
  dirty: {},
  asm: null,
  problems: [],
  cur: "main",
  editing: false,
  liveMarks: null,
  opDetail: null,
  hexBytes: null,
  hexRegions: [],
  sym: { on: true, overrides: {}, match: null, modalOff: null, fileHash: null, fileName: "" }
};

function toast(msg, ms) {
  var t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.classList.remove("on"); }, ms || 2600);
}

/* --------------------------- compat helpers --------------------------- */
// The app targets old mobile browsers too: ES5 only, no dataset/closest/fetch.

function showError(msg) {
  var b = $("errBanner");
  if (!b) { alert(msg); return; }
  b.textContent = msg + " (tap to dismiss)";
  b.classList.add("on");
}

function getData(el, key) {
  if (el.dataset) return el.dataset[key];
  return el.getAttribute("data-" + key);
}

// closest() replacement: tag name + optional required attribute
function closestEl(el, tag, attr) {
  tag = String(tag).toUpperCase();
  while (el && el.nodeType === 1) {
    if (el.tagName === tag && (attr === undefined || el.getAttribute(attr) !== null)) return el;
    el = el.parentNode;
  }
  return null;
}

// classList.toggle(name, force) ignores `force` on old browsers
function setActive(el, on) {
  if (on) el.classList.add("active");
  else el.classList.remove("active");
}

function fetchBytes(url, ok, bad) {
  if (typeof window !== "undefined" && window.fetch) {
    window.fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.arrayBuffer();
    }).then(ok, bad);
    return;
  }
  try {
    var x = new XMLHttpRequest();
    x.open("GET", url, true);
    try { x.responseType = "arraybuffer"; } catch (e) { /* old XHR: response may be text */ }
    x.onload = function () {
      if ((x.status === 200 || x.status === 0) && x.response) ok(x.response);
      else bad(new Error("HTTP " + x.status));
    };
    x.onerror = function () { bad(new Error("request failed")); };
    x.send();
  } catch (e) { bad(e); }
}

function encodeUtf8(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  var s = unescape(encodeURIComponent(str));
  var u8 = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 255;
  return u8;
}

// localStorage that never throws (private mode, old browsers, headless tests)
function lsGet(k) {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(k);
  } catch (e) { return null; }
}
function lsSet(k, v) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(k, v);
    return true;
  } catch (e) { return false; }
}

// FNV-1a, must match tools/build_symbols.js (staleness check for symbol names)
function fnv1a(u8) {
  var h = 0x811C9DC5;
  for (var i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

// surface unexpected failures instead of dying silently
if (typeof window !== "undefined") {
  window.onerror = function (msg) { showError("Error: " + msg); };
  if (window.addEventListener) {
    window.addEventListener("error", function (ev) {
      var t = ev && ev.target;
      if (t && t.tagName === "SCRIPT") {
        showError("Failed to load " + (t.src || "a script") + " -- check your connection and reload.");
      }
    }, true);
  }
}

function secById(id) {
  for (var i = 0; i < S.sections.length; i++) {
    if (S.sections[i].id === id) return S.sections[i];
  }
  return null;
}
function curSec() { return secById(S.cur) || S.sections[0]; }

// global line (in joined source) -> {sec, line}
function sectionStarts() {
  var starts = [], acc = 1;
  for (var i = 0; i < S.sections.length; i++) {
    starts.push({ id: S.sections[i].id, start: acc });
    acc += S.sections[i].lines.length + 1; // +1 for the joining \n
  }
  return starts;
}
function locateGlobalLine(g) {
  var starts = sectionStarts();
  var found = { sec: starts[0].id, line: 1 };
  for (var i = 0; i < starts.length; i++) {
    if (g >= starts[i].start) {
      found = { sec: starts[i].id, line: g - starts[i].start + 1 };
    }
  }
  var sec = secById(found.sec);
  if (sec) found.line = Math.min(found.line, sec.lines.length);
  return found;
}
function joinSource() {
  return S.sections.map(function (s) { return s.lines.join("\n"); }).join("\n");
}

var ed = null;

function refreshBadge() {
  var n = Object.keys(S.dirty).length;
  var sym = "";
  if (typeof VC_SYM !== "undefined" && VC_SYM && S.sym.match !== null) {
    sym = S.sym.match
      ? ' <span class="symok" title="Variable names match this exact file">names \u2713</span>'
      : ' <span class="symwarn" title="This file differs from the retail main.scm the names were built from -- most still apply, but treat them as approximate">names ~</span>';
  }
  $("fileBadge").innerHTML = escHtml(S.fileName) +
    (n ? ' <span class="dirty">\u25cf ' + n + " edited</span>" : "") +
    (S.bytes ? " (" + S.bytes.length + " bytes)" : "") + sym;
  var lines = 0;
  for (var i = 0; i < S.sections.length; i++) lines += S.sections[i].lines.length;
  $("fileMeta").textContent = S.sections.length ?
    (S.sections.length + " sections \u2022 " + lines + " lines") : "no file loaded";
}
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------------------------------- loading ------------------------------ */

function loadBytes(name, u8) {
  toast("Loading " + name + " ...");
  // let the UI paint before the heavy disassemble freezes it on slow devices
  setTimeout(function () {
    try { loadBytesNow(name, u8); }
    catch (e) { showError("Could not open " + name + ": " + ((e && e.message) || e)); }
  }, 30);
  return true;
}

function loadBytesNow(name, u8) {
  var hdr = SCM.parseHeader(u8);
  if (!hdr.ok) { toast("Not a valid SCM file: " + hdr.error, 4000); return false; }
  var dis = SCM.disassemble(u8);
  if (!dis.ok) { toast("Disassembly failed: " + dis.error, 4000); return false; }
  S.fileName = name;
  S.bytes = u8;
  S.header = dis.header;
  S.stats = dis.stats;
  S.disWarnings = dis.warnings;
  S.sections = dis.sections;
  S.dirty = {};
  S.asm = null;
  S.problems = dis.warnings.map(function (w) { return { kind: "warn", line: 0, msg: w }; });
  S.cur = "main";
  S.editing = false;
  S.liveMarks = null;
  MAIN_LABELS = null; NAMED_GLOBALS = null; MODEL_NAMES = null;
  $("btnEdit").textContent = "Edit";
  // symbol names were built for the retail main.scm: flag a different file
  S.sym.fileHash = fnv1a(u8);
  S.sym.fileName = name;
  if (SYM && SYM.META) {
    S.sym.match = (u8.length === SYM.META.fileSize && S.sym.fileHash === SYM.META.fnv);
  }
  rebuildSecNav();
  showSection("main", true);
  renderProblems();
  renderStructure();
  renderHex();
  refreshBadge();
  updateAsmState();
  return true;
}

function splitSource(text) {
  var lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
  var secs = [], cur = null;
  var re = /^\s*\/\/=+\s*SECTION\s*:\s*([A-Za-z]+)(?:\s+(\d+))?/;
  lines.forEach(function (ln) {
    var m = re.exec(ln);
    if (m) {
      var kind = m[1].toUpperCase(), id, title;
      if (kind === "HEADER") { id = "header"; title = "HEADER"; }
      else if (kind === "MAIN") { id = "main"; title = "MAIN"; }
      else if (kind === "MISSION" && m[2] !== undefined) {
        id = "mission:" + (+m[2]); title = "MISSION " + (+m[2]);
      } else { id = "extra:" + secs.length; title = kind; }
      cur = { id: id, kind: kind.toLowerCase(), title: title, lines: [ln] };
      secs.push(cur);
    } else if (cur) cur.lines.push(ln);
  });
  return secs;
}

function loadSourceFile(name, text) {
  var secs = splitSource(text);
  if (!secs.length) {
    toast("No SECTION markers found -- is this a VC SCM Studio source file?", 4000);
    return;
  }
  // fix mission indexes for kind
  secs.forEach(function (s) {
    if (s.id.indexOf("mission:") === 0) { s.kind = "mission"; s.index = +s.id.split(":")[1]; }
  });
  S.fileName = name.replace(/\.txt$/i, "") + " (source)";
  S.sections = secs;
  S.dirty = {};
  S.asm = null;
  S.problems = [];
  S.sym.match = null; // no binary to compare: names apply as-is
  S.sym.fileHash = null; // unknown bytes: exports carry no fingerprint
  S.liveMarks = null;
  MAIN_LABELS = null; NAMED_GLOBALS = null; MODEL_NAMES = null;
  S.cur = secs[0].id;
  S.editing = false;
  $("btnEdit").textContent = "Edit";
  rebuildSecNav();
  showSection(S.cur, true);
  renderProblems();
  refreshBadge();
  updateAsmState();
  toast("Loaded " + secs.length + " sections -- press Assemble to build.");
}

// File picking through persistent, DOM-attached inputs: programmatic clicks on
// detached inputs are ignored by iOS Safari and some WebViews.
function pickFile(inputId, accept, binary, cb) {
  var inp = $(inputId);
  if (!inp || typeof FileReader === "undefined") {
    showError("This browser cannot open local files. Try Chrome, Edge, Firefox or Safari.");
    return;
  }
  inp.accept = accept;
  inp.onchange = function () {
    if (!inp.files || !inp.files.length) { inp.value = ""; return; }
    var f = inp.files[0];
    var rd = new FileReader();
    rd.onload = function () { inp.value = ""; cb(f.name, rd.result); };
    rd.onerror = function () { inp.value = ""; toast("Could not read " + f.name + ".", 4000); };
    try {
      if (binary) rd.readAsArrayBuffer(f);
      else rd.readAsText(f);
    } catch (e) { inp.value = ""; toast("Could not read " + f.name + ".", 4000); }
  };
  inp.value = "";
  inp.click();
}

/* ------------------------- editor / navigation ------------------------ */

function rebuildSecNav() {
  var nav = $("secNav");
  var q = ($("secFilter").value || "").toLowerCase();
  var html = "";
  var shown = 0;
  S.sections.forEach(function (s) {
    if (q && s.title.toLowerCase().indexOf(q) < 0 && s.id.toLowerCase().indexOf(q) < 0) return;
    shown++;
    html += '<button class="secitem' + (s.id === S.cur ? " active" : "") + '" data-sec="' + s.id + '">' +
      '<span class="secname">' + escHtml(s.title) + "</span>" +
      '<span class="seclines">' + s.lines.length + "</span>" +
      (S.dirty[s.id] ? '<span class="secdot">\u25cf</span>' : "") + "</button>";
  });
  nav.innerHTML = html || '<div class="secempty">no sections match</div>';
  $("secCount").textContent = q ? (shown + " of " + S.sections.length + " sections")
    : (S.sections.length + " sections");
  markSecActive();
}
function markSecActive() {
  var items = $("secNav").querySelectorAll(".secitem");
  for (var i = 0; i < items.length; i++) {
    var on = getData(items[i], "sec") === S.cur;
    if (on) items[i].classList.add("active");
    else items[i].classList.remove("active");
    if (on && items[i].scrollIntoView) {
      try { items[i].scrollIntoView({ block: "nearest" }); } catch (e) { /* old browser */ }
    }
  }
}

function applyEdit() {
  if (!S.editing) return;
  var sec = curSec();
  if (!sec) return;
  var txt = ed.getText().split(/\r\n|\r|\n/);
  var before = sec.lines.join("\n");
  if (txt.join("\n") !== before) {
    sec.lines = txt;
    S.dirty[sec.id] = true;
  }
  ed.setLines(sec.lines);
}

function showSection(id, force) {
  if (!secById(id)) return;
  if (S.editing) applyEdit();
  S.cur = id;
  var sec = curSec();
  S.editing = false;
  $("btnEdit").textContent = "Edit";
  markSecActive();
  ed.setMode("view");
  ed.setLines(sec.lines);
  updateEdStatus();
  renderMarks();
  updateSigHint();
}

function updateEdStatus() {
  var sec = curSec();
  var live = "";
  if (sec && S.liveMarks && S.liveMarks.sec === sec.id) {
    var n = Object.keys(S.liveMarks.marks).length;
    if (n) live = " \u2022 " + n + " live issue" + (n > 1 ? "s" : "");
  }
  $("edStatus").textContent = sec ? (sec.title + " -- " + sec.lines.length + " lines -- " +
    (S.editing ? "EDITING (Esc: view, Ctrl+S: assemble)" : "view (double-click a line to edit)") + live) : "";
}

function gotoGlobalLine(g) {
  var loc = locateGlobalLine(g);
  showSection(loc.sec, true);
  setEditing(true);
  ed.gotoLine(loc.line, false);
}

function setEditing(on) {
  var sec = curSec();
  if (!sec) return;
  if (on && !S.editing) {
    S.editing = true;
    ed.setMode("edit");
    $("btnEdit").textContent = "Done";
  } else if (!on && S.editing) {
    applyEdit();
    S.editing = false;
    S.liveMarks = null; // live marks only exist while editing
    ed.setMode("view");
    $("btnEdit").textContent = "Edit";
    rebuildSecNav();
    refreshBadge();
  }
  updateEdStatus();
  renderMarks();
  updateSigHint();
}

function runSearch() {
  var q = $("searchInput").value;
  var box = $("searchResults");
  if (!q) { box.innerHTML = ""; box.style.display = "none"; return; }
  var res = Editor.searchAll(S.sections, q, 200);
  // name-aware: "player_char" also finds every "$12"
  if (SYM && q.charAt(0) !== "$" && res.length < 200) {
    var seen = {};
    res.forEach(function (r) { seen[r.sec + ":" + r.line] = 1; });
    var hits = SYM.find(q, 15);
    for (var h = 0; h < hits.length && res.length < 200; h++) {
      var more = Editor.searchAll(S.sections, "$" + hits[h].off, 200 - res.length);
      for (var i = 0; i < more.length && res.length < 200; i++) {
        var k = more[i].sec + ":" + more[i].line;
        if (!seen[k]) { seen[k] = 1; res.push(more[i]); }
      }
    }
  }
  if (!res.length) {
    box.innerHTML = '<div class="prob">no matches</div>';
    box.style.display = "block";
    return;
  }
  var html = "";
  res.forEach(function (r, i) {
    html += '<div class="prob" data-i="' + i + '"><span class="loc">' +
      escHtml(secTitle(r.sec)) + ":" + r.line + "</span> " + escHtml(r.text.slice(0, 120)) + "</div>";
  });
  box.innerHTML = html;
  box.style.display = "block";
  box._res = res;
  var rows = box.querySelectorAll(".prob[data-i]");
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener("click", function () {
      var r = box._res[+getData(this, "i")];
      box.style.display = "none";
      showSection(r.sec, true);
      ed.gotoLine(r.line, true);
    });
  }
}
function secTitle(id) {
  var s = secById(id);
  return s ? s.title : id;
}

/* ------------------------- editing aids --------------------------- */
// completion sources, signature hints, live checking, label jump, snippets

var OP_ALPHA = null;   // [{text, detail}] opcodes, alphabetical (static DB)
var MAIN_LABELS = null;  // main-section label names (upper), per loaded file
var NAMED_GLOBALS = null; // VAR_INT/VAR_FLOAT names from HEADER
var MODEL_NAMES = null;  // level models + database models, sorted

function opAlpha() {
  if (!OP_ALPHA) {
    OP_ALPHA = SCM.commandList().map(function (c) {
      return { text: c.name, detail: idh4(c.id) };
    }).sort(function (a, b) { return a.text < b.text ? -1 : a.text > b.text ? 1 : 0; });
  }
  return OP_ALPHA;
}
function sectionLabels(sec) {
  var out = [], seen = {};
  if (!sec) return out;
  for (var i = 0; i < sec.lines.length; i++) {
    var t = sec.lines[i].trim();
    if (t.charAt(0) !== ":") continue;
    var nm = t.slice(1).split(/[\s,]/)[0];
    if (nm && !seen[nm.toUpperCase()]) { seen[nm.toUpperCase()] = 1; out.push(nm); }
  }
  return out;
}
function labelsFromText(text) {
  return sectionLabels({ lines: String(text).split(/\r\n|\r|\n/) });
}
function mainLabelNames() {
  if (!MAIN_LABELS) {
    MAIN_LABELS = sectionLabels(secById("main")).map(function (n) { return n.toUpperCase(); });
  }
  return MAIN_LABELS;
}
// code part of one line (quote-aware // strip)
function stripLineComment(line) {
  var inStr = false;
  for (var i = 0; i < line.length - 1; i++) {
    var c = line.charAt(i);
    if (inStr) { if (c === "\\") i++; else if (c === "'") inStr = false; }
    else if (c === "'") inStr = true;
    else if (c === "/" && line.charAt(i + 1) === "/") return line.slice(0, i);
  }
  return line;
}
function namedGlobals() {
  if (!NAMED_GLOBALS) {
    NAMED_GLOBALS = [];
    var lines = null;
    if (S.cur === "header" && S.editing && ed) lines = ed.getText().split(/\r\n|\r|\n/);
    else if (secById("header")) lines = secById("header").lines;
    if (lines) {
      for (var i = 0; i < lines.length; i++) {
        var m = /^\s*VAR_(?:INT|FLOAT)\s+(.+)$/i.exec(stripLineComment(lines[i]));
        if (!m) continue;
        var parts = m[1].split(/[\s,]+/);
        for (var k = 0; k < parts.length; k++) {
          var nm = parts[k].replace(/^\$/, "");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) NAMED_GLOBALS.push(nm);
        }
      }
    }
  }
  return NAMED_GLOBALS;
}
function modelNames() {
  if (!MODEL_NAMES) {
    var seen = {}, out = [];
    if (S.header && S.header.models) {
      for (var i = 0; i < S.header.models.length; i++) {
        var m = S.header.models[i];
        if (m && !seen[m]) { seen[m] = 1; out.push(m); }
      }
    }
    if (typeof VC_DB !== "undefined" && VC_DB && VC_DB.models) {
      Object.keys(VC_DB.models).forEach(function (k) {
        if (!seen[k]) { seen[k] = 1; out.push(k); }
      });
    }
    out.sort();
    MODEL_NAMES = out;
  }
  return MODEL_NAMES;
}

var COMP_KEYWORDS = ["DEFINE", "OBJECTS", "OBJECT", "MISSIONS", "MISSION", "AT",
  "GLOBAL_SPACE", "VAR_INT", "VAR_FLOAT", "HEX", "END", "NOT", "TIMERA", "TIMERB"];

// completion source: (word, sigil, wordStart, fullText) -> [{text, detail}]
function completeWord(word, sigil, wordStart, fullText) {
  if (sigil === ":") return null; // defining a label: nothing to offer
  if (sigil === "$") {
    if (/^\d*$/.test(word)) {
      var items = [];
      if (SYM) {
        var offs = Object.keys(SYM.G).filter(function (k) { return k.indexOf(word) === 0; });
        offs.sort(function (a, b) { return a.length - b.length || (+a - +b); });
        for (var i = 0; i < offs.length && items.length < 12; i++) {
          var e = SYM.entry(+offs[i]);
          var nm = (S.sym.overrides[offs[i]] !== undefined) ? S.sym.overrides[offs[i]] : e.name;
          items.push({ text: offs[i], detail: nm + " " + (e.t === "F" ? "float" : "int") });
        }
      }
      return items;
    }
    var out = [], ups = namedGlobals();
    for (var n = 0; n < ups.length && out.length < 12; n++) {
      if (ups[n].toUpperCase().indexOf(word.toUpperCase()) === 0) {
        out.push({ text: ups[n], detail: "named global" });
      }
    }
    return out;
  }
  if (sigil === "@") {
    if (!word) return null;
    return Editor.matchList(labelsFromText(S.editing && ed ? ed.getText() : "").map(function (n) {
      return { text: n, detail: "label" };
    }), word, 12);
  }
  if (sigil === "#") {
    if (!word) return null;
    return Editor.matchList(modelNames().map(function (n) {
      return { text: n, detail: "model" };
    }), word, 12);
  }
  if (!word) return null;
  // opcode position (after NOT / XXXX:) offers opcodes only, else keywords too
  var before = String(fullText).slice(0, wordStart).split("\n").pop();
  var opOnly = /(^|\s)(NOT\s+)?[0-9A-Fa-f]{4}:\s*$/.test(before) || /(^|\s)NOT\s*$/i.test(before);
  var list = opAlpha();
  if (!opOnly) {
    list = list.concat(COMP_KEYWORDS.map(function (k) { return { text: k, detail: "keyword" }; }));
  }
  return Editor.matchList(list, word, 12);
}

function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  var d = [], i, j;
  for (i = 0; i <= a.length; i++) d[i] = [i];
  for (j = 0; j <= b.length; j++) d[0][j] = j;
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
function suggestOp(word) {
  var up = String(word).toUpperCase(), best = null, bd = 99;
  var names = opAlpha();
  for (var i = 0; i < names.length; i++) {
    var t = names[i].text;
    if (Math.abs(t.length - up.length) > 3) continue;
    var d = levenshtein(up, t);
    if (d < bd) { bd = d; best = t; }
  }
  return bd <= 3 ? best : null;
}
var SIG_DIRS = { DEFINE: 1, OBJECTS: 1, OBJECT: 1, MISSIONS: 1, MISSION: 1, AT: 1,
  GLOBAL_SPACE: 1, VAR_INT: 1, VAR_FLOAT: 1, HEX: 1, END: 1 };
function sigForLine(line) {
  if (typeof VC_DB === "undefined" || !VC_DB) return null;
  var toks = stripLineComment(line).split(/[\s,]+/).filter(function (t) { return t; });
  var i = 0;
  if (toks[i] && toks[i].charAt(0) === ":") i++; // :label + opcode on one line
  if (toks[i] && toks[i].toUpperCase() === "NOT") i++;
  var prefix = null;
  if (toks[i] && /^[0-9A-Fa-f]{4}:$/.test(toks[i])) { prefix = toks[i]; i++; }
  var cand = toks[i];
  if (cand && /^[A-Za-z_][A-Za-z0-9_]*$/.test(cand) && !SIG_DIRS[cand.toUpperCase()]) {
    var id = VC_DB.byName[cand.toUpperCase()];
    if (id !== undefined) return { id: id };
    return { unknown: cand };
  }
  if (!cand && prefix) { // bare "00D6:" so far: describe the prefixed opcode
    var pid = parseInt(prefix.slice(0, 4), 16) & 0x7FFF;
    if (SCM.describeCommand(pid)) return { id: pid };
  }
  return null;
}
function sigText(d) {
  var parts = d.args.map(function (a) {
    var s = (a.desc || typeWord(a.type)) + ":" + typeWord(a.type);
    if (a.flags & 2) s += "*";
    return s;
  });
  return idh4(d.id) + " " + d.name + (parts.length ? "  " + parts.join("  ") : "");
}
function updateSigHint() {
  var el = $("sigHint");
  if (!el) return;
  var txt = "", title = "";
  if (S.editing && ed) {
    var s = sigForLine(ed.caretInfo().text);
    if (s) {
      if (s.unknown) {
        var sug = suggestOp(s.unknown);
        txt = "unknown opcode '" + s.unknown + "'" + (sug ? " -- did you mean " + sug + "?" : "");
      } else {
        var d = SCM.describeCommand(s.id);
        if (d) {
          txt = sigText(d);
          title = d.args.map(function (a, i) {
            return (i + 1) + ". " + typeWord(a.type) + (a.flags & 2 ? " (out)" : "") +
              (a.desc ? " -- " + a.desc : "");
          }).join("\n");
        }
      }
    }
  }
  el.textContent = txt;
  el.title = title;
}

var liveT = null;
function onCodeEdit() {
  scheduleLiveCheck();
  updateSigHint();
}
function scheduleLiveCheck() {
  if (!S.editing) return;
  clearTimeout(liveT);
  liveT = setTimeout(runLiveCheck, 700);
}
function runLiveCheck() {
  if (!S.editing || !ed) return;
  var sec = curSec();
  if (!sec) return;
  var res;
  try {
    res = SCM.checkSection(ed.getText().split(/\r\n|\r|\n/),
      sec.id.indexOf("mission:") === 0 ? mainLabelNames() : null);
  } catch (e) { return; }
  var marks = {};
  res.errors.forEach(function (e) { marks[e.line] = { kind: "err", msg: e.msg }; });
  res.warnings.forEach(function (w) {
    if (!marks[w.line]) marks[w.line] = { kind: "warn", msg: w.msg };
  });
  S.liveMarks = { sec: sec.id, marks: marks };
  renderMarks();
  updateEdStatus();
}
// merged gutter marks for the current section: assemble problems win,
// live-check findings fill the gaps
function marksForCur() {
  var marks = {};
  for (var i = 0; i < S.problems.length; i++) {
    var p = S.problems[i];
    if (!p.line) continue;
    var l = locateGlobalLine(p.line);
    if (l.sec !== S.cur) continue;
    marks[l.line] = { kind: p.kind === "err" ? "err" : "warn", msg: p.msg };
  }
  if (S.liveMarks && S.liveMarks.sec === S.cur) {
    Object.keys(S.liveMarks.marks).forEach(function (k) {
      if (!marks[k]) marks[k] = S.liveMarks.marks[k];
    });
  }
  return marks;
}
function renderMarks() {
  if (ed) ed.setLineMarks(marksForCur());
}

function jumpToLabel(name) {
  var sec = curSec();
  if (!sec) return;
  var up = String(name).toUpperCase();
  for (var i = 0; i < sec.lines.length; i++) {
    var t = sec.lines[i].trim();
    if (t.charAt(0) !== ":") continue;
    if (t.slice(1).split(/[\s,]/)[0].toUpperCase() === up) {
      ed.gotoLine(i + 1, true);
      return;
    }
  }
  toast("@" + name + " is not defined in " + sec.title + ".");
}

var SNIPPETS = [
  { name: "IF / ELSE branch", desc: "ANDOR condition with two paths", text:
    "00D6: ANDOR 0\n00E1: IS_BUTTON_PRESSED 0 16 // your condition here\n" +
    "004D: GOTO_IF_FALSE @MY_ELSE\n// ... then ...\n0002: GOTO @MY_ENDIF\n" +
    ":MY_ELSE\n// ... else ...\n:MY_ENDIF" },
  { name: "Wait loop", desc: "poll every frame until a condition holds", text:
    ":MY_WAIT\n00D6: ANDOR 0\nNOT 00E1: IS_BUTTON_PRESSED 0 16 // repeat until pressed\n" +
    "004D: GOTO_IF_FALSE @MY_WAIT_DONE\n0001: WAIT 0\n0002: GOTO @MY_WAIT\n:MY_WAIT_DONE" },
  { name: "GOSUB subroutine", desc: "call a shared block and return", text:
    "0050: GOSUB @MY_SUB\n// ... execution continues here after RETURN ...\n" +
    ":MY_SUB\n// ... subroutine body ...\n0051: RETURN" },
  { name: "Mission thread start", desc: ":label + SCRIPT_NAME (+ HEADER reminder)", text:
    "// new mission: also add \"DEFINE MISSION <n> AT @MY_MISSION\" in HEADER\n" +
    ":MY_MISSION\n03A4: SCRIPT_NAME 'MYMISS'\n0001: WAIT 0" },
  { name: "Named global", desc: "VAR_INT for HEADER, usable as $name", text:
    "VAR_INT $my_counter // put this in HEADER; then use $my_counter anywhere" }
];
function renderSnipMenu() {
  var box = $("snipMenu");
  var html = "";
  SNIPPETS.forEach(function (sn, i) {
    html += '<button data-sn="' + i + '"><b>' + escHtml(sn.name) + "</b><small>" +
      escHtml(sn.desc) + "</small></button>";
  });
  box.innerHTML = html;
  var rows = box.querySelectorAll("button[data-sn]");
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener("click", function () {
      insertSnippet(SNIPPETS[+getData(this, "sn")].text);
      box.style.display = "none";
    });
  }
}
// insert text at the caret, keeping the current line intact
function insertAtCaret(text) {
  var ta = $("editArea");
  var v = String(ta.value);
  var a = (ta.selectionStart === null || ta.selectionStart === undefined) ? v.length : ta.selectionStart;
  var b = (ta.selectionEnd === null || ta.selectionEnd === undefined) ? a : ta.selectionEnd;
  var ins = text, pos = a, tail = "";
  if (a !== b) {
    pos = a; // replace the selection
  } else {
    var ls = v.lastIndexOf("\n", a - 1) + 1, le = v.indexOf("\n", a);
    if (le < 0) le = v.length;
    if (v.slice(ls, le).trim() && a !== ls) { pos = le; ins = "\n" + text; } // fresh line below
    else if (a === ls && a !== le) { tail = "\n"; } // push the line down
  }
  ta.value = v.slice(0, pos) + ins + tail + v.slice(b);
  var p = pos + ins.length + tail.length;
  try { ta.setSelectionRange(p, p); } catch (e) { /* old browser */ }
  try { ta.selectionStart = p; ta.selectionEnd = p; } catch (e) { /* ignore */ }
  if (ta.focus) { try { ta.focus(); } catch (e) { /* ignore */ } }
}
function insertSnippet(text) {
  var sec = curSec();
  if (!sec) { toast("Open a section first."); return; }
  if (S.editing) {
    insertAtCaret(text);
    S.dirty[sec.id] = true;
    if (ed) ed.hideComplete();
    onCodeEdit();
  } else {
    sec.lines = sec.lines.concat(text.split("\n"));
    S.dirty[sec.id] = true;
    ed.setLines(sec.lines);
  }
  rebuildSecNav();
  refreshBadge();
  toast("Snippet inserted into " + sec.title + ".");
}

/* --------------------------- symbol names --------------------------- */

var SYM = (typeof VC_SYM !== "undefined" && VC_SYM) ? VC_SYM : null;
var SYM_PREF_KEY = "vcscm.sym.v1";
var SYM_RESERVED = { DEFINE: 1, OBJECTS: 1, OBJECT: 1, MISSIONS: 1, MISSION: 1,
  AT: 1, GLOBAL_SPACE: 1, VAR_INT: 1, VAR_FLOAT: 1, HEX: 1, END: 1, NOT: 1,
  TIMERA: 1, TIMERB: 1 };

function loadSymPrefs() {
  var prefs = { on: true, overrides: {} };
  var raw = lsGet(SYM_PREF_KEY);
  if (raw) {
    try {
      var p = JSON.parse(raw);
      if (p && typeof p.on === "boolean") prefs.on = p.on;
      if (p && p.names && typeof p.names === "object") {
        Object.keys(p.names).forEach(function (k) {
          var off = +k;
          var nm = p.names[k];
          if (SYM && SYM.entry(off) && isSymNameShape(nm)) prefs.overrides[off] = nm;
        });
      }
    } catch (e) { /* corrupt prefs: start clean */ }
  }
  S.sym.on = prefs.on;
  S.sym.overrides = prefs.overrides;
  Editor.setSymNames(S.sym.on);
  Editor.setSymOverrides(S.sym.overrides);
  updateSymBtn();
}
function saveSymPrefs() {
  lsSet(SYM_PREF_KEY, JSON.stringify({ on: S.sym.on, names: S.sym.overrides }));
}
function symCustomCount() { return Object.keys(S.sym.overrides).length; }
function updateSymBtn() {
  $("btnSym").textContent = S.sym.on ? "Names: on" : "Names: off";
  var n = symCustomCount();
  $("btnNamesExport").textContent = n ? "Export names (" + n + ")" : "Export names";
}
function toggleSymNames() {
  S.sym.on = !S.sym.on;
  saveSymPrefs();
  Editor.setSymNames(S.sym.on);
  updateSymBtn();
  if (ed) ed.render();
}

function isSymNameShape(nm) {
  return typeof nm === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nm) && nm.length <= 40;
}
// error string, or "" when the name is usable for this offset
function validateSymName(nm, off) {
  if (!isSymNameShape(nm)) {
    return "Use letters, digits and _ only, max 40 chars, must not start with a digit.";
  }
  var up = nm.toUpperCase();
  if (SYM_RESERVED[up]) return "'" + nm + "' is a reserved word.";
  if (typeof VC_DB !== "undefined" && VC_DB && VC_DB.byName[up] !== undefined) {
    return "'" + nm + "' is an opcode name.";
  }
  var clash = null;
  Object.keys(SYM.G).forEach(function (k) {
    if (+k === off || clash) return;
    var other = (S.sym.overrides[k] !== undefined) ? S.sym.overrides[k] : SYM.G[k][4];
    if (String(other).toUpperCase() === up) clash = k;
  });
  if (clash !== null) return "'" + nm + "' is already used by $" + clash + ".";
  return "";
}

function symCatWord(cat) {
  return { const: "constant", handle: "entity handle", timer: "timer snapshot",
    coord: "coordinate", query: "query result", copy: "variable copy",
    conv: "conversion", flag: "boolean flag", state: "state value",
    acc: "accumulator", var: "variable", dead: "dead store",
    uninit: "never written" }[cat] || cat;
}

function openSymModal(off) {
  if (!SYM) return;
  var e = SYM.entry(off);
  if (!e) return;
  S.sym.modalOff = off;
  var auto = e.name;
  var cur = (S.sym.overrides[off] !== undefined) ? S.sym.overrides[off] : auto;
  $("symTitle").textContent = "Rename $" + off;
  $("symInfo").textContent = "$" + off + " \u00b7 " + (e.t === "F" ? "float" : "int") +
    " " + symCatWord(e.cat) + " \u00b7 " + e.w + " write(s), " + e.r + " read(s)" +
    (e.x ? " \u00b7 " + e.x : "") + " \u00b7 auto: " + auto;
  $("symName").value = cur;
  $("symErr").textContent = "";
  $("symModal").style.display = "flex";
  var inp = $("symName");
  if (inp.focus) inp.focus();
  if (inp.select) inp.select();
}
function closeSymModal() {
  S.sym.modalOff = null;
  $("symModal").style.display = "none";
}
function saveSymModal() {
  var off = S.sym.modalOff;
  if (off === null || !SYM) { closeSymModal(); return; }
  var e = SYM.entry(off);
  if (!e) { closeSymModal(); return; }
  var nm = $("symName").value;
  var err = validateSymName(nm, off);
  if (err) { $("symErr").textContent = err; return; }
  if (nm === e.name) delete S.sym.overrides[off];
  else S.sym.overrides[off] = nm;
  saveSymPrefs();
  Editor.setSymOverrides(S.sym.overrides);
  closeSymModal();
  updateSymBtn();
  if (ed) ed.render();
  toast("$" + off + " is now '" + nm + "'.");
}
function resetSymModal() {
  var off = S.sym.modalOff;
  if (off !== null && S.sym.overrides[off] !== undefined) {
    delete S.sym.overrides[off];
    saveSymPrefs();
    Editor.setSymOverrides(S.sym.overrides);
    if (ed) ed.render();
    toast("$" + off + " is back to its automatic name.");
  }
  updateSymBtn();
  closeSymModal();
}
function exportSymNames() {
  var keys = Object.keys(S.sym.overrides);
  if (!keys.length) {
    toast("No custom names to export yet -- click any variable name to rename it first.");
    return;
  }
  var payload = { version: 1, app: "vcscm-names", names: S.sym.overrides,
    forFile: { name: S.sym.fileName || S.fileName,
      size: S.bytes ? S.bytes.length : 0, fnv: S.sym.fileHash } };
  var u8 = encodeUtf8(JSON.stringify(payload, null, 1));
  download("vcscm_names.json", u8);
  toast("Exported " + keys.length + " custom name(s) -- import this file on another browser or computer.");
}
function importSymNames(name, text) {
  var obj;
  try { obj = JSON.parse(text); }
  catch (e) { toast("Not a valid names file.", 4000); return; }
  var names = (obj && obj.names) || obj;
  if (!names || typeof names !== "object") { toast("Not a valid names file.", 4000); return; }
  var okN = 0, badN = 0;
  Object.keys(names).forEach(function (k) {
    var off = +k, nm = names[k];
    if (!SYM || !SYM.entry(off) || validateSymName(nm, off)) { badN++; return; }
    if (nm === SYM.entry(off).name) delete S.sym.overrides[off];
    else S.sym.overrides[off] = nm;
    okN++;
  });
  saveSymPrefs();
  Editor.setSymOverrides(S.sym.overrides);
  updateSymBtn();
  if (ed) ed.render();
  var note = "";
  if (obj.forFile && obj.forFile.fnv && S.sym.fileHash &&
      obj.forFile.fnv !== S.sym.fileHash) {
    note = " (made for a different file: " + (obj.forFile.name || "unknown") + ")";
  }
  toast("Imported " + okN + " name(s)" + (badN ? ", skipped " + badN : "") + note + ".");
}

/* ------------------------------ assembly ------------------------------ */

function updateAsmState() {
  var el = $("asmState");
  var errs = S.problems.filter(function (p) { return p.kind === "err"; }).length;
  var warns = S.problems.filter(function (p) { return p.kind === "warn"; }).length;
  var cnt = $("cntProblems");
  if (errs) {
    el.innerHTML = '<span class="bad">\u2717 ' + errs + " error(s)</span>";
    cnt.textContent = errs;
    cnt.className = "cnt err";
  } else if (S.asm) {
    el.innerHTML = '<span class="ok">\u2713 assembled (' + S.asm.bytes.length + " bytes)</span>";
    cnt.textContent = warns || "";
    cnt.className = "cnt";
  } else {
    el.innerHTML = '<span class="warn">not assembled</span>';
    cnt.textContent = warns || "";
    cnt.className = "cnt";
  }
  var errs2 = S.problems.filter(function (p) { return p.kind === "err"; }).length;
  $("btnDlScm").disabled = !(S.asm && !errs2);
}

function doAssemble() {
  if (!S.sections.length) { toast("Nothing to assemble -- open a file first."); return false; }
  if (S.editing) applyEdit();
  rebuildSecNav();
  var t0 = Date.now();
  var res;
  try {
    res = SCM.assemble(joinSource());
  } catch (e) {
    S.problems = [{ kind: "err", line: 0, msg: "internal error: " + (e && e.message || e) }];
    S.asm = null;
    renderProblems();
    updateAsmState();
    refreshBadge();
    return false;
  }
  var ms = Math.round(Date.now() - t0);
  S.problems = [];
  res.errors.forEach(function (e) { S.problems.push({ kind: "err", line: e.line, msg: e.msg }); });
  res.warnings.forEach(function (w) { S.problems.push({ kind: "warn", line: w.line, msg: w.msg }); });
  if (res.ok) {
    S.asm = { bytes: res.bytes, stats: res.stats, warnings: res.warnings };
    S.bytes = res.bytes;
    renderStructure();
    renderHex();
    toast("Assembled OK in " + ms + "ms -- " + res.bytes.length + " bytes.");
  } else {
    S.asm = null;
    toast("Assembly failed -- " + res.errors.length + " error(s). Click one to jump.", 3500);
    switchTab("editor");
  }
  renderProblems();
  updateAsmState();
  refreshBadge();
  return res.ok;
}

function renderProblems() {
  var box = $("problems");
  if (!S.problems.length) { box.innerHTML = ""; box.classList.remove("on"); return; }
  var html = "";
  S.problems.forEach(function (p, i) {
    var loc = "";
    if (p.line) {
      var l = locateGlobalLine(p.line);
      loc = '<span class="loc">' + escHtml(secTitle(l.sec)) + ":" + l.line + "</span> ";
    }
    html += '<div class="prob ' + p.kind + '" data-i="' + i + '">' + loc + escHtml(p.msg) + "</div>";
  });
  box.innerHTML = html;
  box.classList.add("on");
  var rows = box.querySelectorAll(".prob");
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener("click", function () {
      var p = S.problems[+getData(this, "i")];
      if (!p.line) return;
      switchTab("editor");
      gotoGlobalLine(p.line);
    });
  }
  renderMarks();
}

function download(name, u8) {
  var U = (typeof window !== "undefined" && (window.URL || window.webkitURL)) || null;
  if (typeof Blob === "undefined" || !U || !U.createObjectURL) {
    toast("Download is not supported by this browser.", 4000);
    return;
  }
  var blob = new Blob([u8], { type: "application/octet-stream" });
  var a = document.createElement("a");
  a.href = U.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { U.revokeObjectURL(a.href); } catch (e) { /* ignore */ }
    if (a.remove) a.remove();
    else if (a.parentNode) a.parentNode.removeChild(a);
  }, 500);
}

/* ------------------------------ structure ----------------------------- */

function bar(used, limit) {
  var pct = Math.min(100, (100 * used) / limit);
  var cls = used > limit ? "over" : (used > 0.92 * limit ? "hot" : "");
  return '<div class="bar"><div class="' + cls + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
}
function kb(n) { return n + " B"; }

function renderStructure() {
  var root = $("structRoot");
  if (!S.header && !S.asm) {
    root.innerHTML = '<div class="card">Open a main.scm file to inspect its structure.</div>';
    return;
  }
  var h = S.header, st = S.stats, A = S.asm ? S.asm.stats : null;
  var html = '<div class="cards">';
  // file card
  html += '<div class="card"><h3>File</h3><div class="big">' + escHtml(S.fileName) + "</div>";
  html += "<table>";
  if (h) {
    html += "<tr><td>size</td><td>" + kb(h.fileSize) + "</td></tr>";
    html += "<tr><td>platform byte</td><td>0x" + h.targetId.toString(16) +
      (h.targetId === 0x6D ? " ('m' = Vice City)" : " (UNEXPECTED)") + "</td></tr>";
    html += "<tr><td>global space</td><td>" + h.sizeGlobals + " B</td></tr>";
    html += "<tr><td>code starts at</td><td>" + h.codeOffset + "</td></tr>";
  }
  if (A) {
    html += "<tr><td>assembled size</td><td>" + kb(A.fileSize) + "</td></tr>";
    html += "<tr><td>assembled globals</td><td>" + A.sizeGlobals + " B</td></tr>";
  }
  html += "</table></div>";
  // budgets card
  var mainSize = A ? A.mainSize : (h ? h.mainSize : 0);
  var largest = A ? A.largestMission : (h ? h.largestMission : 0);
  var nMis = A ? A.numMissions : (h ? h.numMissions : 0);
  var nObj = A ? A.objectCount : (h ? h.objectCount : 0);
  html += '<div class="card"><h3>Engine budgets</h3><table>';
  html += "<tr><td>main block</td><td>" + mainSize + " / " + SCM.LIMITS.mainSizePC + " (PC)</td></tr>";
  html += "</table>" + bar(mainSize, SCM.LIMITS.mainSizePC);
  html += "<table><tr><td>largest mission</td><td>" + largest + " / " + SCM.LIMITS.missionSize + "</td></tr></table>";
  html += bar(largest, SCM.LIMITS.missionSize);
  html += "<table><tr><td>missions</td><td>" + nMis + " / " + SCM.LIMITS.maxMissions + "</td></tr></table>";
  html += bar(nMis, SCM.LIMITS.maxMissions);
  html += "<table><tr><td>objects</td><td>" + nObj + " / " + SCM.LIMITS.maxObjects + "</td></tr></table>";
  html += bar(nObj, SCM.LIMITS.maxObjects);
  html += "</div>";
  // globals card
  if (st) {
    html += '<div class="card"><h3>Global variables</h3><div class="big">' +
      st.globals.uniq + " used</div><table>";
    html += "<tr><td>references</td><td>" + st.globals.refs + "</td></tr>";
    html += "<tr><td>offset range</td><td>$" + st.globals.min + " .. $" + st.globals.max + "</td></tr>";
    html += "<tr><td>instructions</td><td>" + st.totalInsns + " (" + st.mainInsns + " in main)</td></tr>";
    html += "<tr><td>NOT-flagged</td><td>" + st.notCount + "</td></tr>";
    html += "</table></div>";
  }
  html += "</div>";
  // missions table
  if (st && st.missions.length) {
    html += '<div class="card" style="margin-top:12px"><h3>Missions (' + st.missions.length +
      ") -- click to open</h3>";
    html += '<div style="max-height:320px;overflow:auto"><table class="grid"><tr><th>#</th><th>entry</th>' +
      "<th>offset</th><th>size</th><th>insns</th></tr>";
    st.missions.forEach(function (m) {
      html += '<tr data-mis="' + m.index + '"><td>' + m.index + "</td><td>@" + escHtml(m.name) +
        "</td><td>" + m.offset + "</td><td>" + m.size + "</td><td>" + m.insns + "</td></tr>";
    });
    html += "</table></div></div>";
  } else if (A) {
    html += '<div class="card" style="margin-top:12px"><h3>Missions</h3><div>' + A.numMissions +
      " mission(s) in assembled output.</div></div>";
  }
  // objects list
  if (h && h.models.length) {
    html += '<div class="card" style="margin-top:12px"><h3>Level models (' + h.models.length + ")</h3>";
    html += '<details><summary style="cursor:pointer;color:var(--dim)">show list</summary>';
    html += '<div style="max-height:260px;overflow:auto;margin-top:8px"><table class="grid">';
    h.models.forEach(function (m, i) {
      var disp = m === "" ? "<i>(empty)</i>" : escHtml(m);
      html += '<tr data-model="' + escHtml(m) + '"><td>-' + (i + 1) + "</td><td>#" + disp + "</td></tr>";
    });
    html += "</table></div></details></div>";
  }
  root.innerHTML = html;
  var rows = root.querySelectorAll("tr[data-mis]");
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener("click", function () {
      switchTab("editor");
      showSection("mission:" + getData(this, "mis"), true);
    });
  }
  applyMisFilter();
}

function applyMisFilter() {
  var q = ($("misFilter").value || "").toLowerCase();
  var root = $("structRoot");
  var sels = ["tr[data-mis]", "tr[data-model]"];
  for (var s = 0; s < sels.length; s++) {
    var rows = root.querySelectorAll(sels[s]);
    for (var i = 0; i < rows.length; i++) {
      var t = (rows[i].textContent || "").toLowerCase();
      rows[i].style.display = (!q || t.indexOf(q) >= 0) ? "" : "none";
    }
  }
}

/* ------------------------------- opcodes ------------------------------ */

var OP_LIST = [];
function typeWord(t) {
  return { I: "int", F: "float", T: "'text'", L: "@label", C: "const", P: "param" }[t] || t;
}
function buildOpList() {
  OP_LIST = SCM.commandList();
  renderOpList("");
}
function renderOpList(filter) {
  var box = $("opList");
  var q = String(filter || "").toUpperCase().replace(/^0X/, "");
  var isHex = /^[0-9A-F]+$/.test(q) && q.length <= 4 && /\d/.test(q);
  var shown = 0, html = "";
  for (var i = 0; i < OP_LIST.length && shown < 400; i++) {
    var c = OP_LIST[i];
    var idh = ("000" + c.id.toString(16).toUpperCase()).slice(-4);
    var hit = !q || c.name.indexOf(q) >= 0 || (isHex && idh.indexOf(q) >= 0);
    if (!hit) continue;
    shown++;
    html += '<div class="oprow" data-id="' + c.id + '"><span class="oid">' + idh +
      '</span><span class="onm">' + escHtml(c.name) + "</span>" +
      '<span class="osig">' + escHtml(opSignature(c.id)) + "</span>" +
      (c.unsupported ? '<span class="badge">unimpl?</span>' : "") + "</div>";
  }
  if (!shown) html = '<div class="oprow">no matches</div>';
  else if (shown === 400) html += '<div class="oprow">... refine the search ...</div>';
  box.innerHTML = html;
  var rows = box.querySelectorAll(".oprow[data-id]");
  for (var r = 0; r < rows.length; r++) {
    rows[r].addEventListener("click", function () { showOpDetail(+getData(this, "id")); });
  }
}
function opSignature(id) {
  var d = SCM.describeCommand(id);
  if (!d) return "";
  return d.args.map(function (a) {
    var s = typeWord(a.type);
    if (a.flags & 1) s = "[" + s + " ...]";
    if (a.flags & 2) s += " (out)";
    return s;
  }).join("  ");
}
function showOpDetail(id) {
  var d = SCM.describeCommand(id);
  if (!d) return;
  S.opDetail = d;
  var idh = ("000" + d.id.toString(16).toUpperCase()).slice(-4);
  var html = "<b>" + idh + ": " + escHtml(d.name) + "</b> ";
  html += "<code>" + escHtml(opSignature(id) || "(no arguments)") + "</code>";
  if (d.unsupported) {
    html += '<div style="color:var(--yellow);margin-top:6px">Marked unsupported in the ' +
      "database: the retail engine probably ignores this opcode. It still assembles.</div>";
  }
  if (d.args.length) {
    html += '<table class="grid" style="margin-top:8px"><tr><th>#</th><th>type</th>' +
      "<th>description</th><th>enum/entity</th><th>flags</th></tr>";
    d.args.forEach(function (a, i) {
      var fl = [];
      if (a.flags & 1) fl.push("optional/variadic");
      if (a.flags & 2) fl.push("must be a variable");
      if (a.flags & 4) fl.push("no literals");
      if (a.flags & 8) fl.push("no $global");
      if (a.flags & 16) fl.push("no local");
      var ee = a.enm && a.enm !== "MODEL" && a.enm !== "DEFAULTMODEL" ? a.enm : "";
      if (a.enm === "MODEL" || a.enm === "DEFAULTMODEL") ee = "model (#NAME ok)";
      if (a.entity) ee += (ee ? ", " : "") + "entity:" + a.entity;
      html += "<tr><td>" + (i + 1) + "</td><td>" + typeWord(a.type) + "</td><td>" +
        escHtml(a.desc || "--") + "</td><td>" + escHtml(ee || "--") + "</td><td>" +
        escHtml(fl.join(", ") || "--") + "</td></tr>";
    });
    html += "</table>";
  }
  html += '<div style="margin-top:10px"><button class="small" id="btnOpInsert">Insert into ' +
    escHtml(secTitle(S.cur)) + "</button></div>";
  $("opDetail").innerHTML = html;
  $("opDetail").style.display = "block";
  $("btnOpInsert").addEventListener("click", insertOpTemplate);
}
function insertOpTemplate() {
  var d = S.opDetail;
  if (!d) return;
  var sec = curSec();
  if (!sec) { toast("Open a section first."); return; }
  var parts = [idh4(d.id) + ": " + d.name];
  d.args.forEach(function (a) {
    if (a.flags & 1) return; // skip optional in template
    parts.push(a.type === "F" ? "0.0" : a.type === "T" ? "'TEXT'" :
      a.type === "L" ? "@LABEL" : (a.flags & 2) ? "$8" : "0");
  });
  var line = parts.join(" ");
  if (S.editing) {
    var ta = $("editArea");
    if (ta.setRangeText) ta.setRangeText(line, ta.selectionStart, ta.selectionEnd, "end");
    else ta.value = ta.value + "\n" + line;
    if (ta.focus) ta.focus();
    S.dirty[sec.id] = true;
  } else {
    if (S.editing) applyEdit();
    sec.lines.push(line);
    S.dirty[sec.id] = true;
    ed.setLines(sec.lines);
  }
  rebuildSecNav();
  refreshBadge();
  switchTab("editor");
  toast("Inserted " + d.name + " at the end of " + sec.title + ".");
}
function idh4(id) { return ("000" + id.toString(16).toUpperCase()).slice(-4); }

/* --------------------------------- hex -------------------------------- */

function renderHex() {
  S.hexBytes = S.asm ? S.asm.bytes : S.bytes;
  S.hexRegions = [];
  if (!S.hexBytes) {
    $("hexDump").innerHTML = '<div class="card">Hex dump appears after you open or assemble a file.</div>';
    return;
  }
  var u8 = S.hexBytes, h = null;
  try { h = SCM.parseHeader(u8); } catch (e) { h = null; }
  if (h && h.ok) {
    var mt = h.segModels + 20; // mission offset table lives 20 bytes into seg3
    var segs = [
      ["header (chain + globals + models + table)", 0, h.codeOffset],
      ["mission table", mt, mt + 4 * h.numMissions],
      ["main script", h.codeOffset, h.mainSize],
      ["mission code", h.mainSize, u8.length]
    ];
    segs.forEach(function (sg) { S.hexRegions.push({ name: sg[0], from: sg[1], to: sg[2] }); });
  }
  var sel = $("hexRegion");
  sel.innerHTML = "";
  S.hexRegions.forEach(function (r, i) {
    var o = document.createElement("option");
    o.value = i;
    o.textContent = r.name + " (" + r.from + ".." + (r.to - 1) + ")";
    sel.appendChild(o);
  });
  // find region holding first code bytes by default
  var def = 0;
  for (var i = 0; i < S.hexRegions.length; i++) {
    if (S.hexRegions[i].name === "main script") def = i;
  }
  sel.value = def;
  renderHexPage();
}
function renderHexPage() {
  var u8 = S.hexBytes;
  if (!u8) return;
  var r = S.hexRegions[+$("hexRegion").value] || { name: "file", from: 0, to: u8.length };
  var pages = Math.max(1, Math.ceil((r.to - r.from) / 4096));
  var pg = Math.min(pages - 1, Math.max(0, +$("hexPage").value || 0));
  $("hexPageInfo").textContent = "page " + (pg + 1) + " / " + pages;
  $("hexLbl").innerHTML = "bytes <b>" + (r.from + pg * 4096) + "</b> .. <b>" +
    Math.min(r.to - 1, r.from + pg * 4096 + 4095) + "</b>" + (S.asm ? " (assembled)" : "");
  var wide = $("hexDump").clientWidth || 800;
  var perRow = wide < 620 ? 8 : 16;
  var from = r.from + pg * 4096, to = Math.min(r.to, from + 4096);
  var html = "";
  for (var a = from - (from % perRow); a < to; a += perRow) {
    html += '<div class="hrow"><span class="ha">' + ("00000000" + a.toString(16)).slice(-8) +
      ": </span>";
    var asc = "";
    for (var i = 0; i < perRow; i++) {
      var off = a + i;
      if (off < from || off >= to) { html += '<span class="hb dim">..</span>'; asc += " "; }
      else {
        var b = u8[off];
        html += '<span class="hb">' + ("0" + b.toString(16)).slice(-2) + "</span>";
        asc += (b >= 32 && b < 127) ? String.fromCharCode(b) : ".";
      }
    }
    html += '<span class="hasc">' + escHtml(asc) + "</span></div>";
  }
  $("hexDump").innerHTML = html;
}

/* ------------------------------ boot/wire ----------------------------- */

function switchTab(name) {
  document.body.classList.remove("nav-open");
  var tabs = $("tabs").querySelectorAll("button[data-tab]");
  for (var i = 0; i < tabs.length; i++) {
    setActive(tabs[i], getData(tabs[i], "tab") === name);
  }
  ["editor", "struct", "opcodes", "hex", "guide"].forEach(function (t) {
    setActive($("tab-" + t), t === name);
  });
  if (name === "editor" && ed) ed.render();
}

function wire() {
  ed = new Editor.Editor({
    view: $("edView"), rows: $("edRows"), editWrap: $("edEdit"),
    textarea: $("editArea"), gutter: $("edGutter"), complete: $("edComp")
  }, { onSymbolClick: openSymModal, onLabelClick: jumpToLabel,
    onEdit: onCodeEdit, onCaret: updateSigHint });
  ed.setCompleter(completeWord);
  loadSymPrefs();
  if (!SYM) {
    $("btnSym").style.display = "none";
    $("btnNamesExport").style.display = "none";
    $("btnNamesImport").style.display = "none";
  }
  $("edMount").addEventListener("dblclick", function () { setEditing(true); });
  $("errBanner").addEventListener("click", function () { this.classList.remove("on"); });
  document.addEventListener("keydown", function (e) {
    var k = e.key || (e.keyCode === 27 ? "Escape" : (e.keyCode === 83 ? "s" : ""));
    if (k === "Escape" && S.sym.modalOff !== null) { closeSymModal(); return; }
    if (k === "Escape" && S.editing) setEditing(false);
    if ((e.ctrlKey || e.metaKey) && (k === "s" || k === "S")) {
      e.preventDefault();
      if ($("tab-editor").classList.contains("active")) doAssemble();
    }
  });
  $("tabs").addEventListener("click", function (e) {
    var b = closestEl(e.target, "button", "data-tab");
    if (b) switchTab(getData(b, "tab"));
  });
  $("btnOpen").addEventListener("click", function () {
    pickFile("fileScm", ".scm", true, function (name, buf) { loadBytes(name, new Uint8Array(buf)); });
  });
  $("btnOpenSrc").addEventListener("click", function () {
    pickFile("fileSrc", ".txt,.src", false, function (name, txt) { loadSourceFile(name, txt); });
  });
  $("btnSample").addEventListener("click", function () {
    fetchBytes("main.scm", function (buf) {
      loadBytes("main.scm", new Uint8Array(buf));
    }, function () {
      toast("Could not fetch main.scm -- are you serving this folder over HTTP? " +
        "Use Open instead.", 4500);
    });
  });
  $("btnEdit").addEventListener("click", function () { setEditing(!S.editing); });
  $("btnSnippets").addEventListener("click", function () {
    var box = $("snipMenu");
    if (box.style.display === "block") { box.style.display = "none"; return; }
    renderSnipMenu();
    box.style.display = "block";
  });
  document.addEventListener("click", function (e) {
    var box = $("snipMenu");
    if (!box || box.style.display !== "block") return;
    var t = e.target;
    while (t && t.nodeType === 1) {
      if (t === box || t.id === "btnSnippets") return;
      t = t.parentNode;
    }
    box.style.display = "none";
  });
  $("gotoInput").addEventListener("keydown", function (e) {
    var k = e.key || (e.keyCode === 13 ? "Enter" : "");
    if (k !== "Enter") return;
    var n = parseInt(this.value, 10);
    if (n >= 1 && ed) ed.gotoLine(n, true);
  });
  $("btnSym").addEventListener("click", toggleSymNames);
  $("btnNamesExport").addEventListener("click", exportSymNames);
  $("btnNamesImport").addEventListener("click", function () {
    pickFile("fileSym", ".json,.txt", false, importSymNames);
  });
  $("symSave").addEventListener("click", saveSymModal);
  $("symReset").addEventListener("click", resetSymModal);
  $("symCancel").addEventListener("click", closeSymModal);
  $("symModal").addEventListener("click", function (e) {
    if (e.target === $("symModal")) closeSymModal();
  });
  $("symName").addEventListener("keydown", function (e) {
    var k = e.key || (e.keyCode === 13 ? "Enter" : (e.keyCode === 27 ? "Escape" : ""));
    if (k === "Enter") saveSymModal();
    if (k === "Escape") closeSymModal();
  });
  $("symExport").addEventListener("click", exportSymNames);
  $("symImport").addEventListener("click", function () {
    pickFile("fileSym", ".json,.txt", false, importSymNames);
  });
  $("secNav").addEventListener("click", function (e) {
    var b = closestEl(e.target, "button", "data-sec");
    if (b) showSection(getData(b, "sec"), true);
    document.body.classList.remove("nav-open");
  });
  $("btnNav").addEventListener("click", function () {
    document.body.classList.toggle("nav-open");
  });
  $("navBackdrop").addEventListener("click", function () {
    document.body.classList.remove("nav-open");
  });
  $("secFilter").addEventListener("input", function () { rebuildSecNav(); });
  $("searchInput").addEventListener("input", runSearch);
  $("btnBuild").addEventListener("click", doAssemble);
  $("btnDlSrc").addEventListener("click", function () {
    if (!S.sections.length) { toast("Nothing to save."); return; }
    if (S.editing) applyEdit();
    var u8 = encodeUtf8(joinSource());
    download("main_src.txt", u8);
    toast("Source saved as main_src.txt.");
  });
  $("btnDlScm").addEventListener("click", function () {
    if (S.asm) download("main.scm", S.asm.bytes);
  });
  $("opSearch").addEventListener("input", function () { renderOpList(this.value); });
  $("hexRegion").addEventListener("change", function () { $("hexPage").value = 0; renderHexPage(); });
  $("hexPage").addEventListener("input", renderHexPage);
  $("misFilter").addEventListener("input", applyMisFilter);
  if (typeof window !== "undefined" && window.addEventListener) {
    var rszT = null;
    window.addEventListener("resize", function () {
      clearTimeout(rszT);
      rszT = setTimeout(function () {
        if ($("tab-hex").classList.contains("active")) renderHexPage();
      }, 250);
    });
  }
  buildOpList();
}

function boot() {
  try { wire(); }
  catch (e) { showError("Startup failed: " + ((e && e.message) || e)); }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else boot();

})();
