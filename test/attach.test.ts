import { describe, expect, it } from "vitest";
import { SseParser, findHostToken, hostApiUrl } from "../src/attach.ts";

describe("hostApiUrl", () => {
	it("maps a notebook URL to marimo's host API", () => {
		expect(hostApiUrl("http://127.0.0.1:2724")).toBe("http://127.0.0.1:2724/api/marimo/v1");
		expect(hostApiUrl("http://127.0.0.1:2724/?access_token=x")).toBe("http://127.0.0.1:2724/api/marimo/v1");
	});
});

describe("findHostToken", () => {
	const records = [
		{ url: "http://127.0.0.1:2721/api/marimo/v1", token: "a" },
		{ url: "http://127.0.0.1:2724/api/marimo/v1", token: "b" },
		{ url: "not a url", token: "c" },
		{ url: "http://127.0.0.1:2725/api/marimo/v1" },
	];

	it("matches on host and port", () => {
		expect(findHostToken(records, "http://127.0.0.1:2724/api/marimo/v1")).toBe("b");
	});

	it("treats localhost as 127.0.0.1", () => {
		expect(findHostToken(records, "http://localhost:2721/api/marimo/v1")).toBe("a");
	});

	it("skips records without a token", () => {
		expect(findHostToken(records, "http://127.0.0.1:2725/api/marimo/v1")).toBeUndefined();
	});
});

describe("SseParser", () => {
	it("parses events split across chunks and ignores pings", () => {
		const p = new SseParser();
		expect(p.push(": ping\n\nevent: attachment\ndata: {\"a\":")).toEqual([]);
		expect(p.push("1}\n\nid: 7\nevent: ready\ndata: {}\n\n")).toEqual([
			{ event: "attachment", data: '{"a":1}' },
			{ event: "ready", data: "{}" },
		]);
	});

	it("handles CRLF line endings", () => {
		expect(new SseParser().push("event: x\r\ndata: y\r\n\r\n")).toEqual([{ event: "x", data: "y" }]);
	});
});
