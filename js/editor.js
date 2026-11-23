/* VC SCM Studio -- code view/edit component (no dependencies). */
var Editor = (function () {
"use strict";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

var DIRS = { DEFINE: 1, OBJECTS: 1, OBJECT: 1, MISSIONS: 1, MISSION: 1, AT: 1,
  GLOBAL_SPACE: 1, VAR_INT: 1, VAR_FLOAT: 1, HEX: 1, END: 1 };

// highlight one source line -> HTML
function highlight(line) {
  // split trailing comment (quote-aware)
  var code = line, com = "";
  var inStr = false;
  for (var i = 0; i < line.length - 1; i++) {
    var c = line.charAt(i);
    if (inStr) {
      if (c === "\\") i++;
      else if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === "/" && line.charAt(i + 1) === "/") {
      code = line.slice(0, i); com = line.slice(i); break;
    }
  }
  var html = "";
  // tokenize code part
  var re = /('(?:[^'\\]|\\.)*'?|:[A-Za-z0-9_]+|[0-9A-Fa-f]{4}:|[@#$]?[A-Za-z_][A-Za-z0-9_]*|\d+@|0[xX][0-9A-Fa-f]+|\d+\.\d*|\d*\.\d+|\d+|[(),]|\s+|.)/g;
  var m, first = true;
  var db = (typeof VC_DB !== "undefined") ? VC_DB : null;
  while ((m = re.exec(code)) !== null) {
    var t = m[0];
    if (/^\s+$/.test(t) || t === "," || /^[()]$/.test(t)) { html += esc(t); continue; }
    var cls = "";
    if (first && t.charAt(0) === ":") cls = "t-labdef";
    else if (/^[0-9A-Fa-f]{4}:$/.test(t)) cls = "t-opnum";
    else if (t.charAt(0) === "'") cls = "t-str";
    else if (t.charAt(0) === "@") cls = "t-labref";
    else if (t.charAt(0) === "$") cls = "t-gvar";
    else if (t.charAt(0) === "#") cls = "t-model";
    else if (/^\d+@$/.test(t) || t.toUpperCase() === "TIMERA" || t.toUpperCase() === "TIMERB") cls = "t-lvar";
    else if (/^(0[xX][0-9A-Fa-f]+|\d+\.\d*|\d*\.\d+|\d+)$/.test(t)) cls = "t-num";
    else if (DIRS[t.toUpperCase()]) cls = "t-dir";
    else if (t.toUpperCase() === "NOT") cls = "t-kw";
    else if (db && db.byName[t.toUpperCase()] !== undefined) cls = "t-opname";
    html += cls ? '<span class="' + cls + '">' + esc(t) + "</span>" : esc(t);
    first = false;
  }
  if (com) html += '<span class="t-com">' + esc(com) + "</span>";
  return html || "&nbsp;";
}

var ROW_H = 19;

function Editor(els, opts) {
  this.view = els.view;         // .codeview (scroll container)
  this.rows = els.rows;         // .coderows inner
  this.editWrap = els.editWrap;
  this.ta = els.textarea;
  this.gutter = els.gutter;
  this.opts = opts || {};
  this.lines = [];
  this.mode = "view";
  this.maxW = 0;
  this.raf = 0;
  var self = this;
  this.view.addEventListener("scroll", function () {
    if (self.raf) return;
    self.raf = requestAnimationFrame(function () { self.raf = 0; self.render(); });
  });
  this.rows.addEventListener("dblclick", function (ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest(".coderow") : null;
    if (row && self.opts.onDblClick) self.opts.onDblClick(+row.dataset.ln);
  });
  this.rows.addEventListener("click", function (ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest(".coderow") : null;
    if (row && self.opts.onLineClick) self.opts.onLineClick(+row.dataset.ln);
  });
  this.ta.addEventListener("input", function () {
    if (self.opts.onEdit) self.opts.onEdit();
  });
  this.ta.addEventListener("scroll", function () {
    self.gutter.scrollTop = self.ta.scrollTop;
  });
  this.ta.addEventListener("keydown", function (ev) {
    if (ev.key === "Tab") {
      ev.preventDefault();
      var s = self.ta.selectionStart;
      self.ta.setRangeText("  ", s, self.ta.selectionEnd, "end");
      if (self.opts.onEdit) self.opts.onEdit();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      if (self.opts.onSave) self.opts.onSave();
    }
    if (ev.key === "Escape" && self.opts.onEscape) self.opts.onEscape();
  });
}

Editor.prototype.setLines = function (lines) {
  this.lines = lines;
  var mx = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > mx) mx = lines[i].length;
  }
  this.maxW = Math.max(80, mx + 8) + "ch";
  this.view.scrollTop = 0;
  this.render();
  if (this.mode === "edit") this._editRefresh();
};

