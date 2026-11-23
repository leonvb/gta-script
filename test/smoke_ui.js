/* Headless UI smoke test: runs js/*.js in a vm context with DOM stubs,
   drives the real app wiring against main.scm. Usage: node test/smoke_ui.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -- " + extra : "")); }
}

function makeEl(tag, id) {
  const listeners = {};
  const el = {
    tagName: String(tag || "div").toUpperCase(), id: id || "",
    children: [], value: "", disabled: false, href: "", download: "",
    style: {}, dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); if (f) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    scrollTop: 0, clientHeight: 400, clientWidth: 800,
    selectionStart: 0, selectionEnd: 0,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    _fire(t, ev) { (listeners[t] || []).forEach((fn) => fn.call(el, ev || {})); },
    _count(t) { return (listeners[t] || []).length; },
    appendChild(c) { el.children.push(c); return c; },
    remove() {}, focus() {},
    click() { el._fire("click", { target: el }); },
    setRangeText(txt) { el.value = String(txt); },
    setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b; },
    querySelector() { return makeEl("div"); },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
  let html = "", text = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(v) { html = String(v); el.children = []; el._sets = (el._sets || 0) + 1; }
  });
  Object.defineProperty(el, "textContent", {
    get() { return text; }, set(v) { text = String(v); }
  });
  return el;
}

const scmBuf = fs.readFileSync(path.join(ROOT, "main.scm"));
const scmAB = scmBuf.buffer.slice(scmBuf.byteOffset, scmBuf.byteOffset + scmBuf.byteLength);

const ids = {};
const documentStub = {
  readyState: "complete",
  _listeners: {},
  getElementById(id) { return ids[id] || (ids[id] = makeEl("div", id)); },
  createElement(tag) { return makeEl(tag); },
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  body: makeEl("body")
};

const sandbox = {
  console: console,
  document: documentStub,
  performance: { now() { return Date.now(); } },
  requestAnimationFrame(fn) { fn(); return 0; },
  fetch(url) {
    if (url === "main.scm") {
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(scmAB) });
    }
    return Promise.reject(new Error("404 " + url));
  },
  TextEncoder: TextEncoder,
  Blob: Blob,
  URL: { createObjectURL() { return "blob:fake"; }, revokeObjectURL() {} },
  setTimeout: setTimeout, clearTimeout: clearTimeout
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}

function fire(id, type, ev) {
  const el = documentStub.getElementById(id);
  el._fire(type, ev || {});
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

(async function main() {
  console.log("== load ==");
  load("js/opcodes.js");
  load("js/scm.js");
  load("js/editor.js");
  load("js/app.js");
  ok(true, "all scripts evaluated, wire() ran");
  ok((ids.opList.innerHTML || "").indexOf("WAIT") >= 0, "opcode list built (" +
    (ids.opList.innerHTML.match(/oprow/g) || []).length + " rows)");

  console.log("== load bundled main.scm ==");
  fire("btnSample", "click");
  await tick(1500);
  ok((ids.fileBadge.innerHTML || "").indexOf("main.scm") >= 0, "file badge shows main.scm",
    ids.fileBadge.innerHTML.slice(0, 80));
  ok(ids.secSelect.children.length === 99, "99 sections in picker",
    "got " + ids.secSelect.children.length);
  ok((ids.edStatus.textContent || "").indexOf("MAIN") >= 0, "editor status shows MAIN");
  ok((ids.structRoot.innerHTML || "").indexOf("Missions (97)") >= 0, "structure shows 97 missions");
  ok((ids.hexDump.innerHTML || "").length > 1000, "hex dump rendered");
  ok(!ids.problems.classList.contains("on"), "no problems after load",
    ids.problems.innerHTML.slice(0, 120));

  console.log("== assemble ==");
  fire("btnBuild", "click");
  await tick(100);
  ok((ids.asmState.innerHTML || "").indexOf("assembled") >= 0, "assembled OK",
    ids.asmState.innerHTML.replace(/<[^>]+>/g, ""));
  ok(ids.btnDlScm.disabled === false, "Save .scm enabled");
  ok(!ids.problems.classList.contains("on"), "no problems after assemble",
    ids.problems.innerHTML.slice(0, 200));

  console.log("== tabs ==");
  function fakeTab(t) {
    return { nodeType: 1, tagName: "BUTTON", parentNode: null,
      getAttribute(k) { return k === "data-tab" ? t : null; } };
  }
  ["struct", "opcodes", "hex", "guide", "editor"].forEach((t) => {
    fire("tabs", "click", { target: fakeTab(t) });
  });
  ok(ids["tab-editor"].classList.contains("active"), "tab switching works");

  console.log("== opcode search ==");
  ids.opSearch.value = "00D6";
  fire("opSearch", "input");
  ok(ids.opList.innerHTML.indexOf("ANDOR") >= 0, "hex search finds ANDOR");
  ids.opSearch.value = "CREATE_CAR";
  fire("opSearch", "input");
  ok(ids.opList.innerHTML.indexOf("CREATE_CAR") >= 0, "name search finds CREATE_CAR");

  console.log("== code search ==");
  ids.searchInput.value = "GOTO @";
  fire("searchInput", "input");
  ok(ids.searchResults.style.display === "block", "search results shown");
  ok(ids.searchResults.innerHTML.indexOf("MAIN") >= 0, "search hits MAIN section");

  console.log("== navigation & edit ==");
  ids.secSelect.value = "mission:0";
  fire("secSelect", "change");
  ok((ids.edStatus.textContent || "").indexOf("MISSION 0") >= 0, "jumped to MISSION 0");
  fire("btnEdit", "click");
  const before = ids.editArea.value;
  ok(before.length > 500, "edit mode fills textarea (" + before.length + " chars)");
  ids.editArea.value = before + "\n0001: 100\n";
  fire("btnEdit", "click"); // Done -> applyEdit
  ok((ids.fileBadge.innerHTML || "").indexOf("edited") >= 0, "dirty flag shown");
  fire("btnBuild", "click");
  await tick(100);
  ok((ids.asmState.innerHTML || "").indexOf("assembled") >= 0, "re-assembled after edit");

  console.log("== hex ==");
  fire("tabs", "click", { target: fakeTab("hex") });
  ids.hexPage.value = 2;
  fire("hexPage", "input");
  ok(ids.hexDump.innerHTML.indexOf("0000") >= 0, "hex page 2 rendered");
  ids.hexRegion.value = 0;
  fire("hexRegion", "change");
  ok(ids.hexDump.innerHTML.length > 1000, "hex region switch renders");

  console.log("== opcode detail & insert ==");
  const fakeOp = { dataset: { id: "165" }, _l: {}, addEventListener(t, fn) { this._l[t] = fn; } };
  ids.opList.querySelectorAll = () => [fakeOp];
  ids.opSearch.value = "CREATE_CAR";
  fire("opSearch", "input");
  fakeOp._l.click.call(fakeOp);
  ok((ids.opDetail.innerHTML || "").indexOf("CREATE_CAR") >= 0, "opcode detail renders");
  ok(ids.opDetail.style.display === "block", "detail panel shown");
  fire("btnOpInsert", "click");
  ok((ids.toast.textContent || "").indexOf("Inserted 00A5") >= 0 ||
     (ids.toast.textContent || "").indexOf("Inserted CREATE_CAR") >= 0, "template inserted",
    ids.toast.textContent.slice(0, 90));

  console.log("== mission row click ==");
  const fakeMis = { dataset: { mis: "5" }, _l: {}, addEventListener(t, fn) { this._l[t] = fn; } };
  ids.structRoot.querySelectorAll = () => [fakeMis];
  fire("btnBuild", "click");
  await tick(100);
  fakeMis._l.click.call(fakeMis);
  ok((ids.edStatus.textContent || "").indexOf("MISSION 5") >= 0, "mission row opens MISSION 5");

  console.log("== build failure path ==");
  ids.secSelect.value = "main";
  fire("secSelect", "change");
  fire("btnEdit", "click");
  ids.editArea.value = ids.editArea.value + "\nBOGUS_OPCODE @FOO\n";
  fire("btnEdit", "click");
  const fakeProb = { dataset: { i: "0" }, _l: {}, addEventListener(t, fn) { this._l[t] = fn; } };
  ids.problems.querySelectorAll = () => [fakeProb];
  fire("btnBuild", "click");
  await tick(100);
  ok((ids.asmState.innerHTML || "").indexOf("error") >= 0, "failure reported in header",
    ids.asmState.innerHTML.replace(/<[^>]+>/g, ""));
  ok(ids.problems.classList.contains("on"), "problems panel shown");
  fakeProb._l.click.call(fakeProb);
  ok(true, "problem click navigates without throwing");
  // repair: still in edit mode after the problem click, so strip the
  // garbage line from the live textarea, then Done, then rebuild
  ids.editArea.value = ids.editArea.value.replace("\nBOGUS_OPCODE @FOO\n", "\n");
  fire("btnEdit", "click");
  fire("btnBuild", "click");
  await tick(100);
  ok((ids.asmState.innerHTML || "").indexOf("assembled") >= 0, "repaired source assembles");
  console.log("  [dbg repair]", ids.asmState.innerHTML.replace(/<[^>]+>/g, ""),
    "|", (ids.problems.innerHTML || "").slice(0, 300));

  console.log("== downloads & keys ==");
  fire("btnDlSrc", "click");
  fire("btnDlScm", "click");
  ok(true, "downloads did not throw");
  (documentStub._listeners.keydown || []).forEach((fn) =>
    fn({ key: "Escape", preventDefault() {} }));
  (documentStub._listeners.keydown || []).forEach((fn) =>
    fn({ key: "s", ctrlKey: true, preventDefault() {} }));
  ok(true, "keyboard shortcuts did not throw");

  console.log("== source save -> reopen round-trip ==");
  let savedBytes = null;
  sandbox.Blob = function (parts) { savedBytes = parts[0]; };
  sandbox.FileReader = function () {
    return {
      result: null, onload: null, onerror: null,
      readAsText() {
        this.result = Buffer.from(savedBytes).toString("utf8");
        if (this.onload) this.onload();
      },
      readAsArrayBuffer() {
        const ab = new ArrayBuffer(savedBytes.length);
        new Uint8Array(ab).set(savedBytes);
        this.result = ab;
        if (this.onload) this.onload();
      }
    };
  };
  fire("btnDlSrc", "click");
  ok(savedBytes && savedBytes.length > 1000000, "source blob captured (" +
    (savedBytes ? savedBytes.length : 0) + " bytes)");
  // persistent attached input (iOS-Safari-safe flow)
  const srcInput = documentStub.getElementById("fileSrc");
  fire("btnOpenSrc", "click");
  ok(typeof srcInput.onchange === "function", "open-source arms the file input");
  srcInput.files = [{ name: "main_src.txt" }];
  srcInput.onchange();
  await tick(50);
  ok(ids.secSelect.children.length === 99, "reopened source has 99 sections",
    "got " + ids.secSelect.children.length);
  ok((ids.fileBadge.innerHTML || "").indexOf("(source)") >= 0, "badge marks source file");
  fire("btnBuild", "click");
  await tick(100);
  ok((ids.asmState.innerHTML || "").indexOf("assembled") >= 0, "reopened source assembles");

  console.log("== binary .scm open via file input ==");
  sandbox.FileReader = function () {
    return {
      result: null, onload: null, onerror: null,
      readAsArrayBuffer() { this.result = scmAB; if (this.onload) this.onload(); },
      readAsText() {}
    };
  };
  const scmInput = documentStub.getElementById("fileScm");
  fire("btnOpen", "click");
  ok(typeof scmInput.onchange === "function", "open-.scm arms the file input");
  scmInput.files = [{ name: "main.scm" }];
  scmInput.onchange();
  await tick(1500);
  ok((ids.fileBadge.innerHTML || "").indexOf("main.scm") >= 0, "binary open loads main.scm");
  ok(ids.secSelect.children.length === 99, "binary open yields 99 sections");
  ok(!ids.errBanner.classList.contains("on"), "no error banner during whole session");

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SMOKE CRASH:", e); process.exit(2); });
