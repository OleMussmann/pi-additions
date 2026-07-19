/**
 * Pi Frame — Box and bar rendering.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findBottomBorderIndex, padTo } from "./helpers.js";

// ─── Background Fill ─────────────────────────────────────────────────────

/**
 * Apply a background colour across an entire string, re-asserting it after
 * any embedded reset (\x1b[0m) so the fill survives styled text / cursor.
 */
export function bgFill(text: string, key: string, thm: any): string {
	const probe = thm.bg(key, " ");
	const i = probe.indexOf(" ");
	if (i < 0) return thm.bg(key, text);
	const prefix = probe.slice(0, i);
	const suffix = probe.slice(i + 1);
	const patched = text.replace(/\x1b\[0m/g, (m) => m + prefix);
	return prefix + patched + suffix;
}

// ─── Frame Border ────────────────────────────────────────────────────────

export function frameBorder(
	cornerL: string,
	cornerR: string,
	left: string,
	right: string,
	width: number,
	fc: (t: string) => string,
): string {
	let l = left;
	let r = right;
	const fillFor = () =>
		visibleWidth(r) > 0
			? width - (visibleWidth(l) + visibleWidth(r) + 8)
			: width - (visibleWidth(l) + 6);
	while (fillFor() < 1 && visibleWidth(r) > 0)
		r = truncateToWidth(r, Math.max(0, visibleWidth(r) - 1), "");
	while (fillFor() < 1 && visibleWidth(l) > 0)
		l = truncateToWidth(l, Math.max(0, visibleWidth(l) - 1), "");
	const fill = fc("─".repeat(Math.max(0, fillFor())));
	if (visibleWidth(r) > 0) {
		return `${fc(cornerL)}${fc("─")} ${l} ${fill} ${r} ${fc("─")}${fc(cornerR)}`;
	}
	return `${fc(cornerL)}${fc("─")} ${l} ${fill}${fc("─")}${fc(cornerR)}`;
}

// ─── Frame Rendering ─────────────────────────────────────────────────────

export function renderFrame(
	lines: string[],
	width: number,
	thm: any,
	modeColor: string,
	promptChar: string,
	topLeft: string,
	topRight: string,
	bottomLeft: string,
	bottomRight: string,
): string[] {
	const fc = (t: string) => thm.fg(modeColor, t);
	const bottomIdx = findBottomBorderIndex(lines);

	lines[0] = frameBorder("╭", "╮", topLeft, topRight, width, fc);
	for (let i = 1; i < bottomIdx; i++) {
		const prompt = thm.fg(modeColor, i === 1 ? promptChar + " " : "  ");
		lines[i] = `${fc("│")} ${prompt}${lines[i]} ${fc("│")}`;
	}
	lines[bottomIdx] = frameBorder("╰", "╯", bottomLeft, bottomRight, width, fc);
	return lines;
}

// ─── Bar Rendering ───────────────────────────────────────────────────────

/**
 * One bar row: " " + ▐ + dark-grey box + ▌ + " " — symmetric half-block edges.
 */
function barRow(
	inner: string,
	width: number,
	fc: (t: string) => string,
	thm: any,
): string {
	// ▌ uses toolPendingBg as foreground (left half filled), default bg (right half transparent)
	const bgAnsi = thm.getBgAnsi("toolPendingBg");
	const fgAnsi = bgAnsi.replace("48", "38");
	return ` ${fc("▐")}${bgFill(padTo(inner, width - 4), "toolPendingBg", thm)}${fgAnsi}▌\x1b[39m `;
}

export function renderBar(
	lines: string[],
	width: number,
	thm: any,
	modeColor: string,
	promptChar: string,
	topLeft: string,
	topRight: string,
	bottomLeft: string,
	bottomRight: string,
): string[] {
	const fc = (t: string) => thm.fg(modeColor, t);
	const bottomIdx = findBottomBorderIndex(lines);
	const innerW = width - 4;

	const tl = topLeft;
	const tr = topRight;
	const topGap = Math.max(1, innerW - 2 - visibleWidth(tl) - visibleWidth(tr));
	lines[0] = barRow(` ${tl}${" ".repeat(topGap)}${tr} `, width, fc, thm);

	for (let i = 1; i < bottomIdx; i++) {
		const prompt = thm.fg(modeColor, i === 1 ? promptChar + " " : "  ");
		lines[i] = barRow(` ${prompt}${lines[i]}`, width, fc, thm);
	}

	const bl = bottomLeft;
	const br = bottomRight;
	const botGap = Math.max(1, innerW - 2 - visibleWidth(bl) - visibleWidth(br));
	lines[bottomIdx] = barRow(` ${bl}${" ".repeat(botGap)}${br} `, width, fc, thm);
	return lines;
}
