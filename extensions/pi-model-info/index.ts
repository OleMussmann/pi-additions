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

	// --- Async factory: only fetch benchmarks (no modelRegistry needed here) ---
	const benchmarks = await fetchBenchmarks();

	// --- Session lifecycle: discovery, registration, prober, real-usage ---

	pi.on("session_start", async (event, ctx) => {
		// 1. Discover all models from configured non-local providers
		const discovered = await discoverModels(ctx);

		// 2. Load or create catalog
		const catalog: Catalog = readCatalog();

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
		const catalog = readCatalog();
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

		if (status === 200 || status === 201) {
			// Success — reinforce current status
			if (prov.status === "unverified") {
				prov.status = "green";
				prov.status_reason = "ok (real usage)";
			}
			prov.last_real_call = now;
			prov.consecutive_synthetic_failures = 0;
		} else if (status === 404) {
			// Model genuinely gone
			prov.status = "red";
			prov.status_reason = "404 (real usage)";
			prov.status_code = 404;
		} else if (status === 429) {
			// Rate limited — reinforce yellow
			prov.status = "yellow";
			prov.status_reason = "rate limited (real usage)";
			prov.status_code = 429;
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
		}
		// 400 or other — don't change classification

		scheduleWrite(catalog);
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

			const benchmarks = await refreshBenchmarks();
			const discovered = await discoverModels(ctx);
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
