/**
 * Pure core of pi-gentle-shell-ollama-cloud-subscription.
 *
 * No Pi imports live here, so the whole decision surface — config shape,
 * credential resolution, payload parsing, status formatting — is unit testable
 * with plain Node.
 *
 * Data comes from Ollama Cloud's documented `GET /api/balance` endpoint,
 * authenticated with a Bearer API key. No browser cookie and no local Ollama
 * server are involved.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OllamaStatusConfig {
	version: 1;
	/** Publish the status line into Gentle Shell's Status card. */
	enabled: boolean;
	/** One line with percentages only, or the long form with reset countdowns. */
	compact: boolean;
	refreshSeconds: number;
	/** Optional credentials; env and Pi's auth store are tried first. */
	apiKey?: string;
}

export const DEFAULT_CONFIG: Readonly<OllamaStatusConfig> = {
	version: 1,
	enabled: true,
	compact: true,
	refreshSeconds: 300,
};

export const MIN_REFRESH_SECONDS = 60;
export const MAX_REFRESH_SECONDS = 3600;

export type ConfigStatus = "file" | "defaults" | "malformed";

export interface LoadedConfig {
	status: ConfigStatus;
	config: OllamaStatusConfig;
	problem?: string;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveAgentDir(env), "ollama-cloud-status.json");
}

/** Pi's own credential store, written by `/login`. */
export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveAgentDir(env), "auth.json");
}

function clampRefresh(seconds: unknown): number {
	const value =
		typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds) : DEFAULT_CONFIG.refreshSeconds;
	return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, value));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseConfig(raw: unknown): { config: OllamaStatusConfig } | { problem: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { problem: "the file must be a JSON object" };
	}
	const candidate = raw as Record<string, unknown>;
	if (candidate.version !== 1) return { problem: "version must be 1" };

	const apiKey = optionalString(candidate.apiKey);
	return {
		config: {
			version: 1,
			enabled: candidate.enabled !== false,
			compact: candidate.compact !== false,
			refreshSeconds: clampRefresh(candidate.refreshSeconds),
			...(apiKey ? { apiKey } : {}),
		},
	};
}

export function readConfig(path: string): LoadedConfig {
	if (!existsSync(path)) {
		return { status: "defaults", config: { ...DEFAULT_CONFIG } };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			status: "malformed",
			config: { ...DEFAULT_CONFIG },
			problem: `cannot read the file (${(error as Error).message})`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			status: "malformed",
			config: { ...DEFAULT_CONFIG },
			problem: `invalid JSON (${(error as Error).message})`,
		};
	}
	const parsed = parseConfig(raw);
	if ("problem" in parsed) {
		return { status: "malformed", config: { ...DEFAULT_CONFIG }, problem: parsed.problem };
	}
	return { status: "file", config: parsed.config };
}

/**
 * Write through a temp file with 0600: the file may hold an API key, so it is
 * never group/world readable and never half-written.
 */
