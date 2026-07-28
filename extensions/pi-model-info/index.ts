/**
 * pi-model-info — Enriched model roster for pi
 *
 * Discovers all models from configured providers, fetches pricing and
 * benchmark scores from BenchLM.ai, tracks free-model availability,
 * and annotates /model with pricing, context window, and scores.
 *
 * Attribution: Benchmark data from BenchLM.ai (https://benchlm.ai), MIT license.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CATALOG_PATH,
	flushPendingWrite,
	readCatalog,
	scheduleWrite,
} from "./catalog.ts";
import type { Catalog, ProviderEntry } from "./catalog.ts";
import { getOrCreateEntry, getOrCreateProvider } from "./catalog.ts";
import { discoverModels, normalizeModelKey } from "./discovery.ts";
import { fetchBenchmarks, refreshBenchmarks } from "./benchmarks.ts";
import type { BenchmarkResult } from "./benchmarks.ts";
import { annotateAndRegister } from "./annotate.ts";
import { startProber, stopProber } from "./prober.ts";
import { loadConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Warm benchmark cache (disk read on restart, network on first run).
	// pi awaits this before firing session_start — must stay async.
	// Race against a short timeout so a slow BenchLM.ai doesn't block startup.
	await Promise.race([
		fetchBenchmarks(),
		new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
	]);

	// Shared state across handlers to avoid read-modify-write races
	let currentCatalog: Catalog | null = null;
	let currentBenchmarks: Map<string, BenchmarkResult> = new Map();
	let currentCtx: any = null;

	// --- Session lifecycle: discovery, registration, prober, real-usage ---

	pi.on("session_start", async (event, ctx) => {
		// 1. Discover models and fetch benchmarks in parallel
		const [discovered, benchmarks] = await Promise.all([
			discoverModels(ctx),
			fetchBenchmarks(),
		]);

		// 2. Load or create catalog
		const catalog: Catalog = readCatalog();
		currentCatalog = catalog;
		currentBenchmarks = benchmarks;
		currentCtx = ctx;

		// 3. Build/update catalog entries for all discovered models
		for (const model of discovered) {
			const key = normalizeModelKey(model.raw_id);
			const entry = getOrCreateEntry(catalog, key, model.cost);

			// Merge provider data
			const prov = getOrCreateProvider(entry, model.provider, model.raw_id);
			if (model.context_length && !prov.context_length) {
				prov.context_length = model.context_length;
			}

			// Apply benchmark scores (from BenchLM.ai data)
			const bm = benchmarks.get(key) ?? benchmarks.get(normalizeModelKey(model.name));
			if (bm) {
				entry.benchmarks.overall_score = bm.overall_score;
				entry.benchmarks.coding_score = bm.coding_score;
				entry.benchmarks.agentic_score = bm.agentic_score;
			}
		}

		// 4. Re-register each provider with annotated model names
		const providerIds = new Set(discovered.map((m) => m.provider));
		for (const providerId of providerIds) {
			annotateAndRegister(ctx, pi, providerId, catalog, benchmarks);
		}

		// 5. Save catalog
		scheduleWrite(catalog);

		// 6. Start background prober for free models
		startProber(catalog, () => scheduleWrite(catalog));
	});

	pi.on("after_provider_response", (event, ctx) => {
		// Capture real-usage signals for catalog updates
		const catalog = currentCatalog ?? readCatalog();
		const model = ctx.model;
		if (!model) return;

		// Skip local providers
		const baseUrl = (model as any).baseUrl ?? "";
		if (isLocalUrl(baseUrl)) return;

		const key = normalizeModelKey(model.id);
		const entry = catalog.entries[key];
		if (!entry) return;

		const prov = entry.providers[model.provider];
		if (!prov) return;

		const now = new Date().toISOString();
		prov.last_checked = now;
		prov.source = "real";

		const status = event.status;
		let statusChanged = false;

		if (status === 200 || status === 201) {
			// Success — reinforce current status, recover from prior errors
			if (prov.status === "unverified" || prov.status === "red" || prov.status === "yellow") {
				prov.status = "green";
				prov.status_reason = "ok (real usage)";
				statusChanged = true;
			}
			prov.last_real_call = now;
			prov.consecutive_synthetic_failures = 0;
		} else if (status === 404) {
			// Model genuinely gone
			prov.status = "red";
			prov.status_reason = "404 (real usage)";
			prov.status_code = 404;
			statusChanged = true;
		} else if (status === 429) {
			// Rate limited — reinforce yellow
			prov.status = "yellow";
			prov.status_reason = "rate limited (real usage)";
			prov.status_code = 429;
			statusChanged = true;
			const retryAfter = event.headers?.["retry-after"];
			if (retryAfter) {
				const seconds = parseInt(String(retryAfter), 10);
				if (!isNaN(seconds)) {
					prov.retry_after = new Date(Date.now() + seconds * 1000).toISOString();
				}
			}
		} else if (status === 401 || status === 403 || status === 402) {
			// Account-specific restriction
			prov.status = "restricted";
			prov.status_reason = `account-restricted (${status}, real usage)`;
			prov.status_code = status;
			statusChanged = true;
		} else {
			// Any other error (400, 500, 502, 503, etc.)
			prov.status = "red";
			prov.status_reason = `${status} (real usage)`;
			prov.status_code = status;
			statusChanged = true;
		}

		scheduleWrite(catalog);

		// Refresh UI if status changed
		if (statusChanged && currentCtx) {
			annotateAndRegister(currentCtx, pi, model.provider, catalog, currentBenchmarks);
		}
	});

	// Catch 429 errors that bypass after_provider_response (thrown as exceptions)
	pi.on("agent_end", async (event, ctx) => {
		if (!currentCatalog) return;

		const messages = event.messages ?? [];
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;

			// Check for error messages containing 429
			const errorText = extractErrorText(msg);
			if (!errorText) continue;

			const rateLimitInfo = parseRateLimitError(errorText);
			if (!rateLimitInfo) continue;

			// Find the model that was being used when the error occurred
			const model = ctx.model;
			if (!model) continue;

			const baseUrl = (model as any).baseUrl ?? "";
			if (isLocalUrl(baseUrl)) continue;

			const key = normalizeModelKey(model.id);
			const entry = currentCatalog.entries[key];
			if (!entry) continue;

			const prov = entry.providers[model.provider];
			if (!prov) continue;

			const now = new Date().toISOString();
			prov.last_checked = now;
			prov.source = "real";
			prov.status = "yellow";
			prov.status_reason = `rate limited (error path): ${rateLimitInfo.reason}`;
			prov.status_code = 429;

			if (rateLimitInfo.retryAfter) {
				prov.retry_after = new Date(Date.now() + rateLimitInfo.retryAfter * 1000).toISOString();
			}

			scheduleWrite(currentCatalog);

			// Refresh UI
			if (currentCtx) {
				annotateAndRegister(currentCtx, pi, model.provider, currentCatalog, currentBenchmarks);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		stopProber();
		flushPendingWrite();
	});

	// --- /refresh-models command ---

	pi.registerCommand("refresh-models", {
		description: "Force-refresh model catalog: re-discover, re-fetch benchmarks, re-probe",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Refreshing model catalog...", "info");

			const [discovered, benchmarks] = await Promise.all([
				discoverModels(ctx),
				refreshBenchmarks(),
			]);
			const catalog = readCatalog();

			// Rebuild catalog
			for (const model of discovered) {
				const key = normalizeModelKey(model.raw_id);
				const entry = getOrCreateEntry(catalog, key, model.cost);
				const prov = getOrCreateProvider(entry, model.provider, model.raw_id);
				if (model.context_length && !prov.context_length) {
					prov.context_length = model.context_length;
				}
				const bm = benchmarks.get(key) ?? benchmarks.get(normalizeModelKey(model.name));
				if (bm) {
					entry.benchmarks.overall_score = bm.overall_score;
					entry.benchmarks.coding_score = bm.coding_score;
					entry.benchmarks.agentic_score = bm.agentic_score;
				}
			}

			// Re-register providers
			const providerIds = new Set(discovered.map((m) => m.provider));
			for (const providerId of providerIds) {
				annotateAndRegister(ctx, pi, providerId, catalog, benchmarks);
			}

			flushPendingWrite();
			ctx.ui.notify(
				`Model catalog refreshed: ${Object.keys(catalog.entries).length} models, ${benchmarks.size} benchmark entries`,
				"info",
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLocalUrl(baseUrl: string): boolean {
	const lower = baseUrl.toLowerCase();
	return (
		lower.includes("localhost") ||
		lower.includes("127.0.0.1") ||
		lower.includes("0.0.0.0") ||
		lower.startsWith("http://10.") ||
		lower.startsWith("http://172.") ||
		lower.startsWith("http://192.168.")
	);
}

/**
 * Extract error text from an assistant message.
 * Looks for error content in message parts.
 */
