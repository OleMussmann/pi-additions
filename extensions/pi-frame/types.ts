/**
 * Pi Frame — Types and constants.
 */

import { VERSION } from "@earendil-works/pi-coding-agent";

// ─── Flavors & Stats ─────────────────────────────────────────────────────

export type Flavor = "box" | "bar";

export type StatKey =
	| "model"
	| "session"
	| "mode"
	| "thinking"
	| "tps"
	| "cost"
	| "context"
	| "cwd"
	| "git"
	| "version";

export const ALL_STATS: StatKey[] = [
	"model",
	"session",
	"mode",
	"thinking",
	"tps",
	"cost",
	"context",
	"cwd",
	"git",
	"version",
];

// ─── Config ──────────────────────────────────────────────────────────────

export interface PiFrameConfig {
	flavor: Flavor;
	visible: Set<StatKey>;
}

export const config: PiFrameConfig = { flavor: "box", visible: new Set(ALL_STATS) };

// ─── Persistence ─────────────────────────────────────────────────────────

export const CUSTOM_TYPE = "pi-frame-state";

export interface PiFramePersistedState {
	flavor: Flavor;
	visible: StatKey[];
}

// ─── Constants ───────────────────────────────────────────────────────────

export const VERSION_LABEL = `pi ${VERSION}`;

// Git status glyphs (starship-inspired). Edit to taste / match your font.
export const GIT_SYMBOLS = {
	ahead: "⇡",
	behind: "⇣",
	staged: "+",
	modified: "!",
	renamed: "»",
	deleted: "󰧧",
	untracked: "󱀣",
	conflicted: "󱠇",
	stashed: "*",
};

export interface GitInfo {
	branch: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	deleted: number;
	renamed: number;
	untracked: number;
	conflicted: number;
	stashed: number;
	state: string;
}
