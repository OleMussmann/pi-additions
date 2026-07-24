/**
 * Catalog schema types and atomic read/write for pi-model-info
 *
 * The catalog tracks all models from configured providers with:
 * - Cost (input/output per million tokens)
 * - Benchmarks (from BenchLM.ai)
 * - Availability status per provider (green/yellow/red/restricted/unverified)
 * - Liveness metadata
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CATALOG_PATH, STALENESS_TTL_MS } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AvailabilityStatus = "green" | "yellow" | "red" | "restricted" | "unverified";

export type ProviderEntry = {
	raw_id: string;
	context_length: number | null;
	status: AvailabilityStatus;
	status_reason: string;
	status_code: number | null;
	source: "real" | "synthetic";
	rpm_documented: number | null;
	rpd_documented: number | null;
	retry_after: string | null;
	last_checked: string;
	last_real_call: string | null;
	consecutive_synthetic_failures: number;
};

export type Benchmarks = {
	/** BenchLM.ai composite score (0–100) */
	overall_score: number | null;
	/** BenchLM.ai coding category score (0–100) */
	coding_score: number | null;
	/** BenchLM.ai agentic category score (0–100) */
	agentic_score: number | null;
};

export type CatalogEntry = {
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	is_free: boolean;
	benchmarks: Benchmarks;
	providers: Record<string, ProviderEntry>;
};

export type Catalog = {
	schema_version: number;
	generated_by: string;
	benchmark_source_date: string | null;
	entries: Record<string, CatalogEntry>;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function emptyCatalog(): Catalog {
	return {
		schema_version: 1,
		generated_by: "pi-model-info",
		benchmark_source_date: null,
		entries: {},
	};
}

function emptyProviderEntry(rawId: string): ProviderEntry {
	return {
		raw_id: rawId,
		context_length: null,
		status: "green",
		status_reason: "available",
		status_code: null,
		source: "synthetic",
		rpm_documented: null,
		rpd_documented: null,
		retry_after: null,
		last_checked: new Date().toISOString(),
		last_real_call: null,
		consecutive_synthetic_failures: 0,
	};
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCatalog: Catalog | null = null;

/**
 * Read the catalog from disk. Returns empty catalog on any error.
 */
export function readCatalog(): Catalog {
	try {
		const raw = fs.readFileSync(CATALOG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<Catalog>;
		if (parsed.schema_version === 1 && parsed.entries) {
			return parsed as Catalog;
		}
		return emptyCatalog();
	} catch {
		return emptyCatalog();
	}
}

/**
 * Write the catalog to disk atomically (temp file + rename).
 */
function writeCatalogAtomic(catalog: Catalog): void {
	const dir = path.dirname(CATALOG_PATH);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}

	const tmpPath = `${CATALOG_PATH}.tmp.${Date.now()}`;
	try {
		fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2), "utf-8");
		fs.renameSync(tmpPath, CATALOG_PATH);
	} catch {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Schedule a debounced write. Batches rapid updates into a single disk write.
 */
export function scheduleWrite(catalog: Catalog): void {
	pendingCatalog = catalog;
	if (writeTimer) clearTimeout(writeTimer);
	writeTimer = setTimeout(() => {
		if (pendingCatalog) {
			writeCatalogAtomic(pendingCatalog);
			pendingCatalog = null;
		}
		writeTimer = null;
	}, 3000);
}

/**
 * Flush any pending write immediately (for session_shutdown).
 */
export function flushPendingWrite(): void {
	if (writeTimer) {
		clearTimeout(writeTimer);
		writeTimer = null;
	}
	if (pendingCatalog) {
		writeCatalogAtomic(pendingCatalog);
		pendingCatalog = null;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get or create a catalog entry for a normalized model key.
 */
export function getOrCreateEntry(
	catalog: Catalog,
	modelKey: string,
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): CatalogEntry {
	if (!catalog.entries[modelKey]) {
		catalog.entries[modelKey] = {
			cost,
			is_free: cost.input === 0 && cost.output === 0,
			benchmarks: { overall_score: null, coding_score: null, agentic_score: null },
			providers: {},
		};
	} else {
		// Always update cost — avoids stale cost from saved catalog across runs
		catalog.entries[modelKey].cost = cost;
		catalog.entries[modelKey].is_free = cost.input === 0 && cost.output === 0;
	}
	return catalog.entries[modelKey];
}

/**
 * Get or create a provider sub-entry within a catalog entry.
 */
export function getOrCreateProvider(
	entry: CatalogEntry,
	providerId: string,
	rawId: string,
): ProviderEntry {
	if (!entry.providers[providerId]) {
		entry.providers[providerId] = emptyProviderEntry(rawId);
	}
	return entry.providers[providerId];
}

/**
 * Check if a provider entry is stale (needs re-probing).
 */
export function isStale(provider: ProviderEntry, now: Date = new Date()): boolean {
	const lastChecked = new Date(provider.last_checked).getTime();
	return now.getTime() - lastChecked > STALENESS_TTL_MS;
}

/**
 * Check if a provider entry's retry_after has passed.
 */
export function isRetryAfterExpired(provider: ProviderEntry, now: Date = new Date()): boolean {
	if (!provider.retry_after) return true;
	return now.getTime() > new Date(provider.retry_after).getTime();
}
