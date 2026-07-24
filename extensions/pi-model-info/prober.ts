/**
 * Background liveness prober for free models.
 *
 * Rate-shaped trickle: probes the stalest free models at ~10% of provider RPM,
 * with jitter and retry-after awareness.
 */

import type { Catalog, ProviderEntry } from "./catalog.ts";
import {
	PROBE_BUDGET_FRACTION,
	PROBE_JITTER_FRACTION,
	PROBE_TICK_BASE_MS,
	REAL_CALL_GUARD_SECONDS,
	SYNTHETIC_FAILURES_THRESHOLD,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProbeResult = {
	status: "green" | "yellow" | "red" | "restricted";
	status_reason: string;
	status_code: number;
	context_length: number | null;
	retry_after: string | null;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probing = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the background prober. Call from session_start.
 * Stops on stopProbing() or session_shutdown.
 */
export function startProber(
	catalog: Catalog,
	onUpdate: () => void,
): void {
	if (probing) return;
	probing = true;
	scheduleTick(catalog, onUpdate);
}

/**
 * Stop the background prober. Call from session_shutdown.
 */
export function stopProber(): void {
	probing = false;
	if (probeTimer) {
		clearTimeout(probeTimer);
		probeTimer = null;
	}
}

/**
 * Probe a single model/provider combination.
 * Returns the probe result without modifying the catalog (caller applies).
 */
export async function probeModel(
	providerId: string,
	modelId: string,
	baseUrl: string | undefined,
): Promise<ProbeResult> {
	try {
		// Build a minimal chat completions request to test liveness
		const url = baseUrl ? `${baseUrl}/chat/completions` : undefined;
		if (!url) {
			return {
				status: "red",
				status_reason: "no baseUrl configured",
				status_code: 0,
				context_length: null,
				retry_after: null,
			};
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 12_000);

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: modelId,
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 1,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			const status = response.status;
			const retryAfter = response.headers.get("retry-after");

			if (status === 200 || status === 201) {
				return {
					status: "green",
					status_reason: "ok",
					status_code: status,
					context_length: null,
					retry_after: null,
				};
			}

			if (status === 429) {
				return {
					status: "yellow",
					status_reason: "rate limited",
					status_code: status,
					context_length: null,
					retry_after: retryAfter
						? new Date(Date.now() + parseInt(retryAfter, 10) * 1000).toISOString()
						: null,
				};
			}

			if (status === 404) {
				return {
					status: "red",
					status_reason: "not found (404)",
					status_code: status,
					context_length: null,
					retry_after: null,
				};
			}

			if (status === 401 || status === 403 || status === 402) {
				return {
					status: "restricted",
					status_reason: `account-restricted (${status})`,
					status_code: status,
					context_length: null,
					retry_after: null,
				};
			}

			// 400 or other — don't change classification
			return {
				status: "green",
				status_reason: `unexpected ${status} — treating as alive`,
				status_code: status,
				context_length: null,
				retry_after: null,
			};
		} catch (fetchErr: any) {
			clearTimeout(timeout);
			if (fetchErr?.name === "AbortError") {
				return {
					status: "yellow",
					status_reason: "timeout",
					status_code: 0,
					context_length: null,
					retry_after: null,
				};
			}
			return {
				status: "yellow",
				status_reason: `network error: ${fetchErr?.message ?? "unknown"}`,
				status_code: 0,
				context_length: null,
				retry_after: null,
			};
		}
	} catch {
		return {
			status: "yellow",
			status_reason: "probe failed",
			status_code: 0,
			context_length: null,
			retry_after: null,
		};
	}
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function scheduleTick(catalog: Catalog, onUpdate: () => void): void {
	if (!probing) return;

	const jitter = 1 + (Math.random() * 2 - 1) * PROBE_JITTER_FRACTION;
	const delay = PROBE_TICK_BASE_MS * jitter;

	probeTimer = setTimeout(async () => {
		if (!probing) return;
		await runTick(catalog, onUpdate);
		scheduleTick(catalog, onUpdate);
	}, delay);
}

async function runTick(catalog: Catalog, onUpdate: () => void): Promise<void> {
	// Collect stale free models, sorted by oldest last_checked
	const now = new Date();
	const candidates: Array<{
		modelKey: string;
		providerId: string;
		provider: ProviderEntry;
	}> = [];

	for (const [modelKey, entry] of Object.entries(catalog.entries)) {
		if (!entry.is_free) continue;

		for (const [providerId, prov] of Object.entries(entry.providers)) {
			if (prov.status === "red") continue; // skip confirmed dead
			if (!isRetryAfterExpired(prov, now)) continue; // still cooling down
			if (!isRecentlyUsedByRealCall(prov, now)) {
				// Only consider if not recently used by real traffic
			}
			if (isStale(prov, now)) {
				candidates.push({ modelKey, providerId, provider: prov });
			}
		}
	}

	if (candidates.length === 0) return;

	// Sort by oldest last_checked first
	candidates.sort((a, b) => {
		const tA = new Date(a.provider.last_checked).getTime();
		const tB = new Date(b.provider.last_checked).getTime();
		return tA - tB;
	});

	// Probe a small batch (respecting budget)
	const batchSize = Math.max(1, Math.min(3, candidates.length));
	const batch = candidates.slice(0, batchSize);

	for (const { modelKey, providerId, provider } of batch) {
		const result = await probeModel(providerId, provider.raw_id, undefined);

		// Apply result to catalog
		provider.last_checked = now.toISOString();
		provider.status_code = result.status_code;

		if (result.status === "red" && provider.status !== "red") {
			provider.consecutive_synthetic_failures++;
			if (provider.consecutive_synthetic_failures >= SYNTHETIC_FAILURES_THRESHOLD) {
				provider.status = "red";
				provider.status_reason = result.status_reason;
			}
		} else if (result.status === "green" || result.status === "yellow") {
			provider.status = result.status;
			provider.status_reason = result.status_reason;
			provider.consecutive_synthetic_failures = 0;
		} else if (result.status === "restricted") {
			provider.status = "restricted";
			provider.status_reason = result.status_reason;
			provider.consecutive_synthetic_failures = 0;
		}

		if (result.retry_after) {
			provider.retry_after = result.retry_after;
		}
		if (result.context_length) {
			provider.context_length = result.context_length;
		}
	}

	onUpdate();
}

function isStale(provider: ProviderEntry, now: Date): boolean {
	const lastChecked = new Date(provider.last_checked).getTime();
	return now.getTime() - lastChecked > 24 * 60 * 60 * 1000;
}

function isRetryAfterExpired(provider: ProviderEntry, now: Date): boolean {
	if (!provider.retry_after) return true;
	return now.getTime() > new Date(provider.retry_after).getTime();
}

function isRecentlyUsedByRealCall(provider: ProviderEntry, now: Date): boolean {
	if (!provider.last_real_call) return false;
	const lastReal = new Date(provider.last_real_call).getTime();
	return now.getTime() - lastReal < REAL_CALL_GUARD_SECONDS * 1000;
}
