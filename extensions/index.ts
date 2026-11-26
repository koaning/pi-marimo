import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type Notebook, formatExecuteResult, promptSection, startResultText, tellUserNote } from "../src/marimo.ts";
import {
	browserUrl,
	executeInNotebook,
	listNotebooks,
	openBrowser,
	openNotebook,
	seedNotebook,
	stopOwnedServers,
	stopServer,
} from "../src/server.ts";
import { attach, openViaHost } from "../src/attach.ts";
import { showMascotHeader } from "./mascot.ts";

const ENTRY_TYPE = "pi-marimo";
const STATUS_ID = "pi-marimo";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** How pi's link to the paired notebook looks right now. */
type Link = "connecting" | "connected" | "lost" | "not running";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "open", label: "open", description: "Reopen the paired notebook in the browser (restarts it if it stopped)" },
	{ value: "list", label: "list", description: "Pick a running notebook to pair with" },
	{ value: "disconnect", label: "disconnect", description: "Unpair pi from the notebook" },
	{ value: "stop", label: "stop", description: "Stop the marimo server pi started, and unpair" },
];

/** `.py` files and directories under the typed path, for `/marimo <file.py>`. */
function pathCompletions(prefix: string): AutocompleteItem[] {
	const dir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
	const base = prefix.slice(dir.length);
	try {
		return readdirSync(resolve(process.cwd(), dir || "."), { withFileTypes: true })
			.filter((e) => !e.name.startsWith(".") && e.name.startsWith(base) && (e.isDirectory() || e.name.endsWith(".py")))
			.slice(0, 50)
			.map((e) => {
				const value = `${dir}${e.name}${e.isDirectory() ? "/" : ""}`;
				return { value, label: value };
			});
	} catch {
		return [];
	}
}

const notebookLabel = (n: Notebook) => `${n.path} (${n.url})`;

