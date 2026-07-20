/**
 * Plan Mode Default Extension
 *
 * Plan mode is the default for interactive sessions.
 * Exec mode gives full tool access for building.
 *
 * Commands:
 * - /plan      Enter plan mode (read-only, safe tools only)
 * - /exec      Enter exec mode (full tool access)
 * - /create-plan  Trigger the agent to create an implementation plan
 * - /plan-status  Show current plan progress
 *
 * Flags:
 * - --plan     Start in plan mode
 * - --exec     Start in exec mode
 *
 * Interactive default: plan mode
 * Non-interactive default: exec mode
 *
 * Plan mode restrictions:
 * - edit and write tools are blocked
 * - bash is restricted to a safe-command allowlist
 *
 * The agent uses the plan_item tool to manage the plan.
 * Plan progress is shown in a widget whenever the plan has items (in either mode).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isSafeCommand } from "./utils.ts";

// Builtins permitted in plan mode (read-only, no file modification)
const PLAN_SAFE_BUILTINS = new Set(["read", "bash", "grep", "find", "ls"]);

interface PlanItem {
	step: number;
	name?: string;
	text: string;
	completed: boolean;
	priority?: "low" | "medium" | "high";
}

interface PlanDetails {
	action: "add" | "update" | "toggle" | "remove" | "clear" | "list";
	items: PlanItem[];
	nextStep: number;
	error?: string;
}

const PlanItemParams = Type.Object({
	action: StringEnum(["add", "update", "toggle", "remove", "clear", "list"] as const),
	step: Type.Optional(Type.Number({ description: "Step number for update/toggle/remove" })),
	name: Type.Optional(Type.String({ description: "Short display name for the plan item (shown in widget)" })),
	text: Type.Optional(Type.String({ description: "Full step description for add/update" })),
	priority: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
});

// Maximum number of plan items rendered in the widget before truncation.
const MAX_WIDGET_ITEMS = 10;

/**
 * Select which plan items to show in the (capped) widget.
 *
 * DONE items are truncated first (oldest completed dropped from the front),
 * then TODO items only if they alone exceed the cap (furthest-future TODOs
 * dropped from the tail). Returns the items to display plus hidden counts so
 * the caller can render an "N hidden" indicator.
 */
function selectWidgetItems(
	items: PlanItem[],
	max: number = MAX_WIDGET_ITEMS,
): { display: PlanItem[]; hiddenDone: number; hiddenTodo: number } {
	const done = items.filter((i) => i.completed);
	const todo = items.filter((i) => !i.completed);

	if (items.length <= max) {
		return { display: [...items], hiddenDone: 0, hiddenTodo: 0 };
	}

	// Not enough room for any DONE: keep the nearest (head) TODOs, drop the rest.
	if (todo.length >= max) {
		return {
			display: todo.slice(0, max),
			hiddenTodo: todo.length - max,
			hiddenDone: done.length,
		};
	}

	// Room for all TODO plus the most recent DONE (drop oldest from the front).
	const roomForDone = max - todo.length;
	const hiddenDone = Math.max(0, done.length - roomForDone);
	return {
		display: [...done.slice(hiddenDone), ...todo],
		hiddenDone,
		hiddenTodo: 0,
	};
}