Editor.prototype.render = function () {
  if (this.mode !== "view") return;
  var total = this.lines.length;
  var H = this.view.clientHeight || 400;
  var start = Math.max(0, Math.floor(this.view.scrollTop / ROW_H) - 12);
  var end = Math.min(total, Math.ceil((this.view.scrollTop + H) / ROW_H) + 12);
  var html = "";
  for (var i = start; i < end; i++) {
    html += '<div class="coderow" data-ln="' + (i + 1) + '" style="top:' + (i * ROW_H) +
      'px;min-width:' + this.maxW + '"><span class="ln">' + (i + 1) + "</span><span>" +
      highlight(this.lines[i]) + "</span></div>";
  }
  this.rows.style.height = (total * ROW_H) + "px";
  this.rows.innerHTML = html;
};

Editor.prototype.gotoLine = function (n, flash) {
  n = Math.max(1, Math.min(this.lines.length, n | 0));
  if (this.mode === "edit") {
    var pos = 0;
    for (var i = 0; i < n - 1; i++) pos += this.lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + this.lines[n - 1].length);
    // scroll textarea to line
    var lh = 19;
    this.ta.scrollTop = Math.max(0, (n - 1) * lh - this.ta.clientHeight / 2);
    this.gutter.scrollTop = this.ta.scrollTop;
    return;
  }
  this.view.scrollTop = Math.max(0, (n - 1) * ROW_H - this.view.clientHeight / 2);
  this.render();
  if (flash !== false) {
    var self = this;
    requestAnimationFrame(function () {
      var row = self.rows.querySelector('[data-ln="' + n + '"]');
      if (row) {
        row.classList.add("flash");
        setTimeout(function () { row.classList.remove("flash"); }, 1400);
      }
    });
  }
};

Editor.prototype.setMode = function (mode) {
  this.mode = mode;
  if (mode === "edit") {
    this._editRefresh();
    this.editWrap.classList.add("on");
    this.view.style.visibility = "hidden";
  } else {
    this.editWrap.classList.remove("on");
    this.view.style.visibility = "";
    this.render();
  }
};

Editor.prototype._editRefresh = function () {
  this.ta.value = this.lines.join("\n");
  var n = this.lines.length, g = "";
  for (var i = 1; i <= n; i++) g += i + "\n";
  this.gutter.textContent = g;
  this.ta.scrollTop = 0;
  this.gutter.scrollTop = 0;
};

Editor.prototype.getText = function () { return this.ta.value; };

// global search across sections -> [{sec, line, text}]
function searchAll(sections, query, max) {
  max = max || 300;
  var q = String(query).toLowerCase();
  if (!q) return [];
  var out = [];
  for (var s = 0; s < sections.length && out.length < max; s++) {
    var lines = sections[s].lines;
    for (var i = 0; i < lines.length && out.length < max; i++) {
      if (lines[i].toLowerCase().indexOf(q) >= 0) {
        out.push({ sec: sections[s].id, line: i + 1, text: lines[i] });
      }
    }
  }
  return out;
}

return { Editor: Editor, highlight: highlight, searchAll: searchAll };

})();
