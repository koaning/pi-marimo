/**
 * Show up in the notebook as a connected agent ("pi connected" pill in marimo's
 * footer). marimo lists an agent for as long as it holds an event stream open on
 * the host API, the same mechanism `marimo pair connect` uses for its harnesses.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Notebook } from "./marimo.ts";

const HOST_API_PATH = "/api/marimo/v1";

interface HostRecord {
	url?: string;
	token?: string;
}

/** Host API base URL for a notebook server URL, e.g. http://127.0.0.1:2724/api/marimo/v1. */
export function hostApiUrl(notebookUrl: string): string {
	const u = new URL(notebookUrl);
	return `${u.protocol}//${u.host}${HOST_API_PATH}`;
}

/** Pick the bearer token for `apiUrl` from marimo's local host records. */
export function findHostToken(records: HostRecord[], apiUrl: string): string | undefined {
	const want = new URL(apiUrl);
	const sameHost = (h: string) => (h === "localhost" ? "127.0.0.1" : h);
	return records.find((r) => {
		if (!r.url || !r.token) return false;
		try {
			const u = new URL(r.url);
			return sameHost(u.hostname) === sameHost(want.hostname) && u.port === want.port && u.pathname === want.pathname;
		} catch {
			return false;
		}
	})?.token;
}

function readHostRecords(): HostRecord[] {
	const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "marimo", "hosts-v1");
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.flatMap((f) => {
				try {
					return [JSON.parse(readFileSync(join(dir, f), "utf8")) as HostRecord];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function hostHeaders(notebook: Notebook): Record<string, string> {
	const token = findHostToken(readHostRecords(), hostApiUrl(notebook.url));
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Ask the marimo server to open `notebook` in the user's browser. marimo adds
 * its own access token, so this works for any local server, however it was
 * started. Returns the URL it opened, or undefined if the server refused.
 */
export async function openViaHost(notebook: Notebook): Promise<string | undefined> {
	try {
		const res = await fetch(`${hostApiUrl(notebook.url)}/notebooks/${encodeURIComponent(notebook.id)}/open`, {
			method: "POST",
			headers: { ...hostHeaders(notebook), "Idempotency-Key": randomUUID() },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return undefined;
		return ((await res.json()) as { url?: string }).url ?? notebook.url;
	} catch {
		return undefined;
	}
}

export interface SseEvent {
	event: string;
	data: string;
}

/** Incremental parser for text/event-stream. Feed chunks, get complete events back. */
export class SseParser {
	private buffer = "";

	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const events: SseEvent[] = [];
		let end: number;
		while ((end = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
			const block = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end).replace(/^\r?\n\r?\n/, "");
			let event = "message";
			const data: string[] = [];
			for (const line of block.split(/\r?\n/)) {
				if (line.startsWith(":")) continue;
				const [field, ...rest] = line.split(":");
				const value = rest.join(":").replace(/^ /, "");
				if (field === "event") event = value;
				else if (field === "data") data.push(value);
			}
			if (data.length) events.push({ event, data: data.join("\n") });
		}
		return events;
	}
}

export interface AttachOptions {
	/** Name shown in marimo's pill, e.g. "pi". */
	name: string;
	/** Stable per pi process, so reconnects replace rather than add. */
	identity: string;
	/** Called when marimo confirms the attachment, and again after each reconnect. */
	onAttached?: () => void;
	/** Called when an established stream drops (e.g. marimo stopped). attach() keeps retrying. */
	onDropped?: () => void;
	/** Called when the user clicks Disconnect in marimo. The attachment stops. */
	onDetachedByUser?: () => void;
	/** First retry delay; doubles up to 15s. */
	retryDelayMs?: number;
}

/** Keep pi attached to `notebook` until stop() is called. Reconnects if the stream drops. */
export function attach(notebook: Notebook, options: AttachOptions): { stop: () => void } {
	let stopped = false;
	let controller: AbortController | undefined;
	let attachmentId: string | undefined;
	/** True between marimo confirming the attachment and the stream dropping. */
	let live = false;
	const firstDelay = options.retryDelayMs ?? 1000;

	const run = async () => {
		let delay = firstDelay;
		while (!stopped) {
			const apiUrl = hostApiUrl(notebook.url);
			const token = findHostToken(readHostRecords(), apiUrl);
			controller = new AbortController();
			try {
				const headers: Record<string, string> = {
					Accept: "text/event-stream",
					"Marimo-Attachment-Identity": options.identity,
					"Marimo-Attachment-Kind": "agent",
					"Marimo-Attachment-Name": options.name,
				};
				if (token) headers.Authorization = `Bearer ${token}`;
				const url = `${apiUrl}/notebooks/${encodeURIComponent(notebook.id)}/events?kinds=custom,attachment`;
				const res = await fetch(url, { headers, signal: controller.signal });
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				const parser = new SseParser();
				const decoder = new TextDecoder();
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) {
						if (ev.event === "attachment") {
							const a = (JSON.parse(ev.data) as { attachment?: { id?: string; identity?: string } }).attachment;
							if (a?.identity === options.identity && a.id) {
								attachmentId = a.id;
								delay = firstDelay;
								if (!live) {
									live = true;
									options.onAttached?.();
								}
							}
						} else if (ev.event === "attachment.removed") {
							const removed = (JSON.parse(ev.data) as { id?: string }).id;
							if (removed && removed === attachmentId) {
								stopped = true;
								controller.abort();
								options.onDetachedByUser?.();
								return;
							}
						}
					}
				}
			} catch {
				// stream dropped or server not reachable; retry below
			}
			if (stopped) return;
			if (live) {
				live = false;
				options.onDropped?.();
			}
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * 2, 15_000);
		}
	};
	void run();

	return {
		stop() {
			stopped = true;
			controller?.abort();
		},
	};
}