export default function planModeDefaultExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let execModeEnabled = false;
	let planItems: PlanItem[] = [];
	let nextStep = 1;
	let savedTools: string[] | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		if (execModeEnabled && planItems.length > 0) {
			const completed = planItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `▶ ${completed}/${planItems.length}`),
			);
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (planItems.length > 0) {
			const sel = selectWidgetItems(planItems);
			const display = sel.display;
			let hiddenDone = sel.hiddenDone;
			let hiddenTodo = sel.hiddenTodo;
			const lines = display.map((item) => {
				const displayName = item.name ?? item.text.split("\n")[0];
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(displayName))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${displayName}`;
			});

			// Indicate truncation so the user knows the list is incomplete.
			// Reserve the summary's own slot by dropping the lowest-priority
			// visible item: prefer a DONE over a TODO (DONE are truncated first),
			// so TODOs stay fully visible whenever a DONE is available to drop.
			if (hiddenDone > 0 || hiddenTodo > 0) {
				let dropIdx = display.findIndex((d) => d.completed);
				if (dropIdx === -1) {
					dropIdx = display.length - 1;
					hiddenTodo++;
				} else {
					hiddenDone++;
				}
				display.splice(dropIdx, 1);
				lines.splice(dropIdx, 1);
				const summary = ctx.ui.theme.fg(
					"muted",
					`… ${hiddenDone} DONE and ${hiddenTodo} TODO hidden`,
				);
				lines.unshift(summary);
			}

			ctx.ui.setWidget("plan-items", lines);
		} else {
			ctx.ui.setWidget("plan-items", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			mode: planModeEnabled ? "plan" : execModeEnabled ? "exec" : "none",
			items: planItems,
			nextStep,
		});
	}

	function getPlanModeTools(): string[] {
		return pi.getAllTools()
			.filter((t) => {
				// Allow all extension/MCP tools (user explicitly installed them)
				if (t.sourceInfo.source !== "builtin") return true;
				// For builtins, only allow safe read-only commands
				return PLAN_SAFE_BUILTINS.has(t.name);
			})
			.map((t) => t.name);
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.notify("Already in plan mode", "info");
			return;
		}
		savedTools = pi.getActiveTools();
		pi.setActiveTools(getPlanModeTools());
		planModeEnabled = true;
		execModeEnabled = false;
		ctx.ui.notify("Plan mode enabled. Read-only tools only.", "info");
		updateStatus(ctx);
		persistState();
	}

	function enterExecMode(ctx: ExtensionContext): void {
		if (execModeEnabled) {
			ctx.ui.notify("Already in exec mode", "info");
			return;
		}
		pi.setActiveTools(savedTools ?? pi.getAllTools().map((t) => t.name));
		planModeEnabled = false;
		execModeEnabled = true;
		ctx.ui.notify("Exec mode enabled. Full tool access.", "info");
		updateStatus(ctx);
		persistState();
	}

	function reconstructState(ctx: ExtensionContext): void {
		planItems = [];
		nextStep = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "plan_item") continue;

			const details = msg.details as PlanDetails | undefined;
			if (details) {
				planItems = details.items;
				nextStep = details.nextStep;
			}
		}
	}

	// Commands
	pi.registerCommand("plan", {
		description: "Enter plan mode (read-only exploration)",
		handler: async (_args, ctx) => enterPlanMode(ctx),
	});

	pi.registerCommand("exec", {
		description: "Enter exec mode (full tool access)",
		handler: async (_args, ctx) => enterExecMode(ctx),
	});

	pi.registerCommand("create-plan", {
		description: "Create an implementation plan",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(
				"Create a detailed implementation plan. Break it into numbered steps. For each step, specify which files to modify and what changes to make. Use the plan_item tool to add each step.",
			);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan status",
		handler: async (_args, ctx) => {
			if (planItems.length === 0) {
				ctx.ui.notify("No plan items yet. Use /create-plan to create a plan.", "info");
				return;
			}
			const completed = planItems.filter((t) => t.completed).length;
			const list = planItems
				.map((item, i) => {
					const name = item.name ?? item.text.split("\n")[0];
					const detail = item.name ? item.text : "";
					let line = `${i + 1}. ${item.completed ? "✓" : "○"} ${name}`;
					if (detail) line += `\n   → ${detail}`;
					return line;
				})
				.join("\n");
			ctx.ui.notify(`Plan (${completed}/${planItems.length}):\n${list}`, "info");
		},
	});

	// Keyboard shortcut
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan/exec mode",
		handler: async (ctx) => {
			if (planModeEnabled) {
				enterExecMode(ctx);
			} else {
				enterPlanMode(ctx);
			}
		},
	});

	// Flags
	pi.registerFlag("plan", {
		description: "Start in plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("exec", {
		description: "Start in exec mode",
		type: "boolean",
		default: false,
	});

	// Block destructive tools in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is blocked. Use /exec to enter exec mode first.`,
			};
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: bash command blocked (not in allowlist). Use /exec to enter exec mode first.\nCommand: ${command}`,
				};
			}
		}
	});

	// Inject mode context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode.

Restrictions:
- edit and write tools are disabled
- Bash is restricted to read-only commands only
- Do not create or modify files

When creating a plan:
- Use the plan_item tool to add each step
- Include specific files, changes, and risks`,
					display: false,
				},
			};
		}

		if (execModeEnabled && planItems.length > 0) {
			const remaining = planItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.name ?? t.text.split("\n")[0]}`).join("\n");
			return {
				message: {
					customType: "exec-mode-context",
					content: `[EXEC MODE ACTIVE]
Plan progress: ${planItems.filter((t) => t.completed).length}/${planItems.length}

Remaining steps:
${todoList}