export default function (pi: ExtensionAPI) {
	let paired: Notebook | undefined;
	let link: Link = "connecting";
	let state = "no notebook paired";
	/** Pairing started by --marimo; agent runs and tools wait for it. */
	let pending: Promise<void> | undefined;
	let refreshHeader = () => {};
	let currentCtx: ExtensionContext | undefined;
	/** Event stream that makes marimo show the "pi connected" pill. */
	let attachment: { stop: () => void } | undefined;

	function setState(next: string) {
		state = next;
		currentCtx?.ui.setStatus(STATUS_ID, `🌱 ${next}`);
		refreshHeader();
	}

	function pairedState() {
		if (!paired) return "no notebook paired";
		const suffix = link === "connecting" ? "" : ` · ${link}`;
		return `${basename(paired.path)} · ${paired.url}${suffix}`;
	}

	function setLink(next: Link) {
		link = next;
		setState(pairedState());
	}

	function connectPill(notebook: Notebook) {
		attachment?.stop();
		link = "connecting";
		attachment = attach(notebook, {
			name: "pi",
			identity: `pi:${process.pid}`,
			onAttached: () => setLink("connected"),
			onDropped: () => {
				setLink("lost");
				currentCtx?.ui.notify(
					`pi-marimo: lost the connection to ${basename(notebook.path)}. If marimo stopped, \`/marimo open\` restarts it.`,
					"warning",
				);
			},
			onDetachedByUser: () => {
				attachment = undefined;
				paired = undefined;
				pi.appendEntry(ENTRY_TYPE, { notebook: null });
				setState("disconnected from marimo");
				currentCtx?.ui.notify(`pi-marimo: ${basename(notebook.path)} disconnected pi in the browser`, "warning");
			},
		});
	}

	function pair(notebook: Notebook) {
		paired = notebook;
		pi.appendEntry(ENTRY_TYPE, { notebook });
		connectPill(notebook);
		setState(pairedState());
	}

	/** Forget the paired notebook. The pill disappears once the event stream closes. */
	function unpair(message = "no notebook paired") {
		attachment?.stop();
		attachment = undefined;
		paired = undefined;
		pi.appendEntry(ENTRY_TYPE, { notebook: null });
		setState(message);
	}

	async function isRunning(notebook: Notebook, signal?: AbortSignal): Promise<boolean> {
		return (await listNotebooks({ signal })).some((n) => n.id === notebook.id);
	}

	async function open(path: string, signal?: AbortSignal, onProgress?: (message: string) => void) {
		setState(`opening ${basename(path)}…`);
		try {
			const { notebook, started } = await openNotebook(path, {
				signal,
				onProgress: (message) => {
					setState(message);
					onProgress?.(message);
				},
			});
			// A freshly started server opens the browser itself; a reused one doesn't,
			// so open it here unless this session is already paired with it.
			if (!started && paired?.id !== notebook.id) reopenBrowser(notebook);
			pair(notebook);
			const seeded = await seedNotebook(notebook.id, { signal }).catch((error: Error) => {
				currentCtx?.ui.notify(`pi-marimo: ${error.message}`, "warning");
				return false;
			});
			return { notebook, started, seeded };
		} catch (error) {
			setState(pairedState());
			throw error;
		}
	}

	function reopenBrowser(notebook: Notebook) {
		void openViaHost(notebook).then((url) => {
			if (!url) openBrowser(browserUrl(notebook));
		});
	}

	pi.registerFlag("marimo", {
		type: "string",
		description: "Open a marimo notebook (created if missing) in the browser and pair pi with it",
	});

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		paired = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { notebook?: Notebook | null } | undefined;
				if (data && "notebook" in data) paired = data.notebook ?? undefined;
			}
		}
		if (paired) {
			setLink("connecting");
			// Resumed or reloaded session: reconnect the pill if the notebook is still running.
			const restored = paired;
			void isRunning(restored)
				.then((running) => {
					if (paired !== restored) return;
					if (running) {
						connectPill(restored);
					} else {
						setLink("not running");
						ctx.ui.notify(`pi-marimo: ${basename(restored.path)} is no longer running. \`/marimo open\` restarts it.`, "warning");
					}
				})
				.catch(() => {});
		}

		const flag = pi.getFlag("marimo");
		if (typeof flag === "string" && flag.trim()) {
			refreshHeader = showMascotHeader(ctx, () => state);
			if (event.reason === "startup") {
				// Don't block startup on the browser; agent runs await `pending` instead.
				pending = open(flag.trim()).then(
					() => ctx.ui.notify(`Paired with ${basename(flag)}`, "info"),
					(error: Error) => ctx.ui.notify(`pi-marimo: ${error.message}`, "error"),
				);
			}
		}
	});

	pi.on("session_shutdown", async (event) => {
		attachment?.stop();
		attachment = undefined;
		if (event.reason === "quit") stopOwnedServers();
	});

	pi.on("before_agent_start", async (event) => {
		await pending;
		event.systemPromptOptions.sections.marimo = promptSection(paired);
	});

	pi.registerTool({
		name: "marimo_list",
		label: "marimo list",
		description: "List running marimo notebooks (id, path, url) that can be paired with.",
		promptSnippet: "List running marimo notebooks",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const notebooks = await listNotebooks({ signal });
			const lines = notebooks.map(
				(n) => `${n.id}  ${n.path}  ${n.url}  ${n.status}${paired?.id === n.id ? "  (paired)" : ""}`,
			);
			return { content: text(lines.join("\n") || "No running marimo notebooks."), details: { notebooks } };
		},
	});

	pi.registerTool({
		name: "marimo_start",
		label: "marimo start",
		description:
			"Open a marimo notebook file in the user's browser (creating it if it does not exist) and pair with it. Reuses the notebook if it is already running. Waits until the notebook is open.",
		promptSnippet: "Start or open a marimo notebook and pair with it",
		promptGuidelines: [
			"Use marimo_start when the user wants to create, open, or start a marimo notebook; do not run `marimo edit` through bash.",
			"After marimo_start succeeds, always tell the user in plain text that the notebook is running, with its full URL.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Notebook .py file, relative to the working directory" }),
		}),
		async execute(_id, params, signal, onUpdate) {
			await pending;
			const { notebook, started, seeded } = await open(params.path, signal, (message) =>
				onUpdate?.({ content: text(message), details: undefined }),
			);
			const url = browserUrl(notebook);
			return {
				content: text(startResultText({ notebook, url, started, seeded })),
				details: { notebook, url, started, seeded },
			};
		},
	});

	pi.registerTool({
		name: "marimo_connect",
		label: "marimo connect",
		description: "Pair with an already running marimo notebook by id (see marimo_list).",
		promptSnippet: "Pair with a running marimo notebook",
		parameters: Type.Object({
			notebook: Type.String({ description: "Notebook id from marimo_list" }),
		}),
		async execute(_id, params, signal) {
			const notebook = (await listNotebooks({ signal })).find((n) => n.id === params.notebook);
			if (!notebook) throw new Error(`No running notebook with id ${params.notebook}. Use marimo_list.`);
			pair(notebook);
			const url = browserUrl(notebook);
			return { content: text(`Paired with ${notebook.path} (${url}).\n\n${tellUserNote(url)}`), details: { notebook, url } };
		},
	});

	pi.registerTool({
		name: "marimo_execute",
		label: "marimo execute",
		description:
			"Run Python inside the paired marimo notebook's kernel (or the given notebook id). Use marimo._code_mode to read, create, edit and run cells.",
		promptSnippet: "Run Python in the paired marimo notebook's kernel",
		promptGuidelines: [
			"Use marimo_execute for all work inside a marimo notebook instead of `marimo pair execute` via bash or editing the notebook file.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Python code; may be multiline" }),
			notebook: Type.Optional(Type.String({ description: "Notebook id; defaults to the paired notebook" })),
		}),
		async execute(_id, params, signal) {
			await pending;
			const target = params.notebook ?? paired?.id;
			if (!target) throw new Error("No marimo notebook is paired. Use marimo_start or marimo_connect first.");
			const result = await executeInNotebook(target, params.code, { signal });
			const output = formatExecuteResult(result);
			if (!result.success) {
				// When pi's link to the paired notebook isn't healthy, say whether the notebook is gone
				// rather than passing on the CLI's error. (Skipped while connected: most failures are Python errors.)
				const notebook = paired?.id === target ? paired : undefined;
				if (notebook && link !== "connected" && !(await isRunning(notebook, signal).catch(() => true))) {
					setLink("not running");
					throw new Error(
						`The paired notebook ${notebook.path} is not running any more. Call marimo_start with that path to restart it, or ask the user to run \`/marimo open\`.`,
					);
				}
				throw new Error(output);
			}
			return { content: text(output), details: { result } };
		},
	});

	pi.registerCommand("marimo", {
		description: "Paired marimo notebook: `/marimo <file.py>` to open one, or open | list | disconnect | stop",
		getArgumentCompletions: (prefix) => {
			const items = [...SUBCOMMANDS.filter((s) => s.value.startsWith(prefix)), ...pathCompletions(prefix)];
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			const notify = (message: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, type);
			const fail = (error: unknown) => notify(`pi-marimo: ${(error as Error).message}`, "error");

			if (!arg) {
				notify(
					paired
						? `Paired with ${notebookLabel(paired)}${link === "connecting" ? "" : ` · ${link}`}. Try /marimo open | list | disconnect | stop.`
						: "No marimo notebook paired. Use /marimo <file.py> or /marimo list.",
				);
				return;
			}

			if (arg === "open") {
				if (!paired) return notify("No marimo notebook paired. Use /marimo <file.py>.", "warning");
				try {
					if (await isRunning(paired)) {
						reopenBrowser(paired);
						notify(`Opening ${notebookLabel(paired)}`);
					} else {
						const { notebook } = await open(paired.path);
						notify(`Restarted and paired with ${notebookLabel(notebook)}`);
					}
				} catch (error) {
					fail(error);
				}
				return;
			}

			if (arg === "list") {
				try {
					const notebooks = await listNotebooks();
					if (!notebooks.length) return notify("No running marimo notebooks. Use /marimo <file.py> to start one.");
					if (!ctx.hasUI) return notify(notebooks.map((n) => `${n.id}  ${notebookLabel(n)}`).join("\n"));
					const labels = notebooks.map((n) => `${paired?.id === n.id ? "● " : ""}${notebookLabel(n)}`);
					const choice = await ctx.ui.select("Pair with a running marimo notebook", labels);
					const notebook = choice === undefined ? undefined : notebooks[labels.indexOf(choice)];
					if (!notebook || notebook.id === paired?.id) return;
					pair(notebook);
					notify(`Paired with ${notebookLabel(notebook)}`);
				} catch (error) {
					fail(error);
				}
				return;
			}

			if (arg === "disconnect") {
				if (!paired) return notify("No marimo notebook paired.");
				const path = paired.path;
				unpair();
				notify(`Unpaired from ${basename(path)}. The notebook keeps running.`);
				return;
			}

			if (arg === "stop") {
				if (!paired) return notify("No marimo notebook paired.");
				const path = paired.path;
				if (!stopServer(path)) {
					return notify(`pi didn't start the server for ${basename(path)}; stop it where it runs, or use /marimo disconnect.`, "warning");
				}
				unpair(`stopped ${basename(path)}`);
				notify(`Stopped marimo for ${basename(path)}.`);
				return;
			}

			try {
				const { notebook } = await open(arg);
				notify(`Paired with ${notebookLabel(notebook)}`);
			} catch (error) {
				fail(error);
			}
		},
	});
}
