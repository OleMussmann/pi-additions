/**
 * pi-ketch — native Pi tool wrapping the `ketch` CLI for external research.
 *
 * One tool, `web`, with a `mode` enum: search | code | docs | scrape | crawl.
 * Executes `ketch` directly via child_process.execFile (no shell, no bash tool),
 * uses ketch's documented exit codes for control flow, and returns a compact
 * markdown summary to the LLM.
 *
 * Synthesis (summarized answers) is intentionally OUT of scope here: delegate to
 * the `subagent-web-search` subagent (pi-subagents) for that. pi-ketch is raw-only
 * and has no hard dependency on pi-subagents — it detects the subagent at runtime
 * and only then mentions the synthesis path.
 *
 * Load: pi -e ./extensions/pi-ketch/index.ts
 */

import { execFile } from "node:child_process";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Verbs we are willing to emit. By construction, anything else (config set,
// cache clear, mcp, browser install, --force-browser) can never be produced. ───
const ALLOWED_VERBS = new Set(["search", "code", "docs", "scrape", "crawl", "doctor", "config"]);

// ketch's documented exit codes (see ketch README "Why it works well for agents").
const EXIT_MEANING: Record<number, string> = {
	2: "bad input (validation error)",
	3: "not found",
	4: "upstream / network failure",
	5: "missing precondition (e.g. no API key configured)",
	6: "cancelled (SIGINT/SIGTERM)",
};

const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_CHARS = 4000;
const EXEC_TIMEOUT_MS = 60_000;

// ── Doctor cache: lazily populated on first web tool call. ────────────────
type DoctorResult = { surface: string; backend: string; status: string };
let doctorCache: DoctorResult[] | null = null;
let doctorChecked = false;

async function ensureDoctorCache(): Promise<void> {
	if (doctorChecked) return;
	doctorChecked = true;
	try {
		const { stdout, code } = await runKetch(["doctor", "--json"], new AbortController().signal);
		if (code !== 0) {
			doctorCache = JSON.parse(stdout) as DoctorResult[];
		} else {
			doctorCache = []; // all healthy
		}
	} catch {
		doctorCache = []; // don't retry on failure
	}
}

const WebParams = Type.Object({
	mode: StringEnum(["search", "code", "docs", "scrape", "crawl"] as const, {
		description: "ketch research surface to use.",
	}),
	query: Type.Optional(
		Type.String({ description: "Search query for mode search/code/docs." }),
	),
	url: Type.Optional(Type.String({ description: "URL (or sitemap URL) for mode scrape/crawl." })),
	library: Type.Optional(
		Type.String({ description: "docs: Context7 library ID (e.g. /org/repo) to skip resolve step." }),
	),
	lang: Type.Optional(Type.String({ description: "code: language filter (e.g. go, ts)." })),
	limit: Type.Optional(
		Type.Number({ description: "Max results to return. Default 5. Raise for breadth, lower to save context.", default: DEFAULT_LIMIT }),
	),
	maxChars: Type.Optional(
		Type.Number({ description: "Truncate the LLM-facing summary to N chars. Default 4000.", default: DEFAULT_MAX_CHARS }),
	),
	scrape: Type.Optional(
		Type.Boolean({ description: "search: fetch full content from each result.", default: false }),
	),
	multi: Type.Optional(
		Type.Boolean({ description: "search: federate across all usable backends (rank-fused).", default: false }),
	),
	backend: Type.Optional(
		Type.String({ description: "search/code/docs: explicit backend (e.g. searxng, exa, grepapp, github)." }),
	),
	regex: Type.Optional(Type.Boolean({ description: "code: treat query as regex.", default: false })),
	tokens: Type.Optional(Type.Number({ description: "docs: Context7 token budget." })),
	depth: Type.Optional(Type.Number({ description: "crawl: max BFS depth (default 3)." })),
	concurrency: Type.Optional(Type.Number({ description: "crawl: worker pool size (default 8)." })),
	allow: Type.Optional(Type.String({ description: "crawl: path substring allow filter." })),
	deny: Type.Optional(Type.String({ description: "crawl: regex deny pattern." })),
});

function pushFlag(args: string[], flag: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === false) return;
	if (value === true) {
		args.push(flag);
		return;
	}
	args.push(flag, String(value));
}

/**
 * Build the ketch argv from typed params. Only allowed verbs/flags are ever
 * emitted. Returns null if required inputs for the mode are missing.
 */