Execute each step in order. Use the plan_item tool to mark steps complete.`,
					display: false,
				},
			};
		}
	});

	// Register plan_item tool
	pi.registerTool({
		name: "plan_item",
		label: "Plan Item",
		description: "Manage the implementation plan. Actions: add, update, toggle, remove, clear, list. Use 'name' for short display labels.",
		parameters: PlanItemParams,
		promptSnippet: "Use plan_item to manage implementation plan steps",
		promptGuidelines: [
			"Use plan_item tool with action 'add' to add each step of your plan.",
			"Use the 'name' parameter for a short display label (shown in widget). Keep it concise.",
			"Use the 'text' parameter for the full implementation details.",
			"Use plan_item tool with action 'toggle' to mark a step as completed or uncompleted.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list": {
					const text = planItems.length
						? planItems.map((t) => {
							const display = t.name ?? t.text.split("\n")[0];
							return `[${t.completed ? "x" : " "}] ${t.step}. ${display}`;
						}).join("\n")
						: "No plan items";
					return {
						content: [{ type: "text", text }],
						details: { action: "list", items: [...planItems], nextStep } as PlanDetails,
					};
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", items: [...planItems], nextStep, error: "text required" } as PlanDetails,
						};
					}
					const item: PlanItem = {
						step: nextStep++,
						name: params.name,
						text: params.text,
						completed: false,
						priority: params.priority,
					};
					planItems.push(item);
					return {
						content: [{ type: "text", text: `Added plan step #${item.step}: ${item.text}` }],
						details: { action: "add", items: [...planItems], nextStep } as PlanDetails,
					};
				}

				case "update": {
					if (params.step === undefined) {
						return {
							content: [{ type: "text", text: "Error: step required for update" }],
							details: { action: "update", items: [...planItems], nextStep, error: "step required" } as PlanDetails,
						};
					}
					const item = planItems.find((t) => t.step === params.step);
					if (!item) {
						return {
							content: [{ type: "text", text: `Step #${params.step} not found` }],
							details: { action: "update", items: [...planItems], nextStep, error: `#${params.step} not found` } as PlanDetails,
						};
					}
					if (params.text) item.text = params.text;
					if (params.name) item.name = params.name;
					if (params.priority) item.priority = params.priority;
					return {
						content: [{ type: "text", text: `Updated step #${item.step}: ${item.text}` }],
						details: { action: "update", items: [...planItems], nextStep } as PlanDetails,
					};
				}

				case "toggle": {
					if (params.step === undefined) {
						return {
							content: [{ type: "text", text: "Error: step required for toggle" }],
							details: { action: "toggle", items: [...planItems], nextStep, error: "step required" } as PlanDetails,
						};
					}
					const item = planItems.find((t) => t.step === params.step);
					if (!item) {
						return {
							content: [{ type: "text", text: `Step #${params.step} not found` }],
							details: { action: "toggle", items: [...planItems], nextStep, error: `#${params.step} not found` } as PlanDetails,
						};
					}
					item.completed = !item.completed;
					return {
						content: [{ type: "text", text: `Step #${item.step} ${item.completed ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", items: [...planItems], nextStep } as PlanDetails,
					};
				}

				case "remove": {
					if (params.step === undefined) {
						return {
							content: [{ type: "text", text: "Error: step required for remove" }],
							details: { action: "remove", items: [...planItems], nextStep, error: "step required" } as PlanDetails,
						};
					}
					const idx = planItems.findIndex((t) => t.step === params.step);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `Step #${params.step} not found` }],
							details: { action: "remove", items: [...planItems], nextStep, error: `#${params.step} not found` } as PlanDetails,
						};
					}
					planItems.splice(idx, 1);
					return {
						content: [{ type: "text", text: `Removed step #${params.step}` }],
						details: { action: "remove", items: [...planItems], nextStep } as PlanDetails,
					};
				}

				case "clear": {
					const count = planItems.length;
					planItems = [];
					nextStep = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} plan items` }],
						details: { action: "clear", items: [], nextStep: 1 } as PlanDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", items: [...planItems], nextStep, error: `unknown action: ${params.action}` } as PlanDetails,
					};
			}
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		const planFlag = pi.getFlag("plan");
		const execFlag = pi.getFlag("exec");

		if (planFlag === true) {
			planModeEnabled = true;
			execModeEnabled = false;
		} else if (execFlag === true) {
			planModeEnabled = false;
			execModeEnabled = true;
		} else if (ctx.mode === "tui") {
			planModeEnabled = true;
			execModeEnabled = false;
		} else {
			planModeEnabled = false;
			execModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { mode: "plan" | "exec" | "none"; items?: PlanItem[]; nextStep?: number } } | undefined;

		if (planModeEntry?.data && planFlag !== true && execFlag !== true) {
			planModeEnabled = planModeEntry.data.mode === "plan";
			execModeEnabled = planModeEntry.data.mode === "exec";
			if (planModeEntry.data.items) {
				planItems = planModeEntry.data.items;
			}
			if (planModeEntry.data.nextStep) {
				nextStep = planModeEntry.data.nextStep;
			}
		}

		reconstructState(ctx);

		if (planModeEnabled) {
			savedTools = pi.getActiveTools();
			pi.setActiveTools(getPlanModeTools());
		} else if (execModeEnabled) {
			pi.setActiveTools(savedTools ?? pi.getAllTools().map((t) => t.name));
		}

		updateStatus(ctx);
	});

	// Persist state on turn end
	pi.on("turn_end", async (_event, ctx) => {
		if (planModeEnabled || execModeEnabled) {
			persistState();
			updateStatus(ctx);
		}
	});
}
