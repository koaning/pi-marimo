import { describe, expect, it } from "vitest";
import { HEIGHT, WIDTH, mossball, mossballPixels, to256 } from "../src/mossball.ts";
import { SEED_CODE } from "../src/marimo.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("mossball", () => {
	it("renders two pixel rows per terminal line at a fixed width", () => {
		const lines = mossball("truecolor");
		expect(lines).toHaveLength(HEIGHT / 2);
		for (const line of lines) expect([...strip(line)]).toHaveLength(WIDTH);
	});

	it("is deterministic", () => {
		expect(mossballPixels()).toEqual(mossballPixels());
	});

	it("uses only 256-colour codes in 256 mode", () => {
		const joined = mossball("256").join("\n");
		expect(joined).not.toMatch(/\x1b\[[34]8;2;/);
		expect(joined).toMatch(/\x1b\[38;5;\d+m/);
	});

	it("maps colours into the 6x6x6 cube", () => {
		expect(to256([0, 0, 0])).toBe(16);
		expect(to256([255, 255, 255])).toBe(231);
	});
});

describe("SEED_CODE", () => {
	it("only touches notebooks whose cells are all empty", () => {
		expect(SEED_CODE).toContain("if any(c.code.strip() for c in cells):");
		expect(SEED_CODE).toContain('ctx.edit_cell(cid, "import marimo as mo")');
		expect(SEED_CODE).toContain("ctx.run_cell(cid)");
	});
});
