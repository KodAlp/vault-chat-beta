/**
 * Aşama 2b — maps a local server's port to the local-server catalog id it
 * most likely belongs to, mirroring each kind's DEFAULT port in
 * src-tauri/src/launchers.rs's CATALOG. Pure/string-only so it's
 * unit-testable without Tauri — used by both the setup page (to avoid
 * creating a duplicate provider for a server the user already added) and
 * settings/providers (to decide which provider card gets an inline
 * LauncherPanel).
 *
 * NOTE: llama.cpp and LocalAI both default to port 8080 in the Rust
 * catalog — an ambiguous case this deliberately resolves to "llamacpp"
 * (listed first below), since llama.cpp is the more common of the two to
 * run locally on Windows. A user running LocalAI on its default port will
 * see it matched as llama.cpp instead; changing either one's port avoids
 * the ambiguity. This module never decides anything security-relevant —
 * the actual launcher id used for any Tauri command always comes from the
 * fixed catalog id itself, never derived text.
 */
const PORT_TO_CATALOG_ID: ReadonlyArray<{ id: string; port: number }> = [
	{ id: 'ollama', port: 11434 },
	{ id: 'lmstudio', port: 1234 },
	{ id: 'llamacpp', port: 8080 },
	{ id: 'llamacpp-embed', port: 8081 },
	{ id: 'jan', port: 1337 },
	{ id: 'localai', port: 8080 },
	{ id: 'vllm', port: 8000 }
];

export function catalogIdForPort(port: number): string | undefined {
	return PORT_TO_CATALOG_ID.find((e) => e.port === port)?.id;
}

/** Parses the port out of a baseUrl string (e.g. "http://127.0.0.1:1234/v1"
 * -> 1234). Returns undefined for anything unparsable or with no explicit
 * port (a bare "https://api.example.com" cloud provider, most commonly). */
export function portFromBaseUrl(baseUrl: string): number | undefined {
	try {
		const url = new URL(baseUrl);
		if (!url.port) return undefined;
		const n = Number(url.port);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

export function catalogIdForBaseUrl(baseUrl: string): string | undefined {
	const port = portFromBaseUrl(baseUrl);
	return port === undefined ? undefined : catalogIdForPort(port);
}
