/**
 * Procedural pixel-art mossball, rendered with half-block characters so each
 * terminal cell holds two square-ish pixels. Pure and deterministic.
 */

export type RGB = readonly [number, number, number];
export type Pixels = (RGB | null)[][];
export type ColorMode = "truecolor" | "256";

export const WIDTH = 30;
export const HEIGHT = 30; // pixels; 15 terminal rows

const CX = 15;
const CY = 16.5;
const R = 10.5;

// Dark → light moss.
const RAMP: RGB[] = [
	[6, 38, 20],
	[12, 62, 30],
	[20, 92, 40],
	[30, 122, 50],
	[48, 150, 60],
	[82, 180, 72],
	[128, 208, 92],
	[186, 236, 130],
];

const EYE: RGB = [14, 22, 18];
const GLINT: RGB = [250, 255, 250];
const BLUSH: RGB = [255, 140, 160];
const LEAF: RGB = [126, 220, 88];
const LEAF_LIGHT: RGB = [190, 245, 140];
const LEAF_DARK: RGB = [58, 150, 56];
const STEM: RGB = [70, 140, 60];
const SHADOW: RGB = [28, 40, 32];

function hash(x: number, y: number): number {
	const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
	return s - Math.floor(s);
}

/** Smooth value noise, so the moss gets soft blotches rather than static. */
function valueNoise(x: number, y: number, scale: number): number {
	const fx = x / scale;
	const fy = y / scale;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const tx = fx - x0;
	const ty = fy - y0;
	const sx = tx * tx * (3 - 2 * tx);
	const sy = ty * ty * (3 - 2 * ty);
	const a = hash(x0, y0);
	const b = hash(x0 + 1, y0);
	const c = hash(x0, y0 + 1);
	const d = hash(x0 + 1, y0 + 1);
	return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function mix(a: RGB, b: RGB, t: number): RGB {
	return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as RGB;
}

function ramp(t: number): RGB {
	const v = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
	const i = Math.min(RAMP.length - 2, Math.floor(v));
	return mix(RAMP[i]!, RAMP[i + 1]!, v - i);
}

export function mossballPixels(): Pixels {
	const px: Pixels = Array.from({ length: HEIGHT }, () => Array<RGB | null>(WIDTH).fill(null));
	const set = (x: number, y: number, c: RGB) => {
		if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) px[y]![x] = c;
	};

	// Soft shadow under the ball.
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const dx = (x + 0.5 - CX) / (R * 1.0);
			const dy = (y + 0.5 - (CY + R + 0.4)) / 1.6;
			if (dx * dx + dy * dy < 1) set(x, y, SHADOW);
		}
	}

	// The ball: lit sphere + moss texture + fuzzy rim.
	const light = normalize([-0.55, -0.65, 0.55]);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const dx = (x + 0.5 - CX) / R;
			const dy = (y + 0.5 - CY) / R;
			const d2 = dx * dx + dy * dy;
			const fuzz = 1 + (hash(x * 3.1, y * 1.7) - 0.5) * 0.22;
			if (d2 > fuzz * fuzz) continue;
			const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, d2)));
			const diffuse = Math.max(0, dx * light[0] + dy * light[1] + nz * light[2]);
			const blotch = valueNoise(x, y, 3.5);
			const grain = hash(x, y);
			let shade = 0.22 + 0.72 * diffuse;
			shade *= 0.78 + 0.42 * blotch;
			shade += (grain - 0.5) * 0.16;
			if (d2 > 0.82) shade *= 0.8; // darker fringe reads as fluffy depth
			const spec = Math.hypot(dx + 0.38, dy + 0.42);
			if (spec < 0.2) shade = Math.max(shade, 0.9 - spec);
			set(x, y, ramp(shade));
		}
	}

	// Face: eyes with glints, blush, tiny smile.
	const ey = 17;
	for (const ex of [10, 18]) {
		for (let yy = ey - 1; yy <= ey + 1; yy++) for (let xx = ex; xx <= ex + 1; xx++) set(xx, yy, EYE);
		set(ex, ey - 1, GLINT);
		set(ex - 1, ey + 2, mix(BLUSH, ramp(0.5), 0.25));
		set(ex + 2, ey + 2, mix(BLUSH, ramp(0.5), 0.25));
	}
	set(13, ey + 2, EYE);
	set(14, ey + 3, EYE);
	set(15, ey + 3, EYE);
	set(16, ey + 2, EYE);

	// Sprout on top: stem plus two leaves, lit from the upper left like the ball.
	const top = Math.floor(CY - R);
	for (let y = top - 4; y <= top; y++) set(15, y, STEM);
	const leaves: [number, number, RGB][] = [
		// left leaf
		[11, top - 4, LEAF_LIGHT], [12, top - 4, LEAF_LIGHT],
		[10, top - 3, LEAF_DARK], [11, top - 3, LEAF], [12, top - 3, LEAF], [13, top - 3, LEAF], [14, top - 3, LEAF_DARK],
		[12, top - 2, LEAF_DARK], [13, top - 2, LEAF_DARK], [14, top - 2, LEAF_DARK],
		// right leaf
		[18, top - 6, LEAF_LIGHT], [19, top - 6, LEAF_LIGHT],
		[16, top - 5, LEAF], [17, top - 5, LEAF_LIGHT], [18, top - 5, LEAF], [19, top - 5, LEAF], [20, top - 5, LEAF_DARK],
		[16, top - 4, LEAF_DARK], [17, top - 4, LEAF_DARK], [18, top - 4, LEAF_DARK],
	];
	for (const [x, y, c] of leaves) set(x, y, c);

	return px;
}

function normalize(v: [number, number, number]): [number, number, number] {
	const len = Math.hypot(...v);
	return [v[0] / len, v[1] / len, v[2] / len];
}

/** Nearest xterm-256 colour-cube index for terminals without truecolor. */
export function to256(c: RGB): number {
	const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
	return 16 + 36 * q(c[0]) + 6 * q(c[1]) + q(c[2]);
}

function fg(c: RGB, mode: ColorMode): string {
	return mode === "truecolor" ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${to256(c)}m`;
}

function bg(c: RGB, mode: ColorMode): string {
	return mode === "truecolor" ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${to256(c)}m`;
}

/** Two pixel rows per line: "▀" with fg = top pixel and bg = bottom pixel. */
export function renderHalfBlocks(pixels: Pixels, mode: ColorMode): string[] {
	const lines: string[] = [];
	for (let y = 0; y < pixels.length; y += 2) {
		let line = "";
		const width = pixels[y]!.length;
		for (let x = 0; x < width; x++) {
			const top = pixels[y]![x] ?? null;
			const bottom = pixels[y + 1]?.[x] ?? null;
			if (top && bottom) line += `${fg(top, mode)}${bg(bottom, mode)}▀\x1b[0m`;
			else if (top) line += `${fg(top, mode)}▀\x1b[0m`;
			else if (bottom) line += `${fg(bottom, mode)}▄\x1b[0m`;
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}

let cache: Partial<Record<ColorMode, string[]>> = {};

export function mossball(mode: ColorMode = "truecolor"): string[] {
	cache[mode] ??= renderHalfBlocks(mossballPixels(), mode);
	return cache[mode]!;
}
