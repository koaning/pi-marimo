# Changelog

## [0.1.0]

- `pi --marimo <file.py>`: start (or reuse) a marimo notebook in the browser and pair with it.
- Tools: `marimo_start`, `marimo_list`, `marimo_connect`, `marimo_execute`.
- `/marimo [file.py]` command, footer status, and a pixel-art mossball header.
- Empty notebooks get an `import marimo as mo` cell (via code mode) when pi pairs with them.
- marimo shows a "pi connected" pill while pi is paired; Disconnect in marimo unpairs pi.