function extractErrorText(msg: any): string | null {
	if (!msg.content) return null;

	for (const part of msg.content) {
		if (part.type === "text" && part.text) {
			// Check if this looks like an error message
			const text = part.text;
			if (text.includes("429") || text.includes("rate limit") || text.includes("rate-limit") || text.includes("rate_limit")) {
				return text;
			}
		}
		if (part.type === "error" && part.error) {
			const errorStr = typeof part.error === "string" ? part.error : JSON.stringify(part.error);
			if (errorStr.includes("429") || errorStr.includes("rate limit") || errorStr.includes("rate-limit") || errorStr.includes("rate_limit")) {
				return errorStr;
			}
		}
	}

	// Also check for errorMessage field on the message itself
	if (msg.errorMessage && (
		msg.errorMessage.includes("429") ||
		msg.errorMessage.includes("rate limit") ||
		msg.errorMessage.includes("rate-limit") ||
		msg.errorMessage.includes("rate_limit")
	)) {
		return msg.errorMessage;
	}

	return null;
}

/**
 * Parse a rate limit error text to extract retry-after and reason.
 */
function parseRateLimitError(errorText: string): { retryAfter: number | null; reason: string } | null {
	// Must contain 429 or rate limit indicators
	const hasRateLimit = /\b429\b/i.test(errorText) ||
		/rate[-_\s]?limit/i.test(errorText) ||
		/temporarily rate-limited/i.test(errorText);

	if (!hasRateLimit) return null;

	// Extract retry-after if present (seconds)
	let retryAfter: number | null = null;
	const retryMatch = errorText.match(/retry[-_\s]?after["\s:=]+(\d+)/i) ||
		errorText.match(/retry["\s:=]+(\d+)\s*seconds?/i) ||
		errorText.match(/retry in (\d+)s/i);
	if (retryMatch) {
		const seconds = parseInt(retryMatch[1], 10);
		if (!isNaN(seconds) && seconds > 0) {
			retryAfter = seconds;
		}
	}

	// Extract a short reason
	let reason = "rate limited";
	const providerMatch = errorText.match(/provider_name["\s:=]+"?([^"\n,}]+)/i);
	if (providerMatch) {
		reason = `${providerMatch[1].trim()}: rate limited`;
	}

	return { retryAfter, reason };
}
