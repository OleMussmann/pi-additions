/**
 * Live model discovery and tier assignment for subagent-plus
 *
 * Scores ALL available models using metadata (contextWindow, maxTokens, reasoning, multimodal),
 * computes global 33rd/67th percentile cutoffs, then filters to zero-cost non-local models
 * and assigns them to fast/balanced/powerful tiers.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./config.ts";

export type Tier = "fast" | "balanced" | "powerful";

interface ScoredModel {
	model: Model<Api>;
	score: number;
}

function isExcluded(model: Model<Api>, config: SubagentConfig): boolean {
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

	// Score ALL available models (not just free) to compute global percentiles
	const scored = available
		.filter((model) => !(parentModel && model.provider === parentModel.provider && model.id === parentModel.id))
		.map((model): ScoredModel => ({
			model,
			score: computeScore(model),
		}));

	scored.sort((a, b) => a.score - b.score);

	const p33Index = Math.floor(scored.length * 0.33);
	const p67Index = Math.floor(scored.length * 0.67);
	const p33Score = scored[p33Index]?.score ?? 0;
	const p67Score = scored[p67Index]?.score ?? Infinity;

	// Filter to zero-cost, non-local models
	const free = scored
		.filter((s) => isZeroCost(s.model) && !isExcluded(s.model, config))
		.map((s) => s.model);

	if (free.length === 0) return null;

	// Assign tiers based on global percentiles
	const fast: Model<Api>[] = [];
	const balanced: Model<Api>[] = [];
	const powerful: Model<Api>[] = [];

	for (const s of scored) {
		if (!isZeroCost(s.model) || isExcluded(s.model, config)) continue;
		if (s.score <= p33Score) {
			fast.push(s.model);
		} else if (s.score <= p67Score) {
			balanced.push(s.model);
		} else {
			powerful.push(s.model);
		}
	}

	return { fast, balanced, powerful, all: free };
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
