/**
 * Pi Frame — Utility functions.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── String Formatting ───────────────────────────────────────────────────

export function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

export function formatThinking(level: string): string {
	return level === "off" ? "thinking off" : `thinking ${level}`;
}

export function formatTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

// ─── ANSI Utilities ──────────────────────────────────────────────────────

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ─── Layout Utilities ────────────────────────────────────────────────────

/**
 * A border line from the base editor is made up only of ─ ━ (and the optional
 * "↑ N more" / "↓ N more" scroll indicator). Used to locate the bottom border,
 * since the autocomplete dropdown appends extra lines after it.
 */
export const isBorderLine = (s: string): boolean =>
	stripAnsi(s)
		.replace(/[─━↑↓\d ]/g, "")
		.replace(/more/g, "")
		.length === 0;

export function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isBorderLine(lines[i]!)) return i;
	}
	return lines.length - 1;
}

export function padTo(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + " ".repeat(width - w);
	return truncateToWidth(text, width);
}
