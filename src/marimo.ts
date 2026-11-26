/**
 * Pure helpers around the `marimo pair` CLI. Nothing in here spawns processes,
 * so it can be unit tested without marimo or pi.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Every marimo invocation goes through `uvx marimo@latest`. */
export const MARIMO_COMMAND = "uvx";
export const MARIMO_PREFIX = ["marimo@latest"];

export function marimoArgs(...args: string[]): string[] {
	return [...MARIMO_PREFIX, ...args];
}

export interface Notebook {
	id: string;
	name: string;
	path: string;
	url: string;
	status: string;
}

/** Parse the JSON printed by `marimo pair list`. */
export function parseNotebookList(stdout: string): Notebook[] {
	const data = JSON.parse(stdout) as { notebooks?: unknown };
	if (!Array.isArray(data.notebooks)) return [];
	return data.notebooks.filter(
		(n): n is Notebook =>
			typeof n === "object" && n !== null && typeof (n as Notebook).id === "string" && typeof (n as Notebook).path === "string",
	);
}

/**
 * Resolve a path and follow symlinks (macOS /tmp → /private/tmp). For a file that
 * doesn't exist yet, resolve its directory instead, so the result stays the same
 * once marimo creates the file.
 */
export function canonicalPath(path: string, cwd: string = process.cwd()): string {
	const abs = resolve(cwd, path);
	try {
		return realpathSync(abs);
	} catch {
		try {
			return join(realpathSync(dirname(abs)), basename(abs));
		} catch {
			return abs;
		}
	}
}

export function findNotebookByPath(notebooks: Notebook[], path: string, cwd?: string): Notebook | undefined {
	const target = canonicalPath(path, cwd);
	return notebooks.find((n) => canonicalPath(n.path) === target);
}

export interface ExecuteResult {
	success: boolean;
	error?: string | null;
	next?: string | null;
	output?: unknown;
	stdout?: string | null;
	stderr?: string | null;
}

/** Parse the JSON printed by `marimo pair execute`. Falls back to raw text. */
export function parseExecuteResult(stdout: string, stderr = ""): ExecuteResult {
	try {
		const data = JSON.parse(stdout) as ExecuteResult;
		if (typeof data === "object" && data !== null && "success" in data) return data;
	} catch {
		// not JSON, handled below
	}
	return { success: false, error: (stderr || stdout).trim() || "marimo pair execute produced no output" };
}

const MAX_OUTPUT_CHARS = 40_000;

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

/** Turn an execute result into the text the model sees. */
export function formatExecuteResult(result: ExecuteResult): string {
	const parts: string[] = [];
	if (!result.success) parts.push(`error: ${result.error ?? "unknown error"}`);
	if (result.next) parts.push(`next: ${result.next}`);
	if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
	if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
	if (result.output !== undefined && result.output !== null) {
		const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
		parts.push(`output:\n${output}`);
	}
	if (parts.length === 0) parts.push("ok (no output)");
	return clip(parts.join("\n\n"));
}

/** System prompt section describing how to work with marimo, and the paired notebook if any. */
export function promptSection(notebook: Notebook | undefined): string {
	const lines = [
		"You can work inside live marimo notebooks through the marimo_* tools.",
		"- marimo_start opens (or creates) a notebook file in the user's browser and pairs with it. marimo_list shows running notebooks; marimo_connect pairs with one of them.",
		"- marimo_execute runs Python inside the paired notebook's kernel. Use `import marimo._code_mode as cm` and `async with cm.get_context() as ctx:` to inspect and change cells.",
		"- Cells are the unit of work. Code run outside code mode is a temporary scratchpad; only code-mode edits persist.",
		"- ctx.cells has .id .code .status .errors .console_outputs. Use ctx.create_cell(code), ctx.edit_cell(cid, code), ctx.run_cell(cid), ctx.delete_cell(cid).",
		"- Cells do not run on creation: call ctx.run_cell after create_cell or edit_cell. Do not await ctx methods.",
		"- If an empty cell exists, edit it instead of creating a new one. Ask before deleting cells; delete_cell drops the cell's variables.",
		'- Install packages with ctx.packages.add("pkg"), never pip or uv add, and confirm first if the user did not ask for it.',
		"- Never edit the notebook .py file directly while it is open; code mode is the only write path.",
		"- For more guidance run `uvx marimo@latest pair docs <topic>` (topics: gotchas, notebook-improvements, rich-representations).",
		"- Whenever you start or connect to a notebook, say in your text reply that it is running and give its full URL (as returned by the tool). The user may not see tool output, e.g. over ACP.",
	];
	if (notebook) {
		lines.push("", `Paired notebook: ${notebook.path} (id ${notebook.id}, ${notebook.url}). marimo_execute targets it by default.`);
	} else {
		lines.push("", "No notebook is paired yet.");
	}
	return lines.join("\n");
}

/** Sentence asking the agent to repeat the URL in its reply, for clients that hide tool output. */
export function tellUserNote(url: string): string {
	return `Tell the user in your reply that the notebook is running at ${url}. Give the full URL in text, not only in a tool call: some clients (e.g. over ACP) don't show tool output.`;
}

/** Text `marimo_start` returns to the model. `url` is the full (login) URL. */
export function startResultText(options: { notebook: Notebook; url: string; started: boolean; seeded: boolean }): string {
	const { notebook, url, started, seeded } = options;
	const lines = [
		`${started ? "Started" : "Already running"}: ${notebook.path}`,
		`notebook id: ${notebook.id}`,
		`url: ${url}`,
		"Paired; marimo_execute now targets it.",
	];
	if (seeded) lines.push("The notebook was empty, so its first cell now has `import marimo as mo` (already run).");
	lines.push("", tellUserNote(url));
	return lines.join("\n");
}

/**
 * Code-mode snippet run right after pairing: if every cell is empty (a fresh
 * notebook), put `import marimo as mo` in the first one and run it.
 * Prints "seeded" or "skipped".
 */
export const SEED_CODE = `import marimo._code_mode as cm
async with cm.get_context() as ctx:
    cells = list(ctx.cells.values())
    if any(c.code.strip() for c in cells):
        print("skipped")
    else:
        cid = cells[0].id if cells else None
        if cid is None:
            cid = ctx.create_cell("import marimo as mo")
        else:
            ctx.edit_cell(cid, "import marimo as mo")
        ctx.run_cell(cid)
        print("seeded")
`;

/** Add marimo's `access_token` query parameter to a server URL. */
export function withToken(url: string, token: string): string {
	const u = new URL(url);
	u.searchParams.set("access_token", token);
	return u.toString();
}

/** The login URL marimo prints at startup (`URL: http://localhost:2718?access_token=…`). */
export function parseServerUrl(log: string): string | undefined {
	// Strip ANSI escapes in case marimo colored its output.
	const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
	return plain.match(/URL:\s*(https?:\/\/\S+)/)?.[1];
}

/** Whether to start notebooks with `--sandbox`. On unless PI_MARIMO_SANDBOX is 0/false/no/off. */
export function sandboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env.PI_MARIMO_SANDBOX?.trim().toLowerCase();
	return !value || !["0", "false", "no", "off"].includes(value);
}
