/**
 * Pi Frame — Pi coding agent input field extension.
 *
 * Two flavors: "box" (full box-drawing frame) and "bar" (left thick bar).
 * Switch via `/frame box` or `/frame bar`.
 * Toggle stats via `/frame show <stat>` or `/frame hide <stat>`.
 *
 * Available stats: model, session, mode, thinking, tps, cost, context, cwd, git, version
 *
 * Layout (both flavors):
 *   top    → model (provider)               [left]   session name [right]
 *   middle → "> " prompt + editor text
 *   bottom → mode · thinking                [left]   tps · cost · context [right]
 *   footer → cwd · git                      [left]   version [right]   (below the box)
 *
 * The box/bar is coloured by mode (accent for exec, warning for plan); the
 * context bar is coloured by fill (success → warning → error). All colours come
 * from the active theme.
 *
 * Load:
 *   pi -e ./index.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

// Modules
import {
	config,
	ALL_STATS,
	CUSTOM_TYPE,
	VERSION_LABEL,
	type PiFramePersistedState,
	type StatKey,
	type GitInfo,
} from "./types.js";
import {
	formatCwd,
	formatThinking,
	formatTokens,
	visibleWidth,
	truncateToWidth,
} from "./helpers.js";
import { refreshGit as fetchGit, gitSegment } from "./git.js";
import { renderFrame, renderBar } from "./render.js";

// ─── State ────────────────────────────────────────────────────────────────

let activeTui: { requestRender: () => void } | undefined;
let currentModelLabel = "";
let currentThinking: ThinkingLevel = "off";
let lastTps = 0;
let sessionCost = 0;
let currentCwd = "";
let gitInfo: GitInfo | null = null;

// Live session ctx + validity flag. Re-bound on every (re)start so closures
// never use a stale ctx after a session replacement / reload.
let currentCtx: any = null;
let sessionValid = false;

// TPS tracking
let tpsTokenCount = 0;
let tpsStartTime = 0;
let tpsInterval: ReturnType<typeof setInterval> | undefined;
let tpsStreaming = false;

// Braille spinner
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;
let spinnerInterval: ReturnType<typeof setInterval> | undefined;

function startSpinner(): void {
	if (spinnerInterval) return;
	spinnerIdx = 0;
	spinnerInterval = setInterval(() => {
		spinnerIdx = (spinnerIdx + 1) % BRAILLE.length;
		activeTui?.requestRender();
	}, 100);
}

function stopSpinner(): void {
	if (spinnerInterval) {
		clearInterval(spinnerInterval);
		spinnerInterval = undefined;
	}
	spinnerIdx = 0;
}

function startTpsTracking(): void {
	tpsTokenCount = 0;
	tpsStartTime = 0;
	tpsStreaming = false;
	if (!tpsInterval) {
		tpsInterval = setInterval(() => {
			// Only recalculate while streaming — frozen after message_end
			if (tpsStreaming && tpsStartTime > 0 && tpsTokenCount > 0) {
				const elapsed = (Date.now() - tpsStartTime) / 1000;
				if (elapsed > 0) {
					lastTps = Math.round(tpsTokenCount / elapsed);
				}
			}
			activeTui?.requestRender();
		}, 500);
	}
}

function stopTpsTracking(): void {
	if (tpsInterval) {
		clearInterval(tpsInterval);
		tpsInterval = undefined;
	}
	if (tpsStartTime > 0 && tpsTokenCount > 0) {
		const elapsed = (Date.now() - tpsStartTime) / 1000;
		if (elapsed > 0) {
			lastTps = Math.round(tpsTokenCount / elapsed);
		}
	}
}

// ─── Extension Entry Point ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	function isValidStat(key: string): key is StatKey {
		return (ALL_STATS as string[]).includes(key);
	}

	// ── Persistence ────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry(CUSTOM_TYPE, {
			flavor: config.flavor,
			visible: [...config.visible],
		} as PiFramePersistedState);
	}

	function reconstructState(ctx: any): void {
		// Check for CLI flag override first
		const flagMode = pi.getFlag("frame-mode");
		if (flagMode === "box" || flagMode === "bar") {
			config.flavor = flagMode;
			return; // Flag overrides everything, keep default visible
		}

		// Try to restore from session entries (last one wins)
		const entries = ctx.sessionManager.getEntries();
		const state = entries
			.filter((e: any) => e.type === "custom" && e.customType === CUSTOM_TYPE)
			.pop() as { data?: PiFramePersistedState } | undefined;

		if (state?.data) {
			if (state.data.flavor === "box" || state.data.flavor === "bar") {
				config.flavor = state.data.flavor;
			}
			if (Array.isArray(state.data.visible)) {
				config.visible = new Set(
					state.data.visible.filter((k: string) => (ALL_STATS as string[]).includes(k))
				);
			}
			return;
		}

		// Fall back to global defaults from settings.json
		try {
			const home = process.env.HOME ?? "";
			const settingsPath = join(home, ".pi", "agent", "settings.json");
			if (existsSync(settingsPath)) {
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
				const defaults = settings?.["pi-frame"];
				if (defaults?.flavor === "box" || defaults?.flavor === "bar") {
					config.flavor = defaults.flavor;
				}
				if (Array.isArray(defaults?.visible)) {
					config.visible = new Set(
						defaults.visible.filter((k: string) => (ALL_STATS as string[]).includes(k))
					);
				}
			}
		} catch {
			// Ignore parse errors, use hardcoded defaults
		}
	}

	async function doRefreshGit(): Promise<void> {
		const info = await fetchGit(pi, currentCwd);
		gitInfo = info;
		activeTui?.requestRender();
	}

	// ── Command ───────────────────────────────────────────────────────

	pi.registerCommand("frame", {
		description: "Configure pi-frame. Usage: /frame [box|bar|show <stat>|hide <stat>]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const vis = [...config.visible].join(", ");
				ctx.ui.notify(`frame: ${config.flavor} mode | visible: ${vis}`, "info");
				return;
			}

			const cmd = parts[0]!;
			if (cmd === "box" || cmd === "bar") {
				config.flavor = cmd;
				persistState();
				ctx.ui.notify(`frame: switched to ${cmd} mode`, "info");
				activeTui?.requestRender();
				return;
			}
			if ((cmd === "show" || cmd === "hide") && parts[1]) {
				const key = parts[1];
				if (!isValidStat(key)) {
					ctx.ui.notify(`frame: unknown stat "${key}"`, "warning");
					return;
				}
				if (cmd === "show") config.visible.add(key);
				else config.visible.delete(key);
				persistState();
				ctx.ui.notify(`frame: ${cmd === "show" ? "showing" : "hiding"} "${key}"`, "info");
				activeTui?.requestRender();
				return;
			}
			ctx.ui.notify(
				`frame: unknown command "${cmd}". Try: box, bar, show <stat>, hide <stat>`,
				"warning",
			);
		},
	});

	// ── Events ────────────────────────────────────────────────────────

	pi.on("agent_start", () => {
		// Re-assert: defensive in case the loader visibility resets per run.
		currentCtx?.ui.setWorkingVisible(false);
		startSpinner();
		startTpsTracking();
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		stopSpinner();
		stopTpsTracking();
		// Only refresh git while the session is still valid; after a session
		// replacement the captured pi is stale and pi.exec would throw.
		if (sessionValid) void doRefreshGit();
		activeTui?.requestRender();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			// Reset timer for each new message — excludes tool execution gaps
			tpsStartTime = Date.now();
			tpsTokenCount = 0;
			tpsStreaming = true;
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			const msg = event.message as any;
			if (msg.usage) {
				// Use real usage from the API. Exclude input tokens —
				// t/s measures generation speed, not total throughput.
				tpsTokenCount = (msg.usage.output || 0) + (msg.usage.thinking || 0);
				sessionCost += msg.usage.cost?.total || 0;
				// Calculate final t/s now — interval won't update while tpsStreaming=false
				if (tpsStartTime > 0 && tpsTokenCount > 0) {
					const elapsed = (Date.now() - tpsStartTime) / 1000;
					if (elapsed > 0) lastTps = Math.round(tpsTokenCount / elapsed);
				}
			}
			// Freeze: interval stops recalculating until next message_start
			tpsStreaming = false;
		}
		activeTui?.requestRender();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinking = event.level;
		activeTui?.requestRender();
	});

	pi.on("model_select", (event) => {
		const m = event.model;
		currentModelLabel = `${m.id} (${m.provider})`;
		activeTui?.requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		reconstructState(ctx);
		currentCtx = ctx;
		sessionValid = true;
		// Reload/switch paths fire session_tree without session_start, so the
		// built-in working loader reverts to default-visible. Re-hide it here.
		ctx.ui.setWorkingVisible(false);
		activeTui?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		reconstructState(ctx);
		currentCtx = ctx;
		sessionValid = true;
		currentThinking = pi.getThinkingLevel();
		currentModelLabel = ctx.model ? `${ctx.model.id} (${ctx.model.provider})` : "no model";
		currentCwd = ctx.cwd;

		// Session cost = sum of assistant message costs (restored on resume).
		let cost = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && (entry as any).message?.role === "assistant") {
				cost += (entry as any).message.usage?.cost?.total || 0;
			}
		}
		sessionCost = cost;

		void doRefreshGit();
		ctx.ui.setWorkingVisible(false);


		// ── Stat groups (capture ctx via closure) ──────────────────────

		const getMode = (): { label: string; color: string } => {
			let plan = false;
			try {
				const active = new Set(pi.getActiveTools());
				plan = !active.has("edit") && !active.has("write");
			} catch {
				plan = false;
			}
			return plan ? { label: "plan", color: "warning" } : { label: "exec", color: "accent" };
		};

		const getCtxInfo = (): { pct: number; used: number; cw: number } | null => {
			const usage = ctx.getContextUsage();
			const cw = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
			if (!cw || !usage || usage.percent === null || usage.percent === undefined) return null;
			return { pct: Math.round(usage.percent), used: (usage as any).tokens ?? 0, cw };
		};

		// "{pct}% ━━━──────── {used}/{total}" coloured by fill level.
		const ctxString = (info: { pct: number; used: number; cw: number }): string => {
			const thm = ctx.ui.theme;
			const barW = 10;
			const filled = Math.max(0, Math.min(barW, Math.round((info.pct / 100) * barW)));
			const col = info.pct < 50 ? "success" : info.pct < 80 ? "warning" : "error";
			const bar = thm.fg(col, "━".repeat(filled)) + thm.fg("dim", "─".repeat(barW - filled));
			return `${thm.fg(col, `${info.pct}%`)} ${bar} ${thm.fg("dim", `${formatTokens(info.used)}/${formatTokens(info.cw)}`)}`;
		};

		const topLeft = (): string => {
			const thm = ctx.ui.theme;
			return config.visible.has("model") ? thm.fg("text", currentModelLabel) : "";
		};
		const shorten = (s: string, max = 32): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
		const topRight = (): string => {
			const thm = ctx.ui.theme;
			const summary = pi.getSessionName?.();
			return config.visible.has("session") && summary ? thm.fg("dim", shorten(summary)) : "";
		};
		const bottomLeft = (sep: string): string => {
			const thm = ctx.ui.theme;
			const mode = getMode();
			const items: string[] = [];
			if (config.visible.has("mode")) items.push(thm.fg(mode.color, mode.label));
			if (config.visible.has("thinking")) items.push(thm.fg("dim", formatThinking(currentThinking)));
			return items.join(sep);
		};
		const bottomRight = (sep: string): string => {
			const thm = ctx.ui.theme;
			const items: string[] = [];
			if (config.visible.has("tps") && lastTps > 0) items.push(thm.fg("dim", `${lastTps} t/s`));
			if (config.visible.has("cost") && sessionCost > 0) items.push(thm.fg("dim", `${sessionCost.toFixed(3)}$`));
			if (config.visible.has("context")) {
				const info = getCtxInfo();
				if (info) items.push(ctxString(info));
			}
			return items.join(sep);
		};

		// ── Footer (below the box): cwd · git [left] ... version [right] ──

		const makeFooter = (footerData: any) => {
			const unsub = footerData?.onBranchChange?.(() => {
				void doRefreshGit();
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const thm = ctx.ui.theme;
					const left: string[] = [];
					if (config.visible.has("cwd")) left.push(formatCwd(ctx.cwd));
					if (config.visible.has("git")) left.push(gitSegment(gitInfo));
					let leftStr = thm.fg("dim", ` ${left.join("  ")}`);
					let rightStr = config.visible.has("version") ? thm.fg("dim", `${VERSION_LABEL} `) : "";
					const leftW = visibleWidth(leftStr);
					const rightW = visibleWidth(rightStr);
					const gapW = Math.max(0, width - leftW - rightW);
					if (gapW < 1) {
						// Not enough room — shrink left content to fit.
						const maxLeftW = rightStr ? Math.max(0, width - rightW - 1) : width;
						leftStr = truncateToWidth(leftStr, maxLeftW);
					}
					return ["", `${leftStr}${" ".repeat(Math.max(0, width - visibleWidth(leftStr) - visibleWidth(rightStr)))}${rightStr}`];
				},
			};
		};

		// ── Install (compose, don't clobber) ──────────────────────────
		// Other extensions (e.g. raw-paste) also call setEditorComponent/setFooter
		// in their session_start. Rather than fight over who runs last, we WRAP
		// whatever editor is currently installed and decorate its rendered lines.
		// Deferred to a timer so this runs after every other extension's
		// session_start has installed its own editor.
		const installUI = () => {
			ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => makeFooter(footerData));

			const prev = ctx.ui.getEditorComponent() as
				| ((tui: any, theme: any, keybindings: any) => EditorComponent)
				| undefined;

			// Don't re-wrap our own wrapper (e.g. across /reload when nobody else
			// reset the editor) — that would stack decorations.
			if (prev && (prev as any).__piFrame) return;

			const factory = (tui: any, theme: any, keybindings: any): EditorComponent => {
				const base: any = prev
					? prev(tui, theme, keybindings)
					: new CustomEditor(tui, theme, keybindings, { paddingX: 0 });
				activeTui = tui;

				// We manage horizontal gutters ourselves, so neutralise the inner
				// editor's padding (and ignore the runtime's later attempts to set it).
				base.paddingX = 0;
				base.setPaddingX = () => {};

				const baseRender = base.render.bind(base);
				base.render = (width: number): string[] => {
					// Reserve columns for our box/bar + prompt, then decorate.
					// box: │ + " " + "> " + text + " " + │  → text width = width - 6
					// bar:   " " + ▐ + "> " + text + ▐ + " "  → text width = width - 7
					if (width < 12) return baseRender(width);
					const reserve = config.flavor === "bar" ? 7 : 6;
					const lines = baseRender(width - reserve);
					if (lines.length < 2) return baseRender(width);

					const thm = ctx.ui.theme;
					const mode = getMode();
					const promptChar = spinnerInterval ? BRAILLE[spinnerIdx] : ">";
					const tl = topLeft();
					const tr = topRight();
					const sep = config.flavor === "box" ? thm.fg(mode.color, " ─ ") : " · ";
					const bl = bottomLeft(sep);
					const br = bottomRight(sep);

					return ["", ...(config.flavor === "bar"
						? renderBar(lines, width, thm, mode.color, promptChar, tl, tr, bl, br)
						: renderFrame(lines, width, thm, mode.color, promptChar, tl, tr, bl, br))];
				};
				return base;
			};
			(factory as any).__piFrame = true;

			ctx.ui.setEditorComponent(factory);
			activeTui?.requestRender();
		};

		setTimeout(installUI, 0);
	});

	pi.registerFlag("frame-mode", {
		description: "Override pi-frame mode: box or bar",
		type: "string",
	});

	pi.on("session_shutdown", () => {
		stopSpinner();
		stopTpsTracking();
		sessionValid = false;
		currentCtx = null;
		activeTui = undefined;
	});
}
