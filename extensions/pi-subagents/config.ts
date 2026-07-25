/**
 * Configuration loader for subagent-plus
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentConfig {
	/** Providers to exclude from subagent pool (e.g., "ollama", "lmstudio") */
	excludeProviders: string[];
	/** Patterns to exclude from provider/model IDs (e.g., "localhost", "127.0.0.1") */
	excludePatterns: string[];
	/** Additional sensitive path patterns beyond defaults */
	sensitivePaths: string[];
	/** Path to pi-model-info's catalog file (enables availability-aware model selection) */
	catalogPath: string;
}

const DEFAULT_CONFIG: SubagentConfig = {
	excludeProviders: ["ollama", "lmstudio"],
	excludePatterns: ["localhost", "127.0.0.1"],
	sensitivePaths: [],
	catalogPath: path.join(getAgentDir(), "extensions", "pi-model-info", "model-catalog.json"),
};

export function loadConfig(): SubagentConfig {
	const configPath = path.join(getAgentDir(), "subagent-config.json");

	if (!fs.existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const content = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content) as Partial<SubagentConfig>;
		return {
			excludeProviders: parsed.excludeProviders ?? DEFAULT_CONFIG.excludeProviders,
			excludePatterns: parsed.excludePatterns ?? DEFAULT_CONFIG.excludePatterns,
			sensitivePaths: parsed.sensitivePaths ?? DEFAULT_CONFIG.sensitivePaths,
			catalogPath: parsed.catalogPath ?? DEFAULT_CONFIG.catalogPath,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
