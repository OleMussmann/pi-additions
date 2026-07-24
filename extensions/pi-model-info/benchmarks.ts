/**
 * Benchmark data fetcher — pulls scores from BenchLM.ai's free API.
 *
 * Attribution: Data from BenchLM.ai (https://benchlm.ai), MIT license.
 */

import { BENCHLM_LEADERBOARD_URL, BENCHMARK_CACHE_TTL_MS } from "./config.ts";

// ---------------------------------------------------------------------------
// Types matching BenchLM.ai API response shape
// ---------------------------------------------------------------------------

type BenchLMModel = {
	rank: number;
	model: string;
	creator: string;
	sourceType: string;
	overallScore: number | null;
	categoryScores: {
		agentic: number | null;
		coding: number | null;
		reasoning: number | null;
		multimodalGrounded: number | null;
		knowledge: number | null;
		multilingual: number | null;
		instructionFollowing: number | null;
		math: number | null;
	} | null;
	inputPrice: number | null;
	outputPrice: number | null;
};

type BenchLMResponse = {
	lastUpdated: string;
	models: BenchLMModel[];
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedData: BenchLMResponse | null = null;
let cacheTimestamp: number = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type BenchmarkResult = {
	overall_score: number | null;
	coding_score: number | null;
	agentic_score: number | null;
};

/**
 * Fetch benchmark scores from BenchLM.ai. Caches for 24 hours.
 * Returns a map from lowercase model name to scores.
 */
export async function fetchBenchmarks(): Promise<Map<string, BenchmarkResult>> {
	const now = Date.now();

	// Return cached data if fresh
	if (cachedData && now - cacheTimestamp < BENCHMARK_CACHE_TTL_MS) {
		return indexBenchmarks(cachedData);
	}

	try {
		const response = await fetch(BENCHLM_LEADERBOARD_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});

		if (!response.ok) {
			// Return empty on failure — soft dependency
			return new Map();
		}

		const data = (await response.json()) as BenchLMResponse;
		if (data?.models && Array.isArray(data.models)) {
			cachedData = data;
			cacheTimestamp = now;
			return indexBenchmarks(data);
		}

		return new Map();
	} catch {
		// Network error, timeout, parse error — soft dependency, return empty
		return new Map();
	}
}

/**
 * Force-refresh the benchmark cache (used by /refresh-models).
 */
export async function refreshBenchmarks(): Promise<Map<string, BenchmarkResult>> {
	cacheTimestamp = 0;
	return fetchBenchmarks();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from normalized model name → benchmark scores.
 */
function indexBenchmarks(data: BenchLMResponse): Map<string, BenchmarkResult> {
	const map = new Map<string, BenchmarkResult>();

	for (const model of data.models) {
		// Use the model name as the lookup key (lowercased, stripped)
		const key = normalizeBenchLMName(model.model);
		if (key) {
			map.set(key, {
				overall_score: model.overallScore,
				coding_score: model.categoryScores?.coding ?? null,
				agentic_score: model.categoryScores?.agentic ?? null,
			});
		}

		// Also index by creator/name combo for better matching
		const comboKey = normalizeBenchLMName(`${model.creator} ${model.model}`);
		if (comboKey && comboKey !== key) {
			map.set(comboKey, {
				overall_score: model.overallScore,
				coding_score: model.categoryScores?.coding ?? null,
				agentic_score: model.categoryScores?.agentic ?? null,
			});
		}
	}

	return map;
}

/**
 * Normalize a BenchLM model name for matching against provider model IDs.
 */
function normalizeBenchLMName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}
