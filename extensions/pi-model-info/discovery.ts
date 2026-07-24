/**
 * Provider discovery: fetch /models from all non-local providers,
 * filter to free-tier entries, normalize model IDs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LOCAL_BASE_URL_PATTERNS, LOCAL_PROVIDER_KINDS } from "./config.ts";

export type DiscoveredModel = {
	provider: string;
	raw_id: string;
	name: string;
	context_length: number | null;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoning: boolean;
	input: ("text" | "image")[];
};

/**
 * Check if a provider is local (should be skipped for probing).
 */
function isLocalProvider(provider: { id: string; baseUrl?: string; api?: string }): boolean {
	// Check provider kind
	const kind = provider.api?.toLowerCase() ?? "";
	if (LOCAL_PROVIDER_KINDS.has(provider.id.toLowerCase())) return true;
	if (LOCAL_PROVIDER_KINDS.has(kind)) return true;

	// Check baseUrl for local addresses
	const baseUrl = provider.baseUrl?.toLowerCase() ?? "";
	for (const pattern of LOCAL_BASE_URL_PATTERNS) {
		if (baseUrl.includes(pattern)) return true;
	}

	return false;
}

/**
 * Discover all models from configured non-local providers.
 * Uses ctx.modelRegistry to access the currently configured provider set.
 */
export async function discoverModels(ctx: ExtensionContext): Promise<DiscoveredModel[]> {
	const models: DiscoveredModel[] = [];

	try {
		const available = await ctx.modelRegistry.getAvailable();
		for (const model of available) {
			// Skip local providers
			if (isLocalProvider({ id: model.provider, baseUrl: undefined, api: undefined })) {
				continue;
			}

			models.push({
				provider: model.provider,
				raw_id: model.id,
				name: model.name ?? model.id,
				context_length: model.contextWindow ?? null,
				cost: {
					input: model.cost?.input ?? 0,
					output: model.cost?.output ?? 0,
					cacheRead: model.cost?.cacheRead ?? 0,
					cacheWrite: model.cost?.cacheWrite ?? 0,
				},
				reasoning: model.reasoning ?? false,
				input: (model.input as ("text" | "image")[]) ?? ["text"],
			});
		}
	} catch {
		// modelRegistry not available or empty — return empty
	}

	return models;
}

/**
 * Normalize a model ID to a canonical key for cross-provider matching.
 *
 * Rules (from plan §4.2):
 * 1. Strip known provider path prefixes
 * 2. Strip :free / -free / similar suffixes
 * 3. Lowercase, collapse separators (-, _, .) to a single form
 */
export function normalizeModelKey(rawId: string): string {
	let key = rawId;

	// Strip everything before the last slash (provider prefix)
	// e.g. "xiaomi/mimo-v2.5-free" → "mimo-v2.5-free"
	//      "anthropic/claude-sonnet-4" → "claude-sonnet-4"
	const lastSlash = key.lastIndexOf("/");
	if (lastSlash !== -1) {
		key = key.slice(lastSlash + 1);
	}

	// Strip free-tier suffixes
	key = key.replace(/:free$/i, "");
	key = key.replace(/-free$/i, "");

	// Strip inference-optimization suffixes (MTP = multi-token prediction,
	// a speculative decoding speed boost; same model weights/accuracy)
	key = key.replace(/-mtp$/i, "");

	// Lowercase
	key = key.toLowerCase();

	// Collapse separators (spaces, underscores, dots) to hyphens
	key = key.replace(/[_\.\s]+/g, "-");

	// Collapse multiple hyphens
	key = key.replace(/-{2,}/g, "-");

	// Strip leading/trailing hyphens
	key = key.replace(/^-+|-+$/g, "");

	return key || rawId;
}
