/**
 * Configuration constants for pi-model-info
 */

import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** How long a catalog entry stays fresh before needing re-probe */
export const STALENESS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** How long to cache the BenchLM.ai benchmark data */
export const BENCHMARK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Synthetic probe budget: fraction of provider RPM to use */
export const PROBE_BUDGET_FRACTION = 0.1; // 10%

/** Minimum seconds between real call and next synthetic tick */
export const REAL_CALL_GUARD_SECONDS = 12;

/** Base interval between prober ticks (before jitter) */
export const PROBE_TICK_BASE_MS = 60_000; // 1 minute

/** Jitter range: ±20% of base interval */
export const PROBE_JITTER_FRACTION = 0.2;

/** Number of consecutive synthetic failures before flipping to red */
export const SYNTHETIC_FAILURES_THRESHOLD = 2;

/** Catalog file path */
export const CATALOG_PATH = path.join(getAgentDir(), "extensions", "pi-model-info", "model-catalog.json");

/** BenchLM.ai API endpoints */
export const BENCHLM_API_BASE = "https://benchlm.ai/api/data";
export const BENCHLM_MODELS_URL = `https://benchlm.ai/data/models.json`;

/** Provider kinds that are local and should be skipped */
export const LOCAL_PROVIDER_KINDS = new Set([
	"ollama",
	"llama.cpp",
	"lm-studio",
	"lmstudio",
	"vllm",
]);

/** Patterns in baseUrl that indicate a local provider */
export const LOCAL_BASE_URL_PATTERNS = [
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"10.",
	"172.16.",
	"172.17.",
	"172.18.",
	"172.19.",
	"172.2",
	"172.3",
	"192.168.",
];

/** Glyph prefixes for availability status */
export const STATUS_GLYPHS = {
	green: "✓",
	yellow: "~",
	red: "✗",
	restricted: "!",
	unverified: "?",
	available: "✓",
} as const;

/** ANSI color codes for status glyphs */
export const STATUS_COLORS = {
	green: "32",       // green
	yellow: "33",      // yellow
	red: "31",         // red
	restricted: "35",  // magenta
	unverified: "90",  // gray
	available: "36",   // cyan (paid models)
} as const;

export type Config = {
	excludeProviders: string[];
	excludePatterns: string[];
};

const DEFAULT_CONFIG: Config = {
	excludeProviders: ["ollama", "lmstudio"],
	excludePatterns: ["localhost", "127.0.0.1"],
};

export function loadConfig(): Config {
	return { ...DEFAULT_CONFIG };
}
