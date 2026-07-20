/**
 * Guardrail extension for subagent child processes
 *
 * Injected into every subagent pi process via --extension flag.
 * Enforces:
 * 1. Read-only bash commands only (allowlist + blocklist)
 * 2. Sensitive path blocking for read/ls/grep/find
 * 3. .gitignore pattern auto-detection
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Default sensitive paths and patterns
const DEFAULT_SENSITIVE_PATTERNS = [
	"~/.ssh",
	"~/.aws",
	"~/.gnupg",
	"~/.docker",
	"~/.kube",
	"~/.npmrc",
	"~/.pypirc",
	"~/.netrc",
	"~/.gemrc",
	".env",
	".env.local",
	".env.production",
	".env.development",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"credentials.json",
	"service-account.json",
];

// Destructive commands blocked in subagents
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in subagents
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(process.env.HOME || "/", p.slice(2));
	}
	return p;
}

function parseGitignore(cwd: string): string[] {
	const gitignorePath = path.join(cwd, ".gitignore");
	if (!fs.existsSync(gitignorePath)) return [];
	try {
		const content = fs.readFileSync(gitignorePath, "utf-8");
		return content
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"));
	} catch {
		return [];
	}
}

function matchesPattern(filePath: string, pattern: string): boolean {
	const normalized = path.normalize(filePath);
	const expanded = expandHome(pattern);

	// Exact match
	if (normalized === expanded || normalized === path.normalize(expanded)) return true;

	// Directory containment
	if (pattern.endsWith("/") || fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
		const dir = expanded.endsWith("/") ? expanded.slice(0, -1) : expanded;
		if (normalized.startsWith(dir + path.sep) || normalized === dir) return true;
	}

	// Glob-style suffix (e.g., *.pem)
	if (pattern.startsWith("*.")) {
		const ext = pattern.slice(1);
		if (normalized.endsWith(ext)) return true;
	}

	// Name match (e.g., id_rsa matches anywhere)
	const basename = path.basename(normalized);
	if (basename === pattern || basename.startsWith(pattern + ".")) return true;

	return false;
}

function isSensitivePath(filePath: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (matchesPattern(filePath, pattern)) return true;
	}
	return false;
}

function extractPathFromArgs(toolName: string, args: Record<string, unknown>): string | null {
	switch (toolName) {
		case "read":
			return (args.path as string) || (args.file_path as string) || null;
		case "ls":
			return (args.path as string) || ".";
		case "grep":
			return (args.path as string) || ".";
		case "find":
			return (args.path as string) || ".";
		case "bash": {
			const command = (args.command as string) || "";
			// Try to extract first path-like argument
			const match = command.match(/\s+([~./][^\s]*)/);
			return match ? match[1] : null;
		}
		default:
			return null;
	}
}

function extractAllPaths(command: string): string[] {
	// Match every path-like token: starts with ~ ./ or / and contains no whitespace.
	const matches = command.matchAll(/\s+([~./][^\s]*)/g);
	const paths: string[] = [];
	for (const m of matches) {
		paths.push(m[1]);
	}
	return paths;
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const gitignorePatterns = parseGitignore(cwd);
	const sensitivePatterns = [...DEFAULT_SENSITIVE_PATTERNS, ...gitignorePatterns];

	pi.on("tool_call", async (event) => {
		// Block non-safe bash commands
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Subagent guardrail: bash command blocked. Only read-only commands are allowed.\nCommand: ${command}`,
				};
			}
		}

		// Block sensitive path access for read/ls/grep/find/bash
		if (event.toolName === "bash") {
			const command = (event.input.command as string) || "";
			for (const pathArg of extractAllPaths(command)) {
				const resolved = path.resolve(cwd, expandHome(pathArg));
				if (isSensitivePath(resolved, sensitivePatterns)) {
					return {
						block: true,
						reason: `Subagent guardrail: access to sensitive path blocked.\nPath: ${pathArg}`,
					};
				}
			}
		} else {
			const pathArg = extractPathFromArgs(event.toolName, event.input);
			if (pathArg) {
				const resolved = path.resolve(cwd, expandHome(pathArg));
				if (isSensitivePath(resolved, sensitivePatterns)) {
					return {
						block: true,
						reason: `Subagent guardrail: access to sensitive path blocked.\nPath: ${pathArg}`,
					};
				}
			}
		}
	});
}
