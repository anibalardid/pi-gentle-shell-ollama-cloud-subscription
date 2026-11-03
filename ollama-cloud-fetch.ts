/**
 * The Ollama Cloud usage transport. Pi-free on purpose: the extension and
 * `scripts/smoke.mjs` share exactly one network path.
 */

import { describeFailure, type Credentials } from "./ollama-cloud-core.ts";

const USER_AGENT = "pi-gentle-shell-ollama-cloud-subscription/1.0";
const REQUEST_TIMEOUT_MS = 15_000;

export class FetchFailure extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export function resolveOrigin(env: NodeJS.ProcessEnv = process.env): string {
	return (env.OLLAMA_CLOUD_ORIGIN || "https://ollama.com").replace(/\/+$/, "");
}

async function requestJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
			signal: controller.signal,
			redirect: "manual",
		});
		if (response.status >= 300 && response.status < 400) {
			throw new FetchFailure("redirected", response.status);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new FetchFailure(describeFailure(response.status, body), response.status);
		}
		return await response.json();
	} catch (error) {
		if (error instanceof FetchFailure) throw error;
		if (error instanceof Error && error.name === "AbortError") throw new FetchFailure("timeout");
		throw new FetchFailure("network error");
	} finally {
		clearTimeout(timer);
	}
}

/** Official endpoint: reports quota windows directly, no browser session needed. */
export async function fetchBalance(apiKey: string, origin = resolveOrigin()): Promise<unknown> {
	return requestJson(`${origin}/api/balance`, { Authorization: `Bearer ${apiKey.trim()}` });
}

export async function fetchUsage(credentials: Credentials, origin = resolveOrigin()): Promise<unknown> {
	if (credentials.kind === "api") return fetchBalance(credentials.apiKey, origin);
	throw new FetchFailure("no credentials");
}
