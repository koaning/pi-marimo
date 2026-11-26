import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { mossball } from "../src/mossball.ts";

/**
 * Replace pi's startup header with the mossball and a title + status beside it.
 * `statusLine()` is read on every render; call the returned refresh function when it changes.
 */
export function showMascotHeader(ctx: ExtensionContext, statusLine: () => string): () => void {
	let requestRender = () => {};
	if (ctx.mode !== "tui") return requestRender;

	ctx.ui.setHeader((tui, theme) => {
		requestRender = () => tui.requestRender();
		return {
			invalidate() {},
			render(width: number) {
				const ball = mossball(getCapabilities().trueColor ? "truecolor" : "256");
				const text = [
					theme.bold(theme.fg("success", "pi × marimo")),
					theme.fg("muted", statusLine()),
				];
				const ballWidth = visibleWidth(ball[0]!);
				const mid = Math.floor(ball.length / 2) - 1;
				const lines = ball.map((row, i) => {
					const label = i >= mid && i < mid + text.length ? text[i - mid]! : "";
					return label ? `${row}   ${label}` : row;
				});
				if (width < ballWidth + 12) return ["", ...ball, ...text, ""].map((l) => truncateToWidth(l, width));
				return ["", ...lines, ""].map((l) => truncateToWidth(l, width));
			},
		};
	});
	return () => requestRender();
}
