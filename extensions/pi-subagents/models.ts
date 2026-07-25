/**
 * Live model discovery and tier assignment for subagent-plus
 *
 * Scores available free models using metadata (contextWindow, maxTokens, reasoning, multimodal),
 * computes 33rd/67th percentile cutoffs within the free-only pool, and assigns them
 * to fast/balanced/powerful tiers. Optionally integrates with pi-model-info's catalog
 * for availability-aware model selection (green > unverified > yellow).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./config.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type Tier = "fast" | "balanced" | "powerful";

/**
 * Local provider names that should never be used by subagents.
 * These compete with the main model for VRAM and may not be running.
 *
 * Source of truth: pi-model-info's LOCAL_PROVIDER_KINDS set — keep in sync.
 */
const LOCAL_PROVIDER_NAMES = new Set([
	"ollama",
	"llama.cpp",
	"lm-studio",
	"lmstudio",
	"llama-swap",
	"vllm",
]);

/**
 * Base URL patterns that indicate a local inference endpoint.
 *
 * Source of truth: pi-model-info's LOCAL_BASE_URL_PATTERNS — keep in sync.
 */
const LOCAL_URL_PATTERNS = [
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"10.",
	"172.",
	"192.168.",
];

interface ScoredModel {
	model: Model<Api>;
	score: number;
}

function isExcluded(model: Model<Api>, config: SubagentConfig): boolean {
	// Built-in local provider detection (always-on, mirrors pi-model-info's logic)
	if (LOCAL_PROVIDER_NAMES.has(model.provider.toLowerCase())) return true;
	const baseUrl = (model as any).baseUrl;
	if (typeof baseUrl === "string") {
		const lower = baseUrl.toLowerCase();
		for (const pattern of LOCAL_URL_PATTERNS) {
			if (lower.includes(pattern)) return true;
		}
	}

	// Config-based exclusions (user overrides)
	if (config.excludeProviders.includes(model.provider)) return true;
	const id = `${model.provider}/${model.id}`;
	for (const pattern of config.excludePatterns) {
		if (id.includes(pattern) || model.provider.includes(pattern)) return true;
	}
	return false;
}

function isZeroCost(model: Model<Api>): boolean {
	const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return cost.input === 0 && cost.output === 0;
}

function computeScore(model: Model<Api>): number {
	let score = 0;
	score += (model.contextWindow ?? 128000) / 1000;
	score += (model.maxTokens ?? 16384) / 100;
	if (model.reasoning) score += 500;
	if ((model.input ?? []).includes("image")) score += 100;
	return score;
}

export interface TierPools {
	fast: Model<Api>[];
	balanced: Model<Api>[];
	powerful: Model<Api>[];
	all: Model<Api>[];
}

export async function discoverTierPools(ctx: ExtensionContext, config: SubagentConfig): Promise<TierPools | null> {
	const available = await ctx.modelRegistry.getAvailable();
	if (available.length === 0) return null;

	// Exclude the parent's current model so subagents don't compete for it
	const parentModel = ctx.model;

	// Filter to free, non-local models first, THEN score & percentile within that pool
	const freeScored = available
		.filter((model) => !(parentModel && model.provider === parentModel.provider && model.id === parentModel.id))
		.filter((model) => isZeroCost(model) && !isExcluded(model, config))
		.map((model): ScoredModel => ({
			model,
			score: computeScore(model),
		}));

	if (freeScored.length === 0) return null;

	freeScored.sort((a, b) => a.score - b.score);

	const p33Index = Math.floor(freeScored.length * 0.33);
	const p67Index = Math.floor(freeScored.length * 0.67);
	const p33Score = freeScored[p33Index]?.score ?? 0;
	const p67Score = freeScored[p67Index]?.score ?? Infinity;

	// Assign tiers based on free-only percentiles
	const fast: Model<Api>[] = [];
	const balanced: Model<Api>[] = [];
	const powerful: Model<Api>[] = [];

	for (const s of freeScored) {
		if (s.score <= p33Score) {
			fast.push(s.model);
		} else if (s.score <= p67Score) {
			balanced.push(s.model);
		} else {
			powerful.push(s.model);
		}
	}

	return { fast, balanced, powerful, all: freeScored.map((s) => s.model) };
}

