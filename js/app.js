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
  opDetail: null,
  hexBytes: null,
  hexRegions: []
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
  $("fileBadge").innerHTML = escHtml(S.fileName) +
    (n ? ' <span class="dirty">\u25cf ' + n + " edited</span>" : "") +
    (S.bytes ? " (" + S.bytes.length + " bytes)" : "");
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
  $("btnEdit").textContent = "Edit";
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
}

function updateEdStatus() {
  var sec = curSec();
  $("edStatus").textContent = sec ? (sec.title + " -- " + sec.lines.length + " lines -- " +
    (S.editing ? "EDITING (Esc: view, Ctrl+S: assemble)" : "view (double-click a line to edit)")) : "";
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
    ed.setMode("view");
    $("btnEdit").textContent = "Edit";
    rebuildSecNav();
    refreshBadge();
  }
  updateEdStatus();
}

function runSearch() {
  var q = $("searchInput").value;
  var box = $("searchResults");
  if (!q) { box.innerHTML = ""; box.style.display = "none"; return; }
  var res = Editor.searchAll(S.sections, q, 200);
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
  var from = r.from + pg * 4096, to = Math.min(r.to, from + 4096);
  var html = "";
  for (var a = from - (from % 16); a < to; a += 16) {
    html += '<div class="hrow"><span class="ha">' + ("00000000" + a.toString(16)).slice(-8) +
      ": </span>";
    var asc = "";
    for (var i = 0; i < 16; i++) {
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
    textarea: $("editArea"), gutter: $("edGutter")
  });
  $("edMount").addEventListener("dblclick", function () { setEditing(true); });
  $("errBanner").addEventListener("click", function () { this.classList.remove("on"); });
  document.addEventListener("keydown", function (e) {
    var k = e.key || (e.keyCode === 27 ? "Escape" : (e.keyCode === 83 ? "s" : ""));
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
  $("secNav").addEventListener("click", function (e) {
    var b = closestEl(e.target, "button", "data-sec");
    if (b) showSection(getData(b, "sec"), true);
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
