// Pure checks for scripts/stage-server.mjs (no fs, no process) so they can be unit-tested
// (scripts/stage-verify.test.ts) and so the shipped default config's shape is asserted by the same code
// that guards the staging step.

/** The ONLY thing allowed under dist-server/data/: the first-launch providers.json seed. Everything else
 * that lives in a working copy's data/ (secrets.json, secrets.key, chats.db*, ui-prefs.json, vaults.json,
 * vaults/, library/, skills/, provider-consent.json, app-log, mcp-log, model-catalog.json ...) is the
 * developer's personal state and must never ship in an installer. */
export const ALLOWED_STAGED_DATA_ENTRIES = ['providers.json'];

/** Names called out explicitly in the error text, purely so a failure says WHAT leaked. */
const KNOWN_PERSONAL = [/^secrets/i, /^chats\.db/i, /^ui-prefs/i, /^vaults/i, /^library$/i, /^skills$/i, /^provider-consent/i, /^app-log/i, /^mcp-log/i, /\.key$/i];

/**
 * Problems with providers.default.json's content (the shape a fresh install starts from):
 *  - every chain empty (the first-run wizard fills them in; no personal model picks);
 *  - an explicit "embedding: null" (FTS-only until the wizard picks a real embedding provider — absent would
 *    resolve to the legacy ollama/bge-m3 default, wrong for a user who never installs Ollama);
 *  - no cloud (non-ollama) provider enabled, none with a personal defaultModel/enabledModels/pinnedModels/modelCaps.
 * Returns human-readable problem strings; empty array = fine.
 */
export function validateDefaultProviders(parsed) {
	const problems = [];
	if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers) || typeof parsed.chains !== 'object' || parsed.chains === null) {
		return ['providers.default.json: providers[] / chains{} missing'];
	}
	if (!('embedding' in parsed) || parsed.embedding !== null) {
		problems.push('providers.default.json: "embedding" must be an explicit null');
	}
	for (const [task, ids] of Object.entries(parsed.chains)) {
		if (!Array.isArray(ids) || ids.length !== 0) problems.push(`providers.default.json: chain "${task}" must be empty`);
	}
	for (const p of parsed.providers) {
		if (p.kind !== 'ollama' && p.enabled !== false) problems.push(`providers.default.json: cloud provider "${p.id}" must be disabled`);
		if (p.kind !== 'ollama') {
			for (const personal of ['defaultModel', 'enabledModels', 'pinnedModels', 'modelCaps']) {
				if (personal in p) problems.push(`providers.default.json: "${p.id}" must not carry "${personal}"`);
			}
		}
	}
	if (!parsed.providers.some((p) => p.id === 'ollama' && p.kind === 'ollama')) {
		problems.push('providers.default.json: the "ollama" entry is missing');
	}
	return problems;
}

/**
 * Checks what stage-server.mjs actually staged:
 *  - dist-server/data/providers.json is byte-identical to providers.default.json (the working-copy
 *    data/providers.json — with whatever keys/picks a developer set — must not be what ships);
 *  - dist-server/data/ holds nothing but providers.json.
 * "stagedProviders" / "defaultProviders" are Buffers (or null when missing); "stagedDataEntries" the names
 * directly under dist-server/data/. Returns problem strings; empty array = OK.
 */
export function verifyStagedData({ stagedProviders, defaultProviders, stagedDataEntries }) {
	const problems = [];
	if (!defaultProviders) problems.push('data/providers.default.json bulunamadı');
	if (!stagedProviders) problems.push('dist-server/data/providers.json bulunamadı');
	if (stagedProviders && defaultProviders && !Buffer.from(stagedProviders).equals(Buffer.from(defaultProviders))) {
		problems.push('dist-server/data/providers.json, data/providers.default.json ile birebir aynı değil');
	}
	for (const name of stagedDataEntries) {
		if (ALLOWED_STAGED_DATA_ENTRIES.includes(name)) continue;
		const known = KNOWN_PERSONAL.some((re) => re.test(name));
		problems.push(`dist-server/data/${name} sahnelenmemeli${known ? ' (kişisel veri)' : ''}`);
	}
	return problems;
}
