import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	countdown,
	formatUsageLine,
	parseBalancePayload,
	resolveCredentials,
	type UsageWindow,
} from "../ollama-cloud-core.ts";

describe("parseBalancePayload", () => {
	it("converts remaining_percent into used percent", () => {
		const parsed = parseBalancePayload({
			included: {
				session: { remaining_percent: 87.43, resets_at: "2026-11-03T05:00:00Z" },
				weekly: { remaining_percent: 77.13, resets_at: "2026-11-09T00:00:00Z" },
			},
			purchased: { balance_usd: 0 },
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(
			parsed.data.windows.map((w) => [w.id, w.percent]),
			[
				["session", 12.6],
				["weekly", 22.9],
			],
		);
	});

	it("clamps to 0..100 and ignores the absent monthly window", () => {
		const parsed = parseBalancePayload({
			included: {
				session: { remaining_percent: -5, resets_at: null },
				weekly: { remaining_percent: 130, resets_at: "not-a-date" },
			},
			purchased: { balance_usd: 0 },
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(
			parsed.data.windows.map((w) => [w.id, w.percent, w.resetsAt]),
			[
				["session", 100, null],
				["weekly", 0, null],
			],
		);
	});

	it("reports a changed shape for an empty result, never a confident zero", () => {
		const parsed = parseBalancePayload({ included: {}, purchased: { balance_usd: 0 } });
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.equal(parsed.reason, "shape-changed");
	});

	it("reports no-payload for null", () => {
		const parsed = parseBalancePayload(null);
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.equal(parsed.reason, "no-payload");
	});

	it("carries purchased balance and optional included allowance", () => {
		const parsed = parseBalancePayload({
			included: {
				session: { remaining_percent: 50, resets_at: "2026-11-03T05:00:00Z" },
				balance_usd: 1.5,
				allowance_usd: 10,
			},
			purchased: { balance_usd: 2.5 },
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.data.purchased, 2.5);
		assert.equal(parsed.data.balanceUsd, 1.5);
		assert.equal(parsed.data.allowanceUsd, 10);
	});
});

describe("formatUsageLine", () => {
	const windows: UsageWindow[] = [
		{ id: "session", label: "5h", longLabel: "session", percent: 12.6, resetsAt: "2026-11-03T05:00:00Z" },
		{ id: "weekly", label: "7d", longLabel: "weekly", percent: 22.9, resetsAt: "2026-11-09T00:00:00Z" },
	];

	it("compact form shows short labels and rounded percentages", () => {
		assert.equal(formatUsageLine(windows, { compact: true }), "Ollama 5h 13% · 7d 23%");
	});

	it("long form shows long labels and reset countdowns", () => {
		const now = Date.parse("2026-11-03T02:00:00Z");
		assert.equal(
			formatUsageLine(windows, { compact: false, now }),
			"Ollama session 13% (3h 0m) · weekly 23% (5d 22h)",
		);
	});
});

describe("countdown", () => {
	const now = Date.parse("2026-11-03T00:00:00Z");

	it("formats days and hours", () => {
		assert.equal(countdown("2026-11-09T00:00:00Z", now), "6d 0h");
	});
	it("formats hours and minutes", () => {
		assert.equal(countdown("2026-11-03T02:05:00Z", now), "2h 5m");
	});
	it("formats minutes", () => {
		assert.equal(countdown("2026-11-03T00:12:00Z", now), "12m");
	});
	it("returns now for the past and empty for a missing date", () => {
		assert.equal(countdown("2026-11-02T00:00:00Z", now), "now");
		assert.equal(countdown(null, now), "");
	});
});

describe("resolveCredentials", () => {
	it("prefers the env key", () => {
		const result = resolveCredentials({
			env: { OLLAMA_API_KEY: "env-key" },
			config: { apiKey: "config-key" },
			piAuth: { "ollama-cloud": { type: "api", key: "auth-key" } },
		});
		assert.equal(result.kind, "api");
		if (result.kind === "api") {
			assert.equal(result.apiKey, "env-key");
			assert.equal(result.source, "env");
		}
	});

	it("falls back to config, then the pi auth store", () => {
		const fromConfig = resolveCredentials({ config: { apiKey: "config-key" }, piAuth: { "ollama-cloud": { key: "auth-key" } } });
		assert.equal(fromConfig.kind, "api");
		if (fromConfig.kind === "api") assert.equal(fromConfig.apiKey, "config-key");

		const fromAuth = resolveCredentials({ piAuth: { "ollama-cloud": { type: "api", key: "auth-key" } } });
		assert.equal(fromAuth.kind, "api");
		if (fromAuth.kind === "api") {
			assert.equal(fromAuth.apiKey, "auth-key");
			assert.equal(fromAuth.source, "pi login (ollama-cloud)");
		}
	});

	it("returns none when nothing is configured", () => {
		const result = resolveCredentials({});
		assert.equal(result.kind, "none");
	});
});
