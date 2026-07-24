/**
 * Build enriched model roster and register providers with annotated names.
 *
 * The annotation adds benchmark scores and context window to each model's
 * name field in /model. Free models also get availability glyph prefixes
 * (✓, ~, ✗, !, ?). The entire name line is colorized based on availability
 * status. Cost is NOT added to the name — pi's UI displays it separately
 * from the catalog's cost field.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Catalog, CatalogEntry } from "./catalog.ts";
import type { BenchmarkResult } from "./benchmarks.ts";
import { STATUS_GLYPHS, STATUS_COLORS } from "./config.ts";
import { normalizeModelKey } from "./discovery.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the enriched model roster for a provider and register it.
 * Preserves user's models.json custom entries by starting from getAll().
 */
export function annotateAndRegister(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	providerId: string,
	catalog: Catalog,
	benchmarks: Map<string, BenchmarkResult>,
): void {
	const models = getProviderModels(ctx, providerId);
	if (models.length === 0) return;

	const enriched = models.map((model) => {
		const modelKey = normalizeModelKey(model.id);
		const entry = catalog.entries[modelKey];
		const benchmark = benchmarks.get(modelKey) ?? findBenchmarkByFallback(model, benchmarks);

		return {
			...model,
			name: buildAnnotatedName(model, entry, benchmark, providerId),
		};
	});

	try {
		pi.registerProvider(providerId, {
			models: enriched as any,
		});
	} catch {
		// Fail-closed: skip re-registration, provider stays as pi shipped it
	}
}

// ---------------------------------------------------------------------------
// Name annotation
// ---------------------------------------------------------------------------

function buildAnnotatedName(
	model: Model<Api>,
	entry: CatalogEntry | undefined,
	benchmark: BenchmarkResult | undefined,
	providerId: string,
): string {
	// Strip ALL existing annotations from the name to avoid accumulation.
	// ctx.modelRegistry.getAll() returns registered models (with our annotations),
	// not the original source models. So on reload, we must strip everything.
	const rawName = model.name ?? model.id;
	const baseName = rawName
		.replace(/^(?:\x1b\[\d+m)?[✓~✗!?](?:\x1b\[0m)?\s*/, "")  // strip leading glyph (with optional ANSI)
		.replace(/^\x1b\[\d+m/, "")  // strip any leading ANSI code (whole-line color)
		.replace(/\x1b\[0m$/, "")     // strip trailing reset
		.replace(/\s*\(.*$/, "")      // strip everything from first ( onward
		.replace(/\s*—\s*(unavailable|restricted|not recently checked|available).*$/, "") // strip status suffix
		.trim() || rawName;

	const parts: string[] = [];

	// Determine status for the model
	let status: string;
	if (entry?.is_free) {
		// Free model - use its actual status
		const providerData = entry.providers[providerId];
		status = providerData?.status ?? "green";
	} else if (entry) {
		// Paid model - default to "available" unless restricted/red
		const providerData = entry.providers[providerId];
		status = providerData?.status === "restricted" || providerData?.status === "red"
			? providerData.status
			: "available";
	} else {
		// No catalog entry yet - default to available
		status = "available";
	}

	// Add status glyph prefix
	const glyph = STATUS_GLYPHS[status] ?? STATUS_GLYPHS.green;
	if (glyph) {
		parts.push(glyph);
	}

	// Model name
	parts.push(baseName);

	// Metadata parenthetical
	const meta: string[] = [];

	// Pricing
	const cost = entry?.cost ?? { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 };
	if (cost.input === 0 && cost.output === 0) {
		meta.push("$0/$0");
	} else {
		meta.push("$" + cost.input + "/$" + cost.output);
	}

	// Context window
	const ctx = entry?.providers[providerId]?.context_length ?? model.contextWindow ?? null;
	if (ctx) {
		meta.push(formatContextWindow(ctx));
	} else {
		meta.push("?");
	}

	// Benchmark score: use the overall BenchLM.ai display score (top-level
	// displayScore from models.json), which matches the leaderboard. We used
	// to prefer coding_score but it diverges from the web page and confuses
	// users — the overall score is the canonical metric BenchLM exposes.
	const score = benchmark?.overall_score ?? null;
	if (score !== null) {
		meta.push(`${Math.round(score)}%`);
	}

	// Rate limit note for yellow status (free models only)
	if (entry?.is_free && entry.providers[providerId]?.status === "yellow") {
		const rpm = entry.providers[providerId]?.rpm_documented;
		if (rpm) {
			meta.push(`~${rpm} req/min`);
		}
	}

	if (meta.length > 0) {
		parts.push(`(${meta.join(" · ")})`);
	}

	// Status suffix for restricted/unverified/red (free models only)
	if (entry?.is_free) {
		const providerData = entry.providers[providerId];
		if (providerData?.status === "red") {
			parts.push("— unavailable");
		} else if (providerData?.status === "restricted") {
			parts.push("— restricted");
		} else if (providerData?.status === "unverified") {
			parts.push("— not recently checked");
		}
	}

	// Assemble result and wrap the WHOLE line in color
	const result = parts.join(" ");
	const color = STATUS_COLORS[status] ?? "";
	return color ? `\x1b[${color}m${result}\x1b[0m` : result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProviderModels(ctx: ExtensionContext, providerId: string): Model<Api>[] {
	try {
		const all = ctx.modelRegistry?.getAll?.() ?? [];
		return all.filter((m: Model<Api>) => m.provider === providerId);
	} catch {
		return [];
	}
}

/** Known variant suffixes that providers add but BenchLM doesn't track. */
const VARIANT_SUFFIXES = [
	/-fast$/i,
	/-extended$/i,
	/-preview$/i,
	/-beta$/i,
	/-alpha$/i,
	/-latest$/i,
	/-exp$/i,
];

function stripVariantSuffixes(key: string): string {
	for (const re of VARIANT_SUFFIXES) {
		key = key.replace(re, "");
	}
	// Collapse any trailing hyphens left behind
	return key.replace(/-+$/, "");
}

function findBenchmarkByFallback(
	model: Model<Api>,
	benchmarks: Map<string, BenchmarkResult>,
): BenchmarkResult | undefined {
	// Use the same normalization as the catalog key
	const key = normalizeModelKey(model.id);
	if (benchmarks.has(key)) return benchmarks.get(key);

	// Also try the model name
	const nameKey = normalizeModelKey(model.name ?? model.id);
	if (benchmarks.has(nameKey)) return benchmarks.get(nameKey);

	// Strip known variant suffixes and try again
	const baseKey = stripVariantSuffixes(key);
	if (baseKey !== key && benchmarks.has(baseKey)) {
		return benchmarks.get(baseKey);
	}
	const baseNameKey = stripVariantSuffixes(nameKey);
	if (baseNameKey !== nameKey && benchmarks.has(baseNameKey)) {
		return benchmarks.get(baseNameKey);
	}

	// Try partial match as last resort (require at least 6 chars to avoid
	// trivial matches like "gpt" matching everything)
	if (key.length >= 6) {
		for (const [bmKey, value] of benchmarks) {
			if (bmKey.length >= 6 && (bmKey.includes(key) || key.includes(bmKey))) {
				return value;
			}
		}
	}

	return undefined;
}

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
	}
	return `${Math.round(tokens / 1000)}k`;
}