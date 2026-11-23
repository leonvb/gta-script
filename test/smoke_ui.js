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

// IDs that really exist: parsed from index.html (+ dynamic IDs the app creates).
const htmlIds = {};
fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/ id="([^"]+)"/g, (m, id) => {
  htmlIds[id] = true; return m;
});
["btnOpInsert"].forEach((id) => { htmlIds[id] = true; });

const ids = {};
const documentStub = {
  readyState: "complete",
  _listeners: {},
  getElementById(id) {
    if (!htmlIds[id]) return null; // faithful: unknown IDs are null, like a browser
    return ids[id] || (ids[id] = makeEl("div", id));
  },
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
function gotoSection(id) {
  fire("secNav", "click", { target: { nodeType: 1, tagName: "BUTTON", parentNode: null,
    getAttribute(k) { return k === "data-sec" ? id : null; } } });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

(async function main() {
  console.log("== load ==");
  load("js/opcodes.js");
  load("js/scm.js");
  load("js/symbols.js");
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
  ok(ids.secCount.textContent === "99 sections", "navigator lists 99 sections",
    "got " + JSON.stringify(ids.secCount.textContent));
  ok((ids.fileMeta.textContent || "").indexOf("99 sections") >= 0, "status bar shows file meta",
    "got " + JSON.stringify(ids.fileMeta.textContent));
  ok((ids.edStatus.textContent || "").indexOf("MAIN") >= 0, "editor status shows MAIN");
  ok((ids.structRoot.innerHTML || "").indexOf("Missions (97)") >= 0, "structure shows 97 missions");
  ok((ids.hexDump.innerHTML || "").length > 1000, "hex dump rendered");
  ok(!ids.problems.classList.contains("on"), "no problems after load",
    ids.problems.innerHTML.slice(0, 120));

  console.log("== symbol names ==");
  const HL = sandbox.Editor.highlight;
  ok((ids.fileBadge.innerHTML || "").indexOf("names \u2713") >= 0, "badge shows names match retail",
    ids.fileBadge.innerHTML.slice(0, 160));
  ok((ids.edRows.innerHTML || "").indexOf("data-sym=") >= 0, "rendered rows carry symbol spans");
  ok(HL("0004: SET_VAR_INT $92 250").indexOf("main_tick_ms") >= 0, "names shown by default");
  fire("btnSym", "click");
  ok(ids.btnSym.textContent === "Names: off", "toggle button flips label");
  const offHtml = HL("0004: SET_VAR_INT $92 250");
  ok(offHtml.indexOf("$92") >= 0 && offHtml.indexOf("main_tick_ms") < 0, "toggle shows raw offsets");
  fire("btnSym", "click");
  ok(HL("0004: SET_VAR_INT $92 250").indexOf("main_tick_ms") >= 0, "toggle restores names");
  ids.searchInput.value = "main_tick_ms";
  fire("searchInput", "input");
  ok(ids.searchResults.style.display === "block" &&
     ids.searchResults.innerHTML.indexOf("$92") >= 0, "search by name finds $92 lines");
  ids.searchInput.value = "";
  fire("searchInput", "input");

  console.log("== rename modal ==");
  const fakeRow = { nodeType: 1, className: "coderow", parentNode: null,
    getAttribute(k) { return k === "data-ln" ? "5" : null; } };
  const fakeSpan = { nodeType: 1, parentNode: fakeRow,
    getAttribute(k) { return k === "data-sym" ? "92" : null; } };
  fire("edRows", "click", { target: fakeSpan });
  ok(ids.symModal.style.display === "flex", "symbol click opens modal");
  ok((ids.symTitle.textContent || "").indexOf("$92") >= 0, "modal titles the offset");
  ids.symName.value = "WAIT";
  fire("symSave", "click");
  ok((ids.symErr.textContent || "").indexOf("opcode") >= 0, "opcode name rejected");
  ids.symName.value = "0bad name!";
  fire("symSave", "click");
  ok((ids.symErr.textContent || "").length > 0, "malformed name rejected");
  ids.symName.value = "tick_ms";
  fire("symSave", "click");
  ok(ids.symModal.style.display === "none", "modal closes on save");
  ok(HL("0004: SET_VAR_INT $92 250").indexOf("tick_ms") >= 0, "custom name renders");
  fire("edRows", "click", { target: fakeSpan });
  fire("symReset", "click");
  ok(HL("0004: SET_VAR_INT $92 250").indexOf("main_tick_ms") >= 0, "reset restores auto name");

  console.log("== names export/import ==");
  fire("symExport", "click");
  ok((ids.toast.textContent || "").indexOf("No custom names") >= 0, "export with none warns");
  fire("edRows", "click", { target: fakeSpan });
  ids.symName.value = "tick_ms";
  fire("symSave", "click");
  fire("symExport", "click");
  ok((ids.toast.textContent || "").indexOf("Exported 1") >= 0, "export downloads JSON",
    ids.toast.textContent.slice(0, 60));
  sandbox.FileReader = function () {
    return {
      result: null, onload: null, onerror: null,
      readAsText() {
        this.result = JSON.stringify({ version: 1, names: { 92: "tick_v2", 8: "WAIT" } });
        if (this.onload) this.onload();
      },
      readAsArrayBuffer() {}
    };
  };
  const symInput = documentStub.getElementById("fileSym");
  fire("symImport", "click");
  symInput.files = [{ name: "vcscm_names.json" }];
  symInput.onchange();
  await tick(50);
  ok(HL("0004: SET_VAR_INT $92 250").indexOf("tick_v2") >= 0, "import applies valid names");
  ok(HL("0053: CREATE_PLAYER 0 0.0 0.0 0.0 $8").indexOf(">player<") >= 0, "import skips invalid names");
  ok((ids.toast.textContent || "").indexOf("Imported 1") >= 0, "import reports counts",
    ids.toast.textContent.slice(0, 80));

  console.log("== toolbar names export/import ==");
  ok(ids.btnNamesExport.textContent === "Export names (1)", "export button shows rename count",
    "got " + JSON.stringify(ids.btnNamesExport.textContent));
  fire("btnNamesExport", "click");
  ok((ids.toast.textContent || "").indexOf("another browser or computer") >= 0,
    "export toast explains portability", ids.toast.textContent.slice(0, 90));
  function symFileReader(json) {
    sandbox.FileReader = function () {
      return {
        result: null, onload: null, onerror: null,
        readAsText() { this.result = json; if (this.onload) this.onload(); },
        readAsArrayBuffer() {}
      };
    };
  }
  symFileReader(JSON.stringify({ version: 1, app: "vcscm-names",
    forFile: { name: "main.scm", size: 1269133, fnv: "16239d9a" },
    names: { 268: "spawn_x", 92: "tick_v3" } }));
  fire("btnNamesImport", "click");
  symInput.files = [{ name: "vcscm_names.json" }];
  symInput.onchange();
  await tick(50);
  ok(HL("0004: SET_VAR_INT $268 0").indexOf("spawn_x") >= 0, "toolbar import applies names");
  ok((ids.toast.textContent || "").indexOf("Imported 2") >= 0 &&
     (ids.toast.textContent || "").indexOf("different file") < 0,
    "matching fingerprint imports quietly", ids.toast.textContent.slice(0, 100));
  ok(ids.btnNamesExport.textContent === "Export names (2)", "count updates after import");
  symFileReader(JSON.stringify({ version: 1, names: { 268: "spawn_y" },
    forFile: { name: "other.scm", size: 10, fnv: "deadbeef" } }));
  fire("btnNamesImport", "click");
  symInput.files = [{ name: "vcscm_names.json" }];
  symInput.onchange();
  await tick(50);
  ok(HL("0004: SET_VAR_INT $268 0").indexOf("spawn_y") >= 0, "foreign file names still apply");
  ok((ids.toast.textContent || "").indexOf("different file") >= 0,
    "foreign fingerprint warns", ids.toast.textContent.slice(0, 120));

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
  ids.secFilter.value = "mission";
  fire("secFilter", "input");
  ok(ids.secCount.textContent === "97 of 99 sections", "section filter narrows list",
    "got " + JSON.stringify(ids.secCount.textContent));
  ids.secFilter.value = "";
  fire("secFilter", "input");
  gotoSection("mission:0");
  ok((ids.edStatus.textContent || "").indexOf("MISSION 0") >= 0, "jumped to MISSION 0");
  fire("btnNav", "click");
  ok(documentStub.body.classList.contains("nav-open"), "nav drawer opens");
  fire("navBackdrop", "click");
  ok(!documentStub.body.classList.contains("nav-open"), "backdrop tap closes drawer");
  fire("btnNav", "click");
  gotoSection("mission:0");
  ok(!documentStub.body.classList.contains("nav-open"), "picking a section closes drawer");
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
  ids.hexDump.clientWidth = 500;
  fire("hexPage", "input");
  const narrowFirst = ids.hexDump.innerHTML.slice(0, ids.hexDump.innerHTML.indexOf("</div>"));
  const narrowCells = (narrowFirst.match(/<span class="hb/g) || []).length;
  ids.hexDump.clientWidth = 800;
  fire("hexPage", "input");
  const wideFirst = ids.hexDump.innerHTML.slice(0, ids.hexDump.innerHTML.indexOf("</div>"));
  const wideCells = (wideFirst.match(/<span class="hb/g) || []).length;
  ok(narrowCells === 8 && wideCells === 16, "hex rows adapt to width (8 vs 16 bytes)",
    "got " + narrowCells + "/" + wideCells);
  ids.misFilter.value = "bank";
  fire("misFilter", "input");
  ok(true, "mission filter did not throw");
  ids.misFilter.value = "";
  fire("misFilter", "input");

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
  const fakeMis = { dataset: { mis: "5" }, style: {}, textContent: "@MISSION_5",
    _l: {}, addEventListener(t, fn) { this._l[t] = fn; } };
  ids.structRoot.querySelectorAll = () => [fakeMis];
  fire("btnBuild", "click");
  await tick(100);
  fakeMis._l.click.call(fakeMis);
  ok((ids.edStatus.textContent || "").indexOf("MISSION 5") >= 0, "mission row opens MISSION 5");

  console.log("== build failure path ==");
  gotoSection("main");
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
  ok(ids.secCount.textContent === "99 sections", "reopened source has 99 sections",
    "got " + JSON.stringify(ids.secCount.textContent));
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
  ok(ids.secCount.textContent === "99 sections", "binary open yields 99 sections");
  ok(!ids.errBanner.classList.contains("on"), "no error banner during whole session");

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SMOKE CRASH:", e); process.exit(2); });
