# VC SCM Studio — Vice City script editor

A static, dependency-free **GTA: Vice City (PC) `main.scm` editor** that runs entirely in
the browser. Open a retail SCM, browse it as readable assembly, edit it, re-assemble it,
and save the game-ready file back — no build step, no server.

## Run it

Host the folder as-is on **GitHub Pages** (Settings → Pages → Deploy from branch), or
serve it locally for development:

```sh
python3 -m http.server 8080
# open http://localhost:8080/
```

> `file://` works for everything except the *Load bundled main.scm* button (browsers
> block `fetch` of local files) — use *Open .scm* instead in that case.

## Features

- **Disassembler** — the bundled retail `main.scm` (1,269,133 bytes, 97 missions) becomes
  ~175,000 lines of sectioned source (HEADER / MAIN / MISSION) with auto-named labels.
- **Assembler** — round-trips the retail file byte-identically (except zeroed text-label
  padding); enforces engine budgets (225,512-byte main block, 35,000-byte missions).
- **Code view** — virtualized, syntax-highlighted listing that stays fast at 175k lines;
  in-place editing, global search, click-an-error-to-jump problem list.
- **Editing aids** — autocomplete for opcodes, `$globals`, `@labels` and `#models`,
  per-line opcode signature hints with did-you-mean, live gutter error marking,
  click-a-label-to-jump, code snippets, go-to-line.
- **Symbol names** — all 8,480 globals get friendly names (`player_char`,
  `mission_flag`, `main_tick_ms`) instead of raw `$offsets`: color-coded by kind
  (constant, handle, flag, coordinate, …), hover for read/write stats, click to
  rename. Your names stay in the browser (exportable JSON); editing and
  assembling still use `$offsets`.
- **Structure view** — file layout, engine budget bars, global-variable census, clickable
  mission table, level-model list.
- **Opcodes view** — searchable 1,424-command database with per-argument types, enums and
  rules, plus one-click template insertion.
- **Hex view** — paged hex dump of the loaded or assembled binary by file region.
- **Guide view** — built-in workflow and language reference.

## Tests

```sh
node test/run_tests.js   # engine + symbols — 143 tests
node test/smoke_ui.js    # headless UI: drives the real app against main.scm — 107 tests
```

## Layout

| Path | What it is |
|---|---|
| `index.html` | app shell + built-in guide |
| `css/style.css` | dark neon theme |
| `js/opcodes.js` | generated opcode database (do not edit) |
| `js/scm.js` | DOM-free engine: header/disassembler/assembler/reference API |
| `js/editor.js` | syntax highlighting + virtualized code component |
| `js/symbols.js` | generated global symbol table (do not edit) |
| `js/app.js` | browser wiring: views, assembly flow, problems, downloads |
| `tools/build_db.py` | regenerates `js/opcodes.js` from `tools/ref/` |
| `tools/build_symbols.js` | regenerates `js/symbols.js` from `main.scm` |
| `tools/ref/` | database inputs (gta3sc gtavc XMLs + licence) |
| `test/` | engine tests + headless UI smoke test |
| `main.scm` | retail Vice City PC script (bundled test target) |

## References

- [SCM language reference (GTAMods Wiki)](https://gtamods.com/wiki/SCM_language)
- [gta3sc](https://github.com/thelink2012/gta3sc) — opcode database source (MIT)
- [reVC](https://github.com/mrxenginner/reVC) — engine behaviour reference
