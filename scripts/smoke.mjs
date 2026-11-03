#!/usr/bin/env node
/**
 * Smoke test: read the Ollama Cloud key from the agent dir's auth.json (or the
 * OLLAMA_API_KEY env var), fetch /api/balance, and print the formatted status
 * line. Never prints the key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatUsageLine, parseBalancePayload, resolveCredentials } from "../ollama-cloud-core.ts";
import { fetchUsage } from "../ollama-cloud-fetch.ts";

const agentDir = process.env.GENTLE_PI_AGENT_HOME || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
let piAuth;
try {
	piAuth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
} catch {
	piAuth = undefined;
}

const credentials = resolveCredentials({ env: process.env, piAuth });
if (credentials.kind === "none") {
	console.error(`no Ollama Cloud key: set OLLAMA_API_KEY or run /login (source: ${credentials.reason})`);
	process.exit(1);
}

try {
	const payload = await fetchUsage(credentials);
	const parsed = parseBalancePayload(payload);
	if (!parsed.ok) {
		console.error(`could not parse /api/balance (${parsed.reason})`);
		process.exit(1);
	}
	console.log(formatUsageLine(parsed.data.windows, { compact: true }));
	console.log(formatUsageLine(parsed.data.windows, { compact: false }));
	if (parsed.data.purchased > 0) console.log(`purchased credits: $${parsed.data.purchased.toFixed(2)}`);
} catch (error) {
	console.error(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
