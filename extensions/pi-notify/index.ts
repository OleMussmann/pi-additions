/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi finishes a run and is idle,
 * waiting for your input. Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// --- Config: tools that require user interaction ---

const DEFAULT_TOOLS = ["ask_user"];
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-notify", "tools.json");

async function loadToolsRequiringInteraction(): Promise<Set<string>> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const config = JSON.parse(raw);
		if (Array.isArray(config.toolsRequiringInteraction)) {
			return new Set(config.toolsRequiringInteraction);
		}
	} catch {
		// File missing or invalid — create default config
	}

	// No valid config found — create one with defaults
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(
		CONFIG_PATH,
		JSON.stringify({ toolsRequiringInteraction: DEFAULT_TOOLS }, null, 2) + "\n",
	);
	return new Set(DEFAULT_TOOLS);
}

export default function (pi: ExtensionAPI) {
	let interactionTools = new Set<string>();

	// Load config on session start (covers /reload)
	pi.on("session_start", async () => {
		interactionTools = await loadToolsRequiringInteraction();
	});

	// agent_settled fires when Pi will not continue running automatically, i.e. it is
	// idle and waiting for input. ctx.isIdle() is true here unless another extension
	// started a new run.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.isIdle()) return;
		notify("Pi", "Ready for input");
	});

	// Notify when a tool requiring user interaction is called
	pi.on("tool_call", async (event) => {
		if (interactionTools.has(event.toolName)) {
			notify("Pi", "Waiting for your input");
		}
	});

	// Notify when guardrails intercept (path-access, permission-gate, etc.)
	pi.events.on("guardrails:prompt:opened", async () => {
		notify("Pi", "Guardrail: waiting for your input");
	});
}
