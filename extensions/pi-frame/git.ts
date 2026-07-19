/**
 * Pi Frame — Git status parsing and display.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_SYMBOLS, type GitInfo } from "./types.js";

// ─── Git Parsing ─────────────────────────────────────────────────────────

export function parseGitStatus(stdout: string): GitInfo {
	const info: GitInfo = {
		branch: "",
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		deleted: 0,
		renamed: 0,
		untracked: 0,
		conflicted: 0,
		stashed: 0,
		state: "",
	};
	let oid = "";

	for (const line of stdout.split("\n")) {
		if (line.startsWith("# branch.head ")) info.branch = line.slice(14).trim();
		else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
		else if (line.startsWith("# branch.ab ")) {
			const m = line.match(/\+(\d+)\s+-(\d+)/);
			if (m) {
				info.ahead = Number(m[1]);
				info.behind = Number(m[2]);
			}
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const x = line[2];
			const y = line[3];
			if (line.startsWith("2 ")) info.renamed++;
			else if (x && x !== ".") info.staged++;
			if (y === "M") info.modified++;
			else if (y === "D") info.deleted++;
		} else if (line.startsWith("u ")) info.conflicted++;
		else if (line.startsWith("? ")) info.untracked++;
	}

	if ((!info.branch || info.branch === "(detached)") && oid && oid !== "(initial)") {
		info.branch = oid.slice(0, 7);
	}

	return info;
}

export function detectGitState(gitDir: string): string {
	if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")))
		return "REBASING";
	if (existsSync(join(gitDir, "MERGE_HEAD"))) return "MERGING";
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "CHERRY-PICKING";
	if (existsSync(join(gitDir, "REVERT_HEAD"))) return "REVERTING";
	if (existsSync(join(gitDir, "BISECT_LOG"))) return "BISECTING";
	return "";
}

// ─── Git Display ─────────────────────────────────────────────────────────

export function gitSegment(info: GitInfo | null): string {
	if (!info) return "no git";
	const parts = [info.branch || "(detached)"];
	if (info.state) parts.push(info.state);
	if (info.ahead) parts.push(`${GIT_SYMBOLS.ahead}${info.ahead}`);
	if (info.behind) parts.push(`${GIT_SYMBOLS.behind}${info.behind}`);
	if (info.staged) parts.push(`${GIT_SYMBOLS.staged}${info.staged}`);
	if (info.modified) parts.push(`${GIT_SYMBOLS.modified}${info.modified}`);
	if (info.renamed) parts.push(`${GIT_SYMBOLS.renamed}${info.renamed}`);
	if (info.deleted) parts.push(`${GIT_SYMBOLS.deleted}${info.deleted}`);
	if (info.untracked) parts.push(`${GIT_SYMBOLS.untracked}${info.untracked}`);
	if (info.conflicted) parts.push(`${GIT_SYMBOLS.conflicted}${info.conflicted}`);
	if (info.stashed) parts.push(`${GIT_SYMBOLS.stashed}${info.stashed}`);
	return parts.join(" ");
}

// ─── Git Refresh ─────────────────────────────────────────────────────────

export async function refreshGit(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitInfo | null> {
	if (!cwd) return null;

	const status = await pi
		.exec("git", ["status", "--porcelain=2", "--branch"], { cwd, timeout: 5000 })
		.catch(() => undefined);
	if (!status || status.code !== 0) return null;

	const info = parseGitStatus(status.stdout);

	const stash = await pi
		.exec("git", ["stash", "list"], { cwd, timeout: 5000 })
		.catch(() => undefined);
	if (stash?.code === 0 && stash.stdout) {
		info.stashed = stash.stdout.split("\n").filter(Boolean).length;
	}

	const gd = await pi
		.exec("git", ["rev-parse", "--absolute-git-dir"], { cwd, timeout: 5000 })
		.catch(() => undefined);
	if (gd?.code === 0 && gd.stdout) {
		info.state = detectGitState(gd.stdout.trim());
	}

	return info;
}
