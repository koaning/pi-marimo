# Changelog

## [0.1.1]

- `/marimo open | list | disconnect | stop`, plus tab completion for subcommands and `.py` files.
- The footer shows `connection lost` when marimo stops, and `not running` when a resumed session's notebook is gone. `marimo_execute` says so too, instead of passing on a raw CLI error.
- While waiting for the browser, pi shows the notebook's login URL (for SSH and other headless setups).
- `PI_MARIMO_SANDBOX=0` turns off `--sandbox`.
- After starting or connecting to a notebook, the agent states its full URL in its reply, for clients that don't show tool calls (e.g. ACP).
- Fix: a server started for a notebook that didn't exist yet can now be found again (and stopped) on macOS, where `/tmp` is a symlink.

## [0.1.0]

- `pi --marimo <file.py>`: start (or reuse) a marimo notebook in the browser and pair with it.
- Tools: `marimo_start`, `marimo_list`, `marimo_connect`, `marimo_execute`.
- `/marimo [file.py]` command, footer status, and a pixel-art mossball header.
- Empty notebooks get an `import marimo as mo` cell (via code mode) when pi pairs with them.
- marimo shows a "pi connected" pill while pi is paired; Disconnect in marimo unpairs pi.