function buildArgs(params: {
	mode: string;
	query?: string;
	url?: string;
	library?: string;
	lang?: string;
	limit?: number;
	maxChars?: number;
	scrape?: boolean;
	multi?: boolean;
	backend?: string;
	regex?: boolean;
	tokens?: number;
	depth?: number;
	concurrency?: number;
	allow?: string;
	deny?: string;
}): string[] | { error: string } {
	const verb = params.mode;
	if (!ALLOWED_VERBS.has(verb)) {
		return { error: `ketch verb "${verb}" is not permitted by pi-ketch.` };
	}

	const args: string[] = [verb, "--json"];

	switch (verb) {
		case "search":
			if (!params.query) return { error: "mode 'search' requires 'query'." };
			args.push(params.query);
			pushFlag(args, "--limit", params.limit ?? DEFAULT_LIMIT);
			pushFlag(args, "--max-chars", params.maxChars ?? DEFAULT_MAX_CHARS);
			pushFlag(args, "--scrape", params.scrape);
			pushFlag(args, "--multi", params.multi);
			pushFlag(args, "--backend", params.backend);
			break;
		case "code":
			if (!params.query) return { error: "mode 'code' requires 'query'." };
			args.push(params.query);
			pushFlag(args, "--limit", params.limit ?? DEFAULT_LIMIT);
			pushFlag(args, "--lang", params.lang);
			pushFlag(args, "--regex", params.regex);
			pushFlag(args, "--backend", params.backend);
			break;
		case "docs":
			if (!params.query) return { error: "mode 'docs' requires 'query'." };
			args.push(params.query);
			pushFlag(args, "--limit", params.limit ?? DEFAULT_LIMIT);
			pushFlag(args, "--library", params.library);
			pushFlag(args, "--backend", params.backend);
			pushFlag(args, "--tokens", params.tokens);
			break;
		case "scrape":
			if (!params.url) return { error: "mode 'scrape' requires 'url'." };
			args.push(params.url);
			pushFlag(args, "--max-chars", params.maxChars ?? DEFAULT_MAX_CHARS);
			break;
		case "crawl":
			if (!params.url) return { error: "mode 'crawl' requires 'url'." };
			args.push(params.url);
			pushFlag(args, "--depth", params.depth);
			pushFlag(args, "--concurrency", params.concurrency);
			pushFlag(args, "--allow", params.allow);
			pushFlag(args, "--deny", params.deny);
			break;
		case "doctor":
		case "config":
			// read-only introspection only; never mutated
			break;
	}

	return args;
}

function runKetch(
	args: string[],
	signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const proc = execFile("ketch", args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("ketch binary not found on PATH. Install ketch (brew install 1broseidon/tap/ketch or go install github.com/1broseidon/ketch@latest)."));
				return;
			}
			// Non-zero exit is expected control flow (e.g. exit 5 missing key); resolve with code.
			let code = 0;
			if (err) {
				const anyErr = err as any;
				if (typeof anyErr.code === "number") code = anyErr.code;
				else if (anyErr.killed) code = 6;
			}
			resolve({ stdout, stderr, code });
		});
		if (signal.aborted) proc.kill("SIGTERM");
		else signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	});
}

function summarize(stdout: string, maxChars: number): string {
	let text = stdout.trim();
	// ketch --json emits either a single JSON object/array, or newline-delimited
	// JSON (one result object per line) for list output. Try both shapes.
	try {
		// 1) Whole-blob JSON (scrape, config, doctor).
		const parsed = JSON.parse(text);
		text = renderKetchJson(parsed);
	} catch {
		// 2) JSONL: parse each non-empty line independently.
		const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
		const objs: any[] = [];
		let allJson = lines.length > 0;
		for (const line of lines) {
			try {
				objs.push(JSON.parse(line));
			} catch {
				allJson = false;
				break;
			}
		}
		if (allJson && objs.length > 0) {
			text = objs.map(renderOneResult).join("\n");
		}
		// else: not JSON (e.g. plain scrape of a single page) — keep as-is.
	}
	if (text.length > maxChars) {
		text = text.slice(0, maxChars) + "\n[truncated]";
	}
	return text;
}

// Render a single parsed ketch result (code/docs rows, scrape objects, etc.).
function renderOneResult(r: any): string {
	if (typeof r === "string") return r;
	if (r && typeof r === "object") {
		if (typeof r.markdown === "string") return r.markdown;
		const title = r.title ?? (r.repo ? `${r.repo}/${r.path}` : r.url ?? "");
		const line = r.line != null ? `:${r.line}` : "";
		const snippet = r.snippet ?? r.description ?? r.text ?? "";
		const url = r.url ?? "";
		return `• ${title}${line}${snippet ? ` — ${snippet}` : ""}${url ? `  (${url})` : ""}`;
	}
	return String(r);
}

