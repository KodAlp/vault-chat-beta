/**
 * Aşama 4c — the small decisions the first-run local-server wizard (routes/setup/local-server) makes, pulled
 * out as pure functions so they are unit-testable without a browser.
 */

/** The one chat model to use without asking: only when the server lists exactly one. */
export function autoPickModel(chatModelIds: readonly string[]): string | null {
	return chatModelIds.length === 1 ? chatModelIds[0] : null;
}

/** Task types whose provider chain is empty — the wizard puts the chosen provider at the head of exactly
 * these and never touches a chain that already has an entry (an existing setup keeps its own routing). */
export function emptyChainTasks(chains: Record<string, readonly string[]>): string[] {
	return Object.keys(chains).filter((task) => chains[task].length === 0);
}

/** Same base+tag matching rule the wizard's Ollama step has always used: `bge-m3` matches `bge-m3:latest`,
 * `bge-m3:567m` matches only that tag. */
export function modelListed(installed: readonly string[], wanted: string): boolean {
	const [wantedBase, wantedTag] = wanted.split(':');
	return installed.some((name) => {
		const [base, tag] = name.split(':');
		if (base !== wantedBase) return false;
		return wantedTag === undefined || tag === wantedTag;
	});
}

/** Which embedding-only model of a server to offer: the app's calibrated one (bge-m3, see embed-config.ts and
 * select-chunks.ts's distance threshold) when it is there, else the first one the server lists, else none. */
export function chooseEmbeddingCandidate(embeddingModelIds: readonly string[], preferred = 'bge-m3'): string | null {
	const exact = embeddingModelIds.find((id) => modelListed([id], preferred));
	return exact ?? embeddingModelIds[0] ?? null;
}
