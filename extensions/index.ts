import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename } from "node:path";
import { type Notebook, formatExecuteResult, promptSection } from "../src/marimo.ts";
import {
	browserUrl,
	executeInNotebook,
	listNotebooks,
	openBrowser,
	openNotebook,
	seedNotebook,
	stopOwnedServers,
} from "../src/server.ts";
import { attach, openViaHost } from "../src/attach.ts";
import { showMascotHeader } from "./mascot.ts";

const ENTRY_TYPE = "pi-marimo";
const STATUS_ID = "pi-marimo";

const text = (value: string) => [{ type: "text" as const, text: value }];

export default function (pi: ExtensionAPI) {
	let paired: Notebook | undefined;
	let state = "no notebook paired";
	/** Pairing started by --marimo; agent runs and tools wait for it. */
	let pending: Promise<void> | undefined;
	let refreshHeader = () => {};
	let currentCtx: ExtensionContext | undefined;
	/** Event stream that makes marimo show the "pi connected" pill. */
	let attachment: { stop: () => void } | undefined;
	let connected = false;

	function setState(next: string) {
		state = next;
		currentCtx?.ui.setStatus(STATUS_ID, `🌱 ${next}`);
		refreshHeader();
	}

	function pairedState() {
		if (!paired) return "no notebook paired";
		return `${basename(paired.path)} · ${paired.url}${connected ? " · connected" : ""}`;
	}

	function connectPill(notebook: Notebook) {
		attachment?.stop();
		connected = false;
		attachment = attach(notebook, {
			name: "pi",
			identity: `pi:${process.pid}`,
			onAttached: () => {
				connected = true;
				setState(pairedState());
			},
			onDetachedByUser: () => {
				attachment = undefined;
				connected = false;
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
			if (!started && paired?.id !== notebook.id) {
				void openViaHost(notebook).then((url) => {
					if (!url) openBrowser(browserUrl(notebook));
				});
			}
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
			setState(pairedState());
			// Resumed or reloaded session: reconnect the pill if the notebook is still running.
			const restored = paired;
			void listNotebooks()
				.then((notebooks) => {
					if (paired === restored && notebooks.some((n) => n.id === restored.id)) connectPill(restored);
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
		],
		parameters: Type.Object({
			path: Type.String({ description: "Notebook .py file, relative to the working directory" }),
		}),
		async execute(_id, params, signal, onUpdate) {
			await pending;
			const { notebook, started, seeded } = await open(params.path, signal, (message) =>
				onUpdate?.({ content: text(message), details: undefined }),
			);
			const how = started ? "Started" : "Already running";
			const seedNote = seeded ? "\nThe notebook was empty, so its first cell now has `import marimo as mo` (already run)." : "";
			return {
				content: text(`${how}: ${notebook.path}\nnotebook id: ${notebook.id}\nurl: ${notebook.url}\nPaired; marimo_execute now targets it.${seedNote}`),
				details: { notebook, started, seeded },
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
			return { content: text(`Paired with ${notebook.path} (${notebook.url}).`), details: { notebook } };
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
			if (!result.success) throw new Error(output);
			return { content: text(output), details: { result } };
		},
	});

	pi.registerCommand("marimo", {
		description: "Show the paired marimo notebook, or `/marimo <file.py>` to open and pair with one",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) {
				ctx.ui.notify(paired ? `Paired with ${paired.path} (${paired.url})` : "No marimo notebook paired.", "info");
				return;
			}
			try {
				const { notebook } = await open(path);
				ctx.ui.notify(`Paired with ${notebook.path} (${notebook.url})`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-marimo: ${(error as Error).message}`, "error");
			}
		},
	});
}
