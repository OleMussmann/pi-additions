/**
 * Benchmark data fetcher — pulls scores from BenchLM.ai's free API.
 *
 * Attribution: Data from BenchLM.ai (https://benchlm.ai), MIT license.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BENCHLM_MODELS_URL, BENCHMARK_CACHE_TTL_MS } from "./config.ts";
import { CATALOG_PATH } from "./config.ts";

// ---------------------------------------------------------------------------
// Types matching BenchLM.ai models.json response shape
// ---------------------------------------------------------------------------

type BenchLMModel = {
	model: string;
	creator: string;
	displayScore: number | null;
	scores: {
		displayScore: number | null;
		displayCategoryScores: {
			agentic: number | null;
			coding: number | null;
			reasoning: number | null;
			multimodalGrounded: number | null;
			knowledge: number | null;
			multilingual: number | null;
			instructionFollowing: number | null;
			math: number | null;
		} | null;
	} | null;
};

type BenchLMResponse = {
	items: BenchLMModel[];
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedData: BenchLMResponse | null = null;
let cacheTimestamp: number = 0;

const DISK_CACHE_PATH = path.join(path.dirname(CATALOG_PATH), "benchmarks-cache.json");

function loadDiskCache(): BenchLMResponse | null {
	try {
		const raw = fs.readFileSync(DISK_CACHE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as { timestamp: number; data: BenchLMResponse };
		if (parsed?.data?.items && Array.isArray(parsed.data.items)) {
			return { timestamp: parsed.timestamp, data: parsed.data } as any;
		}
	} catch {
		// Missing or corrupt cache — fine
	}
	return null;
}

function saveDiskCache(data: BenchLMResponse): void {
	try {
		const dir = path.dirname(DISK_CACHE_PATH);
		fs.mkdirSync(dir, { recursive: true });
		const tmpPath = `${DISK_CACHE_PATH}.tmp.${Date.now()}`;
		fs.writeFileSync(tmpPath, JSON.stringify({ timestamp: Date.now(), data }), "utf-8");
		fs.renameSync(tmpPath, DISK_CACHE_PATH);
	} catch {
		// Best-effort — ignore write errors
	}
}

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

	// Return in-memory cached data if fresh
	if (cachedData && now - cacheTimestamp < BENCHMARK_CACHE_TTL_MS) {
		return indexBenchmarks(cachedData);
	}

	// Try disk cache (instant, no network)
	const disk = loadDiskCache();
	if (disk && disk.timestamp && now - disk.timestamp < BENCHMARK_CACHE_TTL_MS) {
		cachedData = disk.data;
		cacheTimestamp = disk.timestamp;
		return indexBenchmarks(disk.data);
	}

	// Network fetch (slow path)
	try {
		const response = await fetch(BENCHLM_MODELS_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});

		if (!response.ok) {
			// Return empty on failure — soft dependency
			return new Map();
		}

		const data = (await response.json()) as BenchLMResponse;
		if (data?.items && Array.isArray(data.items)) {
			cachedData = data;
			cacheTimestamp = now;
			saveDiskCache(data);
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

	for (const model of data.items) {
		// Use the model name as the lookup key (lowercased, stripped)
		const key = normalizeBenchLMName(model.model);
		if (key) {
			map.set(key, {
				overall_score: model.displayScore ?? model.scores?.displayScore ?? null,
				coding_score: model.scores?.displayCategoryScores?.coding ?? null,
				agentic_score: model.scores?.displayCategoryScores?.agentic ?? null,
			});
		}

		// Also index by creator/name combo for better matching
		const comboKey = normalizeBenchLMName(`${model.creator} ${model.model}`);
		if (comboKey && comboKey !== key) {
			map.set(comboKey, {
				overall_score: model.displayScore ?? model.scores?.displayScore ?? null,
				coding_score: model.scores?.displayCategoryScores?.coding ?? null,
				agentic_score: model.scores?.displayCategoryScores?.agentic ?? null,
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
