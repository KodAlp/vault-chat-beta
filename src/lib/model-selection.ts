// A plain model id can't carry which provider it came from on its own (two
// providers could serve identically-named models), and a native <select>
// binds a single string value — this encodes both into one key. Shared by
// Chat.svelte's header override and the welcome screen's new-chat picker
// (src/routes/vault/[id]/+page.svelte) so the encoding can't drift between
// the two call sites.
export function selectionKey(providerId: string, modelId: string): string {
	return `${providerId}␟${modelId}`;
}

export function parseSelectionKey(key: string): { providerId: string; modelId: string } {
	const [providerId, modelId] = key.split('␟');
	return { providerId, modelId };
}
