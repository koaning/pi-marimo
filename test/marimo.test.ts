import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canonicalPath,
	findNotebookByPath,
	formatExecuteResult,
	withToken,
	marimoArgs,
	parseExecuteResult,
	parseNotebookList,
	parseServerUrl,
	promptSection,
	sandboxEnabled,
	startResultText,
	type Notebook,
} from "../src/marimo.ts";

const LIST_OUTPUT = JSON.stringify({
	notebooks: [
		{ id: "nb-a", name: "a", path: "/work/a.py", url: "http://127.0.0.1:2718", status: "running" },
		{ id: "nb-b", name: "b", path: "/work/sub/b.py", url: "http://127.0.0.1:2719", status: "running" },
		{ bogus: true },
	],
	warnings: ["Could not list notebooks on http://127.0.0.1:61182/api/marimo/v1."],
});

describe("marimoArgs", () => {
	it("always goes through marimo@latest", () => {
		expect(marimoArgs("pair", "list")).toEqual(["marimo@latest", "pair", "list"]);
	});
});

describe("parseNotebookList", () => {
	it("keeps well-formed notebooks and drops junk", () => {
		expect(parseNotebookList(LIST_OUTPUT).map((n) => n.id)).toEqual(["nb-a", "nb-b"]);
	});

	it("returns [] when there is no notebooks array", () => {
		expect(parseNotebookList("{}")).toEqual([]);
	});

	it("throws on non-JSON so callers can surface stderr", () => {
		expect(() => parseNotebookList("boom")).toThrow();
	});
});

describe("findNotebookByPath", () => {
	const notebooks = parseNotebookList(LIST_OUTPUT);

	it("matches relative paths against the cwd", () => {
		expect(findNotebookByPath(notebooks, "sub/b.py", "/work")?.id).toBe("nb-b");
	});

	it("returns undefined when nothing matches", () => {
		expect(findNotebookByPath(notebooks, "c.py", "/work")).toBeUndefined();
	});

	it("follows symlinks", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-marimo-test-"));
		const real = join(dir, "real.py");
		writeFileSync(real, "");
		symlinkSync(real, join(dir, "link.py"));
		const nb: Notebook = { id: "nb-l", name: "real", path: real, url: "u", status: "running" };
		expect(findNotebookByPath([nb], join(dir, "link.py"))?.id).toBe("nb-l");
	});

	it("gives a missing file the same path it will have once created", () => {
		const real = mkdtempSync(join(tmpdir(), "pi-marimo-test-"));
		const linked = `${real}-link`;
		symlinkSync(real, linked);
		const before = canonicalPath(join(linked, "new.py"));
		writeFileSync(join(real, "new.py"), "");
		expect(before).toBe(canonicalPath(join(linked, "new.py")));
	});
});

describe("execute results", () => {
	it("parses marimo's JSON result", () => {
		const result = parseExecuteResult(JSON.stringify({ success: true, stdout: "hi\n", stderr: null, output: null }));
		expect(result.success).toBe(true);
		expect(formatExecuteResult(result)).toBe("stdout:\nhi\n");
	});

	it("falls back to stderr when stdout is not JSON", () => {
		const result = parseExecuteResult("", "Error: no notebook");
		expect(result).toEqual({ success: false, error: "Error: no notebook" });
		expect(formatExecuteResult(result)).toBe("error: Error: no notebook");
	});

	it("includes the next-step hint on failure", () => {
		const text = formatExecuteResult({ success: false, error: "No running notebook", next: "open it" });
		expect(text).toContain("error: No running notebook");
		expect(text).toContain("next: open it");
	});

	it("says ok when there is nothing to show", () => {
		expect(formatExecuteResult({ success: true })).toBe("ok (no output)");
	});

	it("truncates huge output", () => {
		const text = formatExecuteResult({ success: true, stdout: "x".repeat(50_000) });
		expect(text.length).toBeLessThan(41_000);
		expect(text).toContain("[truncated");
	});
});

describe("promptSection", () => {
	it("names the paired notebook", () => {
		const nb: Notebook = { id: "nb-a", name: "a", path: "/work/a.py", url: "http://x", status: "running" };
		expect(promptSection(nb)).toContain("Paired notebook: /work/a.py (id nb-a");
	});

	it("says when nothing is paired", () => {
		expect(promptSection(undefined)).toContain("No notebook is paired yet.");
	});

	it("asks the agent to state the full URL in its reply", () => {
		expect(promptSection(undefined)).toContain("give its full URL");
	});
});

describe("startResultText", () => {
	const nb: Notebook = { id: "nb-a", name: "a", path: "/work/a.py", url: "http://127.0.0.1:2718", status: "running" };
	const url = "http://127.0.0.1:2718/?access_token=tok";

	it("gives the full URL and asks the agent to repeat it", () => {
		const out = startResultText({ notebook: nb, url, started: true, seeded: false });
		expect(out).toContain(`url: ${url}`);
		expect(out).toContain(`the notebook is running at ${url}`);
		expect(out.startsWith("Started: /work/a.py")).toBe(true);
		expect(out).not.toContain("import marimo as mo");
	});

	it("says when the notebook was already running, and when it was seeded", () => {
		const out = startResultText({ notebook: nb, url, started: false, seeded: true });
		expect(out.startsWith("Already running: /work/a.py")).toBe(true);
		expect(out).toContain("import marimo as mo");
	});
});

describe("withToken", () => {
	it("adds the access token", () => {
		expect(withToken("http://127.0.0.1:2724", "abc-_123")).toBe("http://127.0.0.1:2724/?access_token=abc-_123");
	});

	it("replaces an existing token", () => {
		expect(withToken("http://127.0.0.1:2724/?access_token=old", "new")).toBe("http://127.0.0.1:2724/?access_token=new");
	});
});

describe("parseServerUrl", () => {
	it("finds the login URL marimo prints at startup", () => {
		const log = "\n        Edit nb.py in your browser 📝\n\n        ➜  URL: http://localhost:2725?access_token=tok123\n\n";
		expect(parseServerUrl(log)).toBe("http://localhost:2725?access_token=tok123");
	});

	it("ignores ANSI colors", () => {
		expect(parseServerUrl("\x1b[32mURL\x1b[0m: \x1b[1mhttp://localhost:2718\x1b[0m\n")).toBe("http://localhost:2718");
	});

	it("returns undefined before marimo printed it", () => {
		expect(parseServerUrl("Installing packages…")).toBeUndefined();
	});
});

describe("sandboxEnabled", () => {
	it("is on by default", () => {
		expect(sandboxEnabled({})).toBe(true);
		expect(sandboxEnabled({ PI_MARIMO_SANDBOX: "1" })).toBe(true);
	});

	it("turns off with PI_MARIMO_SANDBOX=0/false/no/off", () => {
		for (const value of ["0", "false", "No", " off "]) expect(sandboxEnabled({ PI_MARIMO_SANDBOX: value })).toBe(false);
	});
});