export function pickModelForTier(pools: TierPools, tier: Tier): { model: Model<Api>; actualTier: Tier | "auto" } | null {
	// Pick the best model in the requested tier (highest score = last in sorted-by-score list)
	const pool = pools[tier];
	if (pool.length > 0) {
		return { model: pool[pool.length - 1], actualTier: tier };
	}

	// Fallback chain: powerful -> balanced -> fast -> any
	const fallbackChain: Tier[] = ["powerful", "balanced", "fast"];
	const currentIndex = fallbackChain.indexOf(tier);
	for (let i = currentIndex + 1; i < fallbackChain.length; i++) {
		const fb = pools[fallbackChain[i]];
		if (fb.length > 0) {
			return { model: fb[fb.length - 1], actualTier: fallbackChain[i] };
		}
	}

	// If all tiers empty, pick any free model. Label it "auto" so the reported
	// tier is honest (it is NOT the requested tier).
	if (pools.all.length > 0) {
		return { model: pools.all[pools.all.length - 1], actualTier: "auto" };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Catalog-aware model selection (optional pi-model-info integration)
// ---------------------------------------------------------------------------

export type AvailabilityStatus = "green" | "yellow" | "red" | "restricted" | "unverified";

interface ProviderEntry {
	raw_id: string;
	status: AvailabilityStatus;
}

interface CatalogEntry {
	is_free: boolean;
	providers: Record<string, ProviderEntry>;
}

export interface Catalog {
	schema_version: number;
	entries: Record<string, CatalogEntry>;
}

const DEFAULT_CATALOG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"pi-model-info",
	"model-catalog.json",
);

/**
 * Read the pi-model-info catalog. Returns null if the file is missing,
 * malformed, or has an unknown schema version. Always fails open.
 */
export function readCatalog(catalogPath?: string): Catalog | null {
	const resolvedPath = catalogPath || DEFAULT_CATALOG_PATH;
	try {
		const raw = fs.readFileSync(resolvedPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<Catalog>;
		if (parsed.schema_version === 1 && parsed.entries) {
			return parsed as Catalog;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Build a reverse map from "provider/raw_id" → normalized key,
 * so model status lookups don't need to duplicate normalization logic.
 */
export function buildReverseMap(catalog: Catalog): Map<string, string> {
	const map = new Map<string, string>();
	for (const [normKey, entry] of Object.entries(catalog.entries)) {
		for (const [provId, prov] of Object.entries(entry.providers)) {
			map.set(`${provId}/${prov.raw_id}`, normKey);
		}
	}
	return map;
}

/**
 * Get the availability status of a model from the catalog.
 * Returns "unverified" if the model or its provider is not found.
 */
function getModelStatus(
	model: Model<Api>,
	catalog: Catalog,
	reverseMap: Map<string, string>,
): AvailabilityStatus {
	const normKey = reverseMap.get(`${model.provider}/${model.id}`);
	if (!normKey) return "unverified";
	const entry = catalog.entries[normKey];
	if (!entry) return "unverified";
	const prov = entry.providers[model.provider];
	if (!prov) return "unverified";
	return prov.status;
}

/**
 * Compute tier visitation order: target tier first, then higher-capability
 * tiers, then lower-capability tiers.
 */
function computeTierOrder(tier: Tier): Tier[] {
	const allTiers: Tier[] = ["powerful", "balanced", "fast"];
	const idx = allTiers.indexOf(tier);
	return [tier, ...allTiers.slice(0, idx), ...allTiers.slice(idx + 1)];
}

/**
 * Status-aware model picker using the pi-model-info catalog.
 *
 * Three-pass ladder:
 *   Pass 1 — green models in tier order (target → higher → lower)
 *   Pass 2 — unverified models in tier order
 *   Pass 3 — yellow models in tier order
 *
 * If all models are red or restricted: returns null (existing error handling
 * produces a clear "no free model available" message).
 *
 * Falls back to pickModelForTier() when no catalog is available.
 */
export function pickModelWithAvailability(
	pools: TierPools,
	tier: Tier,
	catalog: Catalog | null,
	reverseMap: Map<string, string> | null,
): { model: Model<Api>; actualTier: Tier | "auto" } | null {
	if (!catalog || !reverseMap) {
		return pickModelForTier(pools, tier);
	}

	const tierOrder = computeTierOrder(tier);
	const statusPriority: AvailabilityStatus[] = ["green", "unverified", "yellow"];

	// Three passes: green → unverified → yellow
	for (const status of statusPriority) {
		for (const t of tierOrder) {
			const candidates = pools[t].filter(
				(m) => getModelStatus(m, catalog, reverseMap) === status,
			);
			if (candidates.length > 0) {
				return { model: candidates[candidates.length - 1], actualTier: t };
			}
		}
	}

	// All models in all tiers are red or restricted
	return null;
}
