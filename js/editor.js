/* VC SCM Studio -- code view/edit component (no dependencies). */
var Editor = (function () {
"use strict";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

var DIRS = { DEFINE: 1, OBJECTS: 1, OBJECT: 1, MISSIONS: 1, MISSION: 1, AT: 1,
  GLOBAL_SPACE: 1, VAR_INT: 1, VAR_FLOAT: 1, HEX: 1, END: 1 };

// Symbol-name display state (set by the app; highlight() stays a pure function
// of the line plus these two module flags).
var symNamesOn = true;
var symOverrides = null; // off -> user name, or null

function setSymNames(on) { symNamesOn = !!on; }
function symNamesOnFlag() { return symNamesOn; }
function setSymOverrides(o) { symOverrides = o || null; }

function symEntry(off) {
  if (typeof VC_SYM === "undefined" || !VC_SYM) return null;
  return VC_SYM.entry(off);
}
function symDisplay(off, e) {
  if (symOverrides && symOverrides[off] !== undefined) {
    return { name: symOverrides[off], custom: true };
  }
  return { name: e.name, custom: false };
}
function symTitle(off, e, disp) {
  var t = "$" + off + " \u00b7 " + (e.t === "F" ? "float" : "int") + " " + e.cat +
    " \u00b7 " + e.w + "W " + e.r + "R";
  if (e.x) t += " \u00b7 " + e.x;
  if (disp.custom) t += " \u00b7 yours (auto: " + e.name + ")";
  t += " \u00b7 click to rename";
  return t;
}

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
  var m, first = true, opSlot = true;
  var db = (typeof VC_DB !== "undefined") ? VC_DB : null;
  var pendingDollar = false, prevEnd = -1;
  function flushDollar() {
    pendingDollar = false;
    html += '<span class="t-gvar">$</span>';
    first = false;
  }
  while ((m = re.exec(code)) !== null) {
    var t = m[0], adjacent = (m.index === prevEnd);
    prevEnd = m.index + t.length;
    // a lone "$" is held back: "$<digits>" becomes one symbol span,
    // "$<name>" one named-variable span, anything else keeps old colors
    if (pendingDollar) {
      if (adjacent && /^\d+$/.test(t)) {
        pendingDollar = false;
        var off = parseInt(t, 10);
        var e = symEntry(off);
        if (e) {
          var disp = symDisplay(off, e);
          var shown = symNamesOn ? disp.name : "$" + off;
          html += '<span class="gsym sc-' + e.cat + (disp.custom ? " custom" : "") +
            '" data-sym="' + off + '" title="' + esc(symTitle(off, e, disp)) + '">' +
            esc(shown) + "</span>";
          first = false; opSlot = false;
          continue;
        }
        flushDollar();
      } else if (adjacent && /^[@#$]?[A-Za-z_][A-Za-z0-9_]*$/.test(t) &&
                 t.charAt(0) !== "@" && t.charAt(0) !== "#") {
        pendingDollar = false;
        html += '<span class="t-gvar" title="named global (VAR_INT / VAR_FLOAT)">' +
          esc("$" + t) + "</span>";
        first = false; opSlot = false;
        continue;
      } else {
        flushDollar();
      }
    }
    if (t === "$") { pendingDollar = true; continue; }
    if (/^\s+$/.test(t) || t === "," || /^[()]$/.test(t)) { html += esc(t); continue; }
    var cls = "";
    if (first && t.charAt(0) === ":") cls = "t-labdef";
    else if (/^[0-9A-Fa-f]{4}:$/.test(t)) cls = "t-opnum";
    else if (t.charAt(0) === "'") cls = "t-str";
    else if (t.charAt(0) === "@") {
      html += '<span class="t-labref" data-lab="' + esc(t.slice(1).toUpperCase()) +
        '" title="click to jump to this label">' + esc(t) + "</span>";
      first = false; opSlot = false;
      continue;
    }
    else if (t.charAt(0) === "$" && t.length > 1) {
      html += '<span class="t-gvar" title="named global (VAR_INT / VAR_FLOAT)">' +
        esc(t) + "</span>";
      first = false; opSlot = false;
      continue;
    }
    else if (t.charAt(0) === "$") cls = "t-gvar";
    else if (t.charAt(0) === "#") cls = "t-model";
    else if (/^\d+@$/.test(t) || t.toUpperCase() === "TIMERA" || t.toUpperCase() === "TIMERB") cls = "t-lvar";
    else if (/^(0[xX][0-9A-Fa-f]+|\d+\.\d*|\d*\.\d+|\d+)$/.test(t)) cls = "t-num";
    else if (DIRS[t.toUpperCase()]) cls = "t-dir";
    else if (t.toUpperCase() === "NOT") cls = "t-kw";
    else if (db && db.byName[t.toUpperCase()] !== undefined) cls = "t-opname";
    else if (db && opSlot && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) &&
             !/^[0-9A-Fa-f]+$/.test(t)) cls = "t-opunk";
    html += cls ? '<span class="' + cls + '">' + esc(t) + "</span>" : esc(t);
    // :label, XXXX: and NOT may precede the opcode; anything else closes the slot
    opSlot = opSlot && (t.toUpperCase() === "NOT" ||
      /^[0-9A-Fa-f]{4}:$/.test(t) || (first && t.charAt(0) === ":"));
    first = false;
  }
  if (pendingDollar) flushDollar();
  if (com) html += '<span class="t-com">' + esc(com) + "</span>";
  return html || "&nbsp;";
}

// identifier-ish word around the caret: the filter text before the caret,
// the full replace range, and the sigil char in front ($ @ # : or "")
function wordAt(text, caret) {
  var v = String(text), pos = Math.max(0, Math.min(v.length, caret | 0));
  var a = pos, b = pos;
  while (a > 0 && /[A-Za-z0-9_]/.test(v.charAt(a - 1))) a--;
  while (b < v.length && /[A-Za-z0-9_]/.test(v.charAt(b))) b++;
  var sigil = "";
  if (a > 0) {
    var c = v.charAt(a - 1);
    if (c === "$" || c === "@" || c === "#" || c === ":") sigil = c;
  }
  return { a: a, b: b, word: v.slice(a, pos), sigil: sigil };
}

// rank word-list matches: prefix hits first, then substring hits (capped)
function matchList(list, prefix, max) {
  max = max || 12;
  var p = String(prefix).toUpperCase();
  var pre = [], sub = [], i, t;
  for (i = 0; i < list.length; i++) {
    t = typeof list[i] === "string" ? list[i] : list[i].text;
    var up = String(t).toUpperCase();
    if (up.indexOf(p) === 0) { if (pre.length < max) pre.push(list[i]); }
    else if (p && up.indexOf(p) >= 0 && pre.length + sub.length < max) sub.push(list[i]);
  }
  return pre.concat(sub).slice(0, max);
}

// caret position in px relative to the textarea's top-left (padding included,
// scroll removed), for placing the completion dropdown. The textarea never
// wraps (white-space:pre), so Y is arithmetic and only the current line is
// mirrored for X. Never throws (headless/old browsers get a fallback).
function caretXY(ta) {
  var done = { top: 20, left: 80 };
  try {
    if (typeof document === "undefined" || !document.createElement) return done;
    var v = String(ta.value);
    var caret = (ta.selectionStart === null || ta.selectionStart === undefined) ?
      v.length : ta.selectionStart;
    var cs = null;
    if (typeof window !== "undefined" && window.getComputedStyle) {
      try { cs = window.getComputedStyle(ta, null); } catch (e) { cs = null; }
    }
    var padT = 8, padL = 76, lh = 19;
    try {
      if (cs) {
        padT = parseInt(cs.paddingTop, 10) || padT;
        padL = parseInt(cs.paddingLeft, 10) || padL;
        lh = parseInt(cs.lineHeight, 10) || lh;
      }
    } catch (e) { /* keep defaults */ }
    var line = 0, i;
    for (i = 0; i < caret; i++) if (v.charCodeAt(i) === 10) line++;
    var left = 0;
    try {
      var div = document.createElement("div");
      var st = div.style;
      st.position = "absolute"; st.visibility = "hidden"; st.top = "0"; st.left = "-9999px";
      st.whiteSpace = "pre"; st.padding = "0"; st.border = "0";
      if (cs && cs.font) st.font = cs.font;
      var lineStart = v.lastIndexOf("\n", caret - 1) + 1;
      div.textContent = v.slice(lineStart, caret);
      var span = document.createElement("span");
      span.textContent = ".";
      div.appendChild(span);
      var host = document.body || ta.parentNode;
      if (host && host.appendChild) {
        host.appendChild(div);
        left = span.offsetLeft || 0;
        if (div.parentNode && div.parentNode.removeChild) div.parentNode.removeChild(div);
        else if (div.remove) div.remove();
      }
    } catch (e) { /* keep left = 0 */ }
    return {
      top: padT + line * lh - (ta.scrollTop || 0) + lh + 2,
      left: padL + left - (ta.scrollLeft || 0)
    };
  } catch (e) { return done; }
}

var ROW_H = 19;

// compat: rAF / closest / dataset fallbacks for old mobile browsers
function raf(fn) {
  if (typeof requestAnimationFrame !== "undefined") return requestAnimationFrame(fn);
  return setTimeout(function () { fn(Date.now()); }, 16);
}
function closestRow(el) {
  while (el && el.nodeType === 1) {
    if ((" " + (el.className || "") + " ").indexOf(" coderow ") >= 0) return el;
    el = el.parentNode;
  }
  return null;
}
function rowNum(row) { return +row.getAttribute("data-ln"); }
// name of a clicked @label span (walks up to the row; old-browser safe)
function labName(el, stopAt) {
  while (el && el.nodeType === 1 && el !== stopAt) {
    if (el.getAttribute) {
      var v = el.getAttribute("data-lab");
      if (v !== null && v !== "") return v;
    }
    el = el.parentNode;
  }
  return null;
}
// offset of a clicked symbol span (walks up to the row; old-browser safe)
function symOff(el, stopAt) {
  while (el && el.nodeType === 1 && el !== stopAt) {
    if (el.getAttribute) {
      var v = el.getAttribute("data-sym");
      if (v !== null && v !== "") return +v;
    }
    el = el.parentNode;
  }
  return null;
}

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
  this.compBox = els.complete || null;
  this.compFn = null;
  this._comp = null;
  this.lineMarks = {};
  this._marksKey = "";
  var self = this;
  this.view.addEventListener("scroll", function () {
    if (self.raf) return;
    self.raf = raf(function () { self.raf = 0; self.render(); });
  });
  this.rows.addEventListener("dblclick", function (ev) {
    var row = closestRow(ev.target);
    if (row && self.opts.onDblClick) self.opts.onDblClick(rowNum(row));
  });
  this.rows.addEventListener("click", function (ev) {
    var row = closestRow(ev.target);
    if (!row) return;
    var off = ev.target ? symOff(ev.target, row) : null;
    if (off !== null && self.opts.onSymbolClick) {
      self.opts.onSymbolClick(off);
      return;
    }
    var lab = ev.target ? labName(ev.target, row) : null;
    if (lab !== null && self.opts.onLabelClick) {
      self.opts.onLabelClick(lab);
      return;
    }
    if (self.opts.onLineClick) self.opts.onLineClick(rowNum(row));
  });
  this.ta.addEventListener("input", function () {
    if (self.opts.onEdit) self.opts.onEdit();
    self._compRefresh(false);
  });
  this.ta.addEventListener("keyup", function () {
    self._compCaretCheck();
    if (self.opts.onCaret) self.opts.onCaret();
  });
  this.ta.addEventListener("click", function () {
    self._compCaretCheck();
    if (self.opts.onCaret) self.opts.onCaret();
  });
  if (this.compBox) {
    this.compBox.addEventListener("mousedown", function (ev) {
      var t = ev.target, box = self.compBox, i;
      while (t && t !== box) {
        if (t.getAttribute && t.getAttribute("data-i") !== null) {
          if (ev.preventDefault) ev.preventDefault();
          i = +t.getAttribute("data-i");
          self._compAccept(isNaN(i) ? 0 : i);
          return;
        }
        t = t.parentNode;
      }
    });
    this.compBox.addEventListener("mouseover", function (ev) {
      var t = ev.target, box = self.compBox;
      while (t && t !== box) {
        if (t.getAttribute && t.getAttribute("data-i") !== null) {
          if (self._comp && +t.getAttribute("data-i") !== self._comp.sel) {
            self._comp.sel = +t.getAttribute("data-i");
            self._compRender();
          }
          return;
        }
        t = t.parentNode;
      }
    });
  }
  this.ta.addEventListener("scroll", function () {
    self.gutter.scrollTop = self.ta.scrollTop;
  });
  this.ta.addEventListener("keydown", function (ev) {
    var k = ev.key || (ev.keyCode === 9 ? "Tab" : ev.keyCode === 27 ? "Escape" :
      ev.keyCode === 13 ? "Enter" : ev.keyCode === 38 ? "Up" : ev.keyCode === 40 ? "Down" :
      ev.keyCode === 83 ? "s" : ev.keyCode === 32 ? " " : "");
    if (k === "Tab" && self._comp) {
      ev.preventDefault();
      self._compAccept(self._comp.sel);
      return;
    }
    if ((k === "Enter" || k === "Up" || k === "Down") && self._comp) {
      ev.preventDefault();
      if (k === "Enter") self._compAccept(self._comp.sel);
      else self._compMove(k === "Up" ? -1 : 1);
      return;
    }
    if (k === "Escape" && self._comp) {
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      self._compHide();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && k === " ") {
      ev.preventDefault();
      self._compRefresh(true);
      return;
    }
    if (k === "Tab") {
      ev.preventDefault();
      if (self.ta.setRangeText) {
        self.ta.setRangeText("  ", self.ta.selectionStart, self.ta.selectionEnd, "end");
      } else {
        self.ta.value = self.ta.value + "  ";
      }
      if (self.opts.onEdit) self.opts.onEdit();
      self._compHide();
    }
    if ((ev.ctrlKey || ev.metaKey) && (k === "s" || k === "S")) {
      ev.preventDefault();
      if (self.opts.onSave) self.opts.onSave();
    }
    if (k === "Escape" && self.opts.onEscape) self.opts.onEscape();
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
    if (this.ta.focus) this.ta.focus();
    if (this.ta.setSelectionRange) {
      try { this.ta.setSelectionRange(pos, pos + this.lines[n - 1].length); } catch (e) { /* ignore */ }
    }
    // scroll textarea to line
    var lh = 19;
    try {
      if (typeof window !== "undefined" && window.getComputedStyle) {
        var cs = window.getComputedStyle(self.ta, null);
        var plh = parseInt((cs.getPropertyValue && cs.getPropertyValue("line-height")) || cs.lineHeight, 10);
        if (plh > 0) lh = plh;
      }
    } catch (e) { /* keep default */ }
    this.ta.scrollTop = Math.max(0, (n - 1) * lh - this.ta.clientHeight / 2);
    this.gutter.scrollTop = this.ta.scrollTop;
    return;
  }
  this.view.scrollTop = Math.max(0, (n - 1) * ROW_H - this.view.clientHeight / 2);
  this.render();
  if (flash !== false) {
    var self = this;
    raf(function () {
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
  this._gutterRender();
  this.ta.scrollTop = 0;
  this.gutter.scrollTop = 0;
};

Editor.prototype.getText = function () { return this.ta.value; };

Editor.prototype.caretInfo = function () {
  var ta = this.ta, v = String(ta.value);
  var c = (ta.selectionStart === null || ta.selectionStart === undefined) ? v.length : ta.selectionStart;
  var start = v.lastIndexOf("\n", c - 1) + 1, end = v.indexOf("\n", c);
  if (end < 0) end = v.length;
  var line = 1;
  for (var i = 0; i < c; i++) if (v.charCodeAt(i) === 10) line++;
  return { line: line, col: c - start, text: v.slice(start, end) };
};

Editor.prototype.setCompleter = function (fn) {
  this.compFn = fn || null;
  if (!fn) this._compHide();
};
Editor.prototype.completeOpen = function () { return !!this._comp; };
Editor.prototype.hideComplete = function () { this._compHide(); };

Editor.prototype._compRefresh = function (force) {
  this._compHide();
  if (!this.compFn || !this.compBox || this.mode !== "edit") return;
  var ta = this.ta;
  var caret = (ta.selectionStart === null || ta.selectionStart === undefined) ?
    ta.value.length : ta.selectionStart;
  // never complete inside a // comment or a 'text label' (unless forced)
  var ls = ta.value.lastIndexOf("\n", caret - 1) + 1;
  var before = ta.value.slice(ls, caret);
  var inStr = false;
  for (var i = 0; i < before.length; i++) {
    var ch = before.charAt(i);
    if (inStr) { if (ch === "\\") i++; else if (ch === "'") inStr = false; }
    else if (ch === "'") inStr = true;
    else if (ch === "/" && before.charAt(i + 1) === "/") return;
  }
  if (inStr && !force) return;
  var w = wordAt(ta.value, caret);
  if (!force && !w.word && w.sigil !== "$" && w.sigil !== "@" && w.sigil !== "#") return;
  var items = null;
  try { items = this.compFn(w.word, w.sigil, w.a, ta.value, caret); } catch (e) { items = null; }
  if (!items || !items.length) return;
  this._comp = { items: items.slice(0, 12), sel: 0, a: w.a, b: w.b, caret: caret };
  this._compRender();
  this._compPlace();
};

Editor.prototype._compRender = function () {
  var c = this._comp;
  if (!c || !this.compBox) return;
  var html = "";
  for (var i = 0; i < c.items.length; i++) {
    var it = c.items[i];
    var t = (typeof it === "string") ? it : it.text;
    var d = (it && it.detail) || "";
    html += '<div class="edcomp-row' + (i === c.sel ? " sel" : "") + '" data-i="' + i +
      '"><span class="ct">' + esc(t) + "</span>" +
      (d ? '<span class="cd">' + esc(d) + "</span>" : "") + "</div>";
  }
  this.compBox.innerHTML = html;
  this.compBox.style.display = "block";
};

Editor.prototype._compPlace = function () {
  var box = this.compBox, ta = this.ta;
  if (!box || !this._comp) return;
  var p = caretXY(ta);
  var h = Math.min(this._comp.items.length, 8) * 24 + 8;
  var wrapH = ta.clientHeight || 400, wrapW = ta.clientWidth || 800;
  var top = p.top;
  if (top + h > wrapH && p.top - h - 24 > 0) top = p.top - h - 24;
  box.style.left = Math.max(4, Math.min(p.left, wrapW - 260)) + "px";
  box.style.top = Math.max(2, top) + "px";
};

Editor.prototype._compMove = function (d) {
  var c = this._comp;
  if (!c) return;
  c.sel = (c.sel + d + c.items.length) % c.items.length;
  this._compRender();
  var box = this.compBox, y = c.sel * 24;
  if (box) {
    if (y < (box.scrollTop || 0)) box.scrollTop = y;
    else if (y + 24 > (box.scrollTop || 0) + (box.clientHeight || 200)) {
      box.scrollTop = y + 24 - (box.clientHeight || 200);
    }
  }
};

Editor.prototype._compHide = function () {
  this._comp = null;
  if (this.compBox) this.compBox.style.display = "none";
};

Editor.prototype._compAccept = function (i) {
  var c = this._comp;
  if (!c) return;
  var it = c.items[i];
  if (it === undefined) { this._compHide(); return; }
  var ins = (typeof it === "string") ? it : it.text;
  var ta = this.ta, v = String(ta.value);
  ta.value = v.slice(0, c.a) + ins + v.slice(c.b);
  var p = c.a + ins.length;
  try { ta.setSelectionRange(p, p); } catch (e) { /* old browser */ }
  try { ta.selectionStart = p; ta.selectionEnd = p; } catch (e) { /* ignore */ }
  this._compHide();
  if (this.opts.onEdit) this.opts.onEdit();
  if (this.opts.onCaret) this.opts.onCaret();
  if (ta.focus) { try { ta.focus(); } catch (e) { /* ignore */ } }
};

Editor.prototype._compCaretCheck = function () {
  var c = this._comp;
  if (!c) return;
  var s = this.ta.selectionStart;
  if (s === null || s === undefined || s !== c.caret) this._compHide();
};

Editor.prototype.setLineMarks = function (marks) {
  var key = "";
  try { key = JSON.stringify(marks || {}); } catch (e) { key = "x" + Math.random(); }
  if (key === this._marksKey) return;
  this._marksKey = key;
  this.lineMarks = marks || {};
  if (this.mode === "edit") this._gutterRender();
};

Editor.prototype._gutterRender = function () {
  var n = this.lines.length, g = "", marks = this.lineMarks || {}, i, mk;
  for (i = 1; i <= n; i++) {
    mk = marks[i];
    if (mk) {
      g += '<span class="gln mk-' + mk.kind + '" title="' + esc(mk.msg) + '">' + i + "</span>";
    } else {
      g += '<span class="gln">' + i + "</span>";
    }
  }
  this.gutter.innerHTML = g;
};

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

return { Editor: Editor, highlight: highlight, searchAll: searchAll,
  wordAt: wordAt, matchList: matchList,
  setSymNames: setSymNames, symNamesOn: symNamesOnFlag,
  setSymOverrides: setSymOverrides };

})();