// Render a parsed JSON value (object or array) into readable lines.
function renderKetchJson(parsed: any): string {
	if (typeof parsed.markdown === "string") return parsed.markdown;
	if (Array.isArray(parsed.results)) return parsed.results.map(renderOneResult).join("\n");
	if (Array.isArray(parsed)) return parsed.map(renderOneResult).join("\n");
	return renderOneResult(parsed);
}

function helpfulError(code: number | null, stderr: string): string {
	const meaning = code !== null && EXIT_MEANING[code] ? EXIT_MEANING[code] : `exit code ${code}`;
	let msg = `ketch failed (${meaning}).`;
	if (code === 5) {
		msg += " A backend precondition is missing — run `ketch config` and set the required API key (e.g. `ketch config set brave_api_key <key>`).";
	}
	if (stderr.trim()) msg += `\n\n${stderr.trim().split("\n").slice(0, 5).join("\n")}`;
	return msg;
}

export default function (pi: ExtensionAPI): void {
	// ── Runtime subagent detection → short system note ─────────────────────
	pi.on("before_agent_start", async () => {
		let hasSubagent = false;
		try {
			hasSubagent = pi.getActiveTools().includes("subagent");
		} catch {
			hasSubagent = false;
		}

		const note = hasSubagent
			? "External research: use the `web` tool (pi-ketch) for raw web search, OSS code search, library docs, scrape, and crawl. For synthesized/summarized answers, delegate to the `subagent-web-search` subagent (via the `subagent` tool), which uses ketch under the hood. For full repo clones or YouTube transcripts, use the pi-web-access tools."
			: "External research: use the `web` tool (pi-ketch) for raw web search, OSS code search, library docs, scrape, and crawl. Note: for synthesized/summarized answers you can delegate to a research subagent if one is installed. For full repo clones or YouTube transcripts, use the pi-web-access tools.";

		return {
			message: {
				customType: "pi-ketch-context",
				content: note,
				display: false,
			},
		};
	});

	// ── The `web` tool ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "web",
		label: "Web (ketch)",
		description:
			"External research via the ketch CLI: web search, OSS code search, library docs, scrape a URL, or crawl a site. Returns a compact summary. Read-only.",
		parameters: WebParams,
		promptSnippet: "Use the web tool (pi-ketch) for external research: search, code, docs, scrape, crawl",
		promptGuidelines: [
			"Use mode 'search' for general web research; add scrape:true for full content, or multi:true to federate across backends.",
			"Use mode 'code' to find real OSS usage across repos (add lang for filtering, regex:true for regex).",
			"Use mode 'docs' for version-aware library docs (Context7); set library to /org/repo to skip resolution.",
			"Use mode 'scrape' for clean markdown from a specific URL or PDF.",
			"Use mode 'crawl' sparingly to walk a docs site / sitemap (many requests); set depth/allow/deny to bound it.",
			"For synthesized/summarized answers, delegate to the subagent-web-search subagent rather than doing it inline.",
			"Lower limit/maxChars when context is tight; raise them for broader coverage.",
			"ketch cannot clone git repos or fetch YouTube transcripts — use pi-web-access for those.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const built = buildArgs(params);
			if ("error" in built) {
				return { content: [{ type: "text", text: built.error }], isError: true };
			}

			// ── Lazy doctor cache + surface health warning ──────────────────────
			await ensureDoctorCache();
			const surfaceMap: Record<string, string> = { search: "search", code: "code", docs: "docs" };
			const surface = surfaceMap[params.mode];
			let surfaceWarning = "";
			if (surface && doctorCache && doctorCache.length > 0) {
				const hasOk = doctorCache.some((r) => r.surface === surface && r.status === "ok");
				if (!hasOk) {
					const checked = doctorCache
						.filter((r) => r.surface === surface)
						.map((r) => r.backend)
						.join(", ");
					surfaceWarning = `Warning: no healthy backends for ${surface} (checked: ${checked}). The call may fail.`;
				}
			}

			let res;
			try {
				res = await runKetch(built, signal);
			} catch (e) {
				return {
					content: [{ type: "text", text: e instanceof Error ? e.message : "Failed to run ketch." }],
					isError: true,
				};
			}

			if (res.code !== 0) {
				const errText = helpfulError(res.code, res.stderr);
				return {
					content: [{ type: "text", text: surfaceWarning ? `${surfaceWarning}\n\n${errText}` : errText }],
					isError: true,
				};
			}

			const summary = summarize(res.stdout, params.maxChars ?? DEFAULT_MAX_CHARS);
			return {
				content: [{ type: "text", text: surfaceWarning ? `${surfaceWarning}\n\n${summary}` : summary }],
			};
		},
	});
}
