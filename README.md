# pi-marimo

A [pi](https://pi.dev) package that teaches pi to work inside live [marimo](https://marimo.io) notebooks, built on marimo's `marimo pair` CLI. All marimo commands run through `uvx marimo@latest`, so you only need [uv](https://docs.astral.sh/uv/).

## Usage

Start pi already paired with a notebook (created if it doesn't exist). If all of its cells are empty, pi puts `import marimo as mo` in the first one and runs it:

```bash
pi --marimo analysis.py
```

This shows a pixel-art mossball in pi's header, starts `marimo edit --sandbox analysis.py` (it opens in your browser), waits for the notebook, and pairs pi with it. If the notebook is already running, pi reuses it. When you quit pi, any marimo servers pi started are stopped too.

Inside pi:

- `/marimo` shows the paired notebook. `/marimo other.py` opens and pairs with another one.
- The agent gets these tools:
  - `marimo_start`: open or create a notebook and pair with it
  - `marimo_list`: list running notebooks
  - `marimo_connect`: pair with a running notebook by id
  - `marimo_execute`: run Python in the paired notebook's kernel, using `marimo._code_mode` to create, edit and run cells
- marimo's pairing rules, plus the paired notebook, go into the system prompt as a `<marimo>` section.
- While pi is paired, marimo's footer shows a **pi connected** pill, the same one marimo shows for Claude Code or Codex. Clicking Disconnect there unpairs pi.

A notebook only becomes pairable once it is open in a browser. That's why pi starts marimo normally (not `--headless`).

## Layout

```
extensions/index.ts   # pi entry point: flag, tools, /marimo, prompt section
extensions/mascot.ts  # header: mossball + title/status
src/marimo.ts         # pure helpers: parse `pair list` / `pair execute`, prompt text
src/server.ts         # processes: run `marimo pair …`, start/stop `marimo edit`
src/attach.ts         # holds marimo's agent event stream open, which shows the "pi connected" pill
src/mossball.ts       # procedural pixel-art mossball (half blocks, truecolor/256)
test/                 # vitest tests for src/

```

The pi host provides `@earendil-works/*` and `typebox` at runtime, so they are
`peerDependencies` here (and `devDependencies` for types only). Never put them in `dependencies`.

## Develop

```bash
npm install
npm run check        # typecheck + tests
pi -e ./ --marimo scratch.py   # try it without installing
pi install ./        # install from this checkout; /reload in pi after edits
```