export function writeConfig(path: string, config: OllamaStatusConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const { version: _version, ...rest } = config;
	const body = { version: 1, ...rest };
	if (!body.apiKey) delete body.apiKey;
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(body, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export type Credentials =
	| { kind: "api"; apiKey: string; source: string }
	| { kind: "none"; reason: string };

export interface CredentialInputs {
	env?: Record<string, string | undefined>;
	config?: Partial<OllamaStatusConfig>;
	/** Parsed `<agent-dir>/auth.json` — what `/login` writes. */
	piAuth?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
	return optionalString(record(value)?.[key]);
}

/**
 * Resolve credentials. The API key is the same subscription key the models use,
 * so `/login` inside Pi is usually enough:
 *
 *   1. env  OLLAMA_API_KEY | OLLAMA_CLOUD_API_KEY
 *   2. this extension's config apiKey
 *   3. Pi's own auth store, written by `/login`: `ollama-cloud.key`
 */
export function resolveCredentials(inputs: CredentialInputs = {}): Credentials {
	const env = inputs.env ?? process.env;
	const config = inputs.config ?? {};

	const envKey = optionalString(env.OLLAMA_API_KEY) ?? optionalString(env.OLLAMA_CLOUD_API_KEY);
	if (envKey) return { kind: "api", apiKey: envKey, source: "env" };

	if (config.apiKey) return { kind: "api", apiKey: config.apiKey, source: "config" };

	const piAuth = record(inputs.piAuth);
	const key = stringAt(piAuth?.["ollama-cloud"], "key");
	if (key) return { kind: "api", apiKey: key, source: "pi login (ollama-cloud)" };

	return { kind: "none", reason: "no API key found" };
}

// ---------------------------------------------------------------------------
// Payload parsing (GET /api/balance)
// ---------------------------------------------------------------------------

export type WindowId = "session" | "weekly" | "monthly";

export interface UsageWindow {
	id: WindowId;
	label: "5h" | "7d" | "30d";
	longLabel: "session" | "weekly" | "monthly";
	/** Used percent, 0..100. */
	percent: number;
	resetsAt: string | null;
}

export interface BalanceData {
	windows: UsageWindow[];
	/** purchased.balance_usd, 0 when absent. */
	purchased: number;
	/** included.balance_usd (optional). */
	balanceUsd?: number;
	/** included.allowance_usd (optional). */
	allowanceUsd?: number;
}

export type ParseResult =
	| { ok: true; data: BalanceData }
	| { ok: false; reason: "no-payload" | "shape-changed" };

const WINDOWS: ReadonlyArray<{ key: WindowId; label: UsageWindow["label"]; longLabel: UsageWindow["longLabel"] }> = [
	{ key: "session", label: "5h", longLabel: "session" },
	{ key: "weekly", label: "7d", longLabel: "weekly" },
	{ key: "monthly", label: "30d", longLabel: "monthly" },
];

function toNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function clampPercent(value: number): number {
	return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function isoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parse `GET /api/balance`. The API reports `remaining_percent`, so used percent
 * is `100 - remaining`. The `monthly` window and the included balance/allowance
 * fields are optional (absent on the pro plan).
 *
 * An empty result is reported as a changed shape, never as a confident zero.
 */
export function parseBalancePayload(payload: unknown): ParseResult {
	if (payload === undefined || payload === null) return { ok: false, reason: "no-payload" };
	const root = record(payload);
	if (!root) return { ok: false, reason: "no-payload" };

	const included = record(root.included);
	const windows: UsageWindow[] = [];
	if (included) {
		for (const { key, label, longLabel } of WINDOWS) {
			const window = record(included[key]);
			if (!window) continue;
			const remaining = toNumber(window.remaining_percent);
			if (remaining === null) continue;
			windows.push({
				id: key,
				label,
				longLabel,
				percent: clampPercent(100 - remaining),
				resetsAt: isoTimestamp(window.resets_at),
			});
		}
	}

	const purchased = toNumber(record(root.purchased)?.balance_usd) ?? 0;
	const balanceUsd = toNumber(included?.balance_usd) ?? undefined;
	const allowanceUsd = toNumber(included?.allowance_usd) ?? undefined;

	const hasWindow = windows.length > 0;
	const hasAllowance = balanceUsd !== undefined && allowanceUsd !== undefined;
	const hasPurchased = purchased > 0;
	if (!hasWindow && !hasAllowance && !hasPurchased) {
		return { ok: false, reason: "shape-changed" };
	}

	const data: BalanceData = { windows, purchased, ...(balanceUsd !== undefined ? { balanceUsd } : {}), ...(allowanceUsd !== undefined ? { allowanceUsd } : {}) };
	return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "1h 12m" / "3d 4h" / "12m" / "now" — the same scale the console shows. */
export function countdown(resetsAt: string | null, now: number = Date.now()): string {
	if (!resetsAt) return "";
	const target = Date.parse(resetsAt);
	if (!Number.isFinite(target)) return "";
	const diffMs = target - now;
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.floor(diffMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** The one line that lands under "Integrations" in the sidebar Status card. */
export function formatUsageLine(
	windows: readonly UsageWindow[],
	options: { compact: boolean; now?: number },
): string {
	const parts = windows.map((window) => {
		const percent = `${Math.round(window.percent)}%`;
		if (options.compact) return `${window.label} ${percent}`;
		const reset = countdown(window.resetsAt, options.now);
		return `${window.longLabel} ${percent}${reset ? ` (${reset})` : ""}`;
	});
	return `Ollama ${parts.join(" · ")}`;
}

export type StatusState =
	| { kind: "disabled" }
	| { kind: "no-credentials" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ok"; data: BalanceData; updatedAt: number };

/**
 * Short enough for a sidebar column; the full sentence belongs in the panel.
 * The hint is only appended when it is actionable.
 */
export function formatStatusText(state: StatusState, options: { compact: boolean; now?: number }): string | undefined {
	switch (state.kind) {
		case "disabled":
			return undefined;
		case "no-credentials":
			return "Ollama: not connected · /ollama-cloud";
		case "loading":
			return "Ollama: loading…";
		case "error":
			return `Ollama: ${state.message} · /ollama-cloud`;
		case "ok":
			return formatUsageLine(state.data.windows, { compact: options.compact, now: options.now });
	}
}

/** Turn a fetch failure into words a person can act on. */
export function describeFailure(status: number, body?: string): string {
	if (status === 401 || status === 403) {
		const code = (() => {
			try {
				const parsed = JSON.parse(body ?? "");
				return typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
			} catch {
				return undefined;
			}
		})();
		if (code === "api_key_expired") return "API key expired";
		return `auth ${status}`;
	}
	return `HTTP ${status}`;
}
