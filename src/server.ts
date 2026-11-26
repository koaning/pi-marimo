/**
 * Process management for marimo: running `marimo pair …` commands and starting
 * `marimo edit` servers that this pi process owns.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	MARIMO_COMMAND,
	type Notebook,
	type ExecuteResult,
	SEED_CODE,
	canonicalPath,
	findNotebookByPath,
	marimoArgs,
	parseExecuteResult,
	parseNotebookList,
	withToken,
} from "./marimo.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Run `uvx marimo@latest <args>` and collect its output. Never throws on a nonzero exit. */
export function runMarimo(args: string[], options: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(MARIMO_COMMAND, marimoArgs(...args), {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			signal: options.signal,
			timeout: options.timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("`uvx` was not found on PATH. Install uv: https://docs.astral.sh/uv/"));
			} else {
				reject(error);
			}
		});
		child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
	});
}

export async function listNotebooks(options: RunOptions = {}): Promise<Notebook[]> {
	const result = await runMarimo(["pair", "list"], { timeoutMs: 60_000, ...options });
	try {
		return parseNotebookList(result.stdout);
	} catch {
		throw new Error(`marimo pair list failed: ${(result.stderr || result.stdout).trim()}`);
	}
}

// ── servers owned by this pi process ────────────────────────────────────────
// Kept on globalThis so /reload (which re-imports the extension) does not lose
// track of servers we still have to stop when pi quits.

const LOG_DIR = join(tmpdir(), "pi-marimo");
const TOKEN_DIR = join(LOG_DIR, "tokens");

/**
 * Where pi keeps the access token of the server it started for a notebook.
 * marimo reads it via --token-password-file, and any pi-marimo process can read
 * it back to build a login URL. Readable by the user only.
 */
function tokenFile(abs: string): string {
	return join(TOKEN_DIR, `${createHash("sha256").update(abs).digest("hex").slice(0, 16)}.token`);
}

function removeTokenFile(abs: string, token: string): void {
	try {
		// Only remove it if it is still ours (another pi may have restarted this notebook).
		if (readFileSync(tokenFile(abs), "utf8") === token) rmSync(tokenFile(abs));
	} catch {
		// already gone
	}
}

export interface OwnedServer {
	path: string;
	pid: number;
	logPath: string;
	token: string;
	exited: boolean;
}

const REGISTRY_KEY = Symbol.for("pi-marimo.servers");
type Registry = Map<string, OwnedServer>;

function registry(): Registry {
	const g = globalThis as { [REGISTRY_KEY]?: Registry };
	g[REGISTRY_KEY] ??= new Map();
	return g[REGISTRY_KEY];
}

export function ownedServers(): OwnedServer[] {
	return [...registry().values()];
}

/** Start `marimo edit <path>` (opens the user's browser). The server gets its own process group. */
export function startServer(path: string): OwnedServer {
	const abs = canonicalPath(path);
	const logDir = LOG_DIR;
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `${basename(abs)}-${Date.now()}.log`);
	// Pick the token ourselves, passed as a file so it never shows up in `ps`.
	// (Not stdin: --sandbox re-launches marimo with the same arguments.)
	const token = randomBytes(24).toString("base64url");
	mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(tokenFile(abs), token, { mode: 0o600 });
	const fd = openSync(logPath, "a");
	const args = marimoArgs("edit", abs, "--sandbox", "--skip-update-check", "--token-password-file", tokenFile(abs));
	const child = spawn(MARIMO_COMMAND, args, {
		cwd: join(abs, ".."),
		stdio: ["ignore", fd, fd],
		detached: true,
	});
	closeSync(fd);
	if (child.pid === undefined) throw new Error(`Could not start marimo for ${abs}`);
	const server: OwnedServer = { path: abs, pid: child.pid, logPath, token, exited: false };
	child.on("exit", () => {
		server.exited = true;
		registry().delete(abs);
		removeTokenFile(abs, token);
	});
	child.unref();
	registry().set(abs, server);
	return server;
}

export function logTail(server: OwnedServer, lines = 20): string {
	try {
		return readFileSync(server.logPath, "utf8").trim().split("\n").slice(-lines).join("\n");
	} catch {
		return "";
	}
}

/** Stop every server this pi process started. Idempotent. */
export function stopOwnedServers(): void {
	for (const server of registry().values()) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			// already gone
		}
		removeTokenFile(server.path, server.token);
	}
	registry().clear();
}

export interface OpenOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (message: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pair-ready notebook for `path`: reuse a running one, or start `marimo edit`
 * and wait until the browser has opened it (only then does `pair list` show it).
 */
export async function openNotebook(path: string, options: OpenOptions = {}): Promise<{ notebook: Notebook; started: boolean }> {
	const abs = canonicalPath(path);
	const existing = findNotebookByPath(await listNotebooks({ signal: options.signal }), abs);
	if (existing) return { notebook: existing, started: false };

	const server = registry().get(abs) ?? startServer(abs);
	options.onProgress?.(`Starting marimo for ${basename(abs)} — it will open in your browser…`);

	const deadline = Date.now() + (options.timeoutMs ?? 120_000);
	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error("Aborted while waiting for marimo");
		if (server.exited) {
			throw new Error(`marimo exited before the notebook opened. Log (${server.logPath}):\n${logTail(server)}`);
		}
		const found = findNotebookByPath(await listNotebooks({ signal: options.signal }), abs);
		if (found) return { notebook: found, started: true };
		await sleep(1000);
	}
	throw new Error(
		`Timed out waiting for ${basename(abs)} to open. marimo only becomes pairable once the notebook is open in a browser. Log (${server.logPath}):\n${logTail(server)}`,
	);
}

/** Run Python in a live notebook's kernel via `marimo pair execute`. */
export async function executeInNotebook(notebookId: string, code: string, options: RunOptions = {}): Promise<ExecuteResult> {
	const result = await runMarimo(["pair", "execute", "--notebook", notebookId, "--code", code], {
		timeoutMs: 10 * 60_000,
		...options,
	});
	return parseExecuteResult(result.stdout, result.stderr);
}

/**
 * Give a fresh notebook its `import marimo as mo` cell. Returns true when it seeded.
 * Retries briefly: the kernel can lag a moment behind `pair list`.
 */
export async function seedNotebook(notebookId: string, options: RunOptions = {}): Promise<boolean> {
	let last: ExecuteResult | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		last = await executeInNotebook(notebookId, SEED_CODE, { timeoutMs: 60_000, ...options });
		if (last.success) return (last.stdout ?? "").includes("seeded");
		await sleep(1500);
	}
	throw new Error(`Could not add the marimo import cell: ${last?.error ?? "unknown error"}`);
}

/**
 * URL that logs the browser straight into `notebook`: uses the token pi chose
 * when it started that server (in this or another pi process). For servers pi
 * did not start, returns the bare URL and marimo asks for the token.
 */
export function browserUrl(notebook: Notebook): string {
	try {
		const token = readFileSync(tokenFile(canonicalPath(notebook.path)), "utf8").trim();
		if (token) return withToken(notebook.url, token);
	} catch {
		// no token recorded
	}
	return notebook.url;
}

/** Open a URL in the user's default browser. */
export function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	const child = spawn(cmd, args, { stdio: "ignore", detached: true });
	child.on("error", () => {});
	child.unref();
}
