/**
 * The shipped data/providers.default.json stores the built-in Ollama entry's label as the Turkish string
 * "Ollama (yerel)" (and existing installs have that string in their providers.json too), which showed up
 * in every UI language. The built-in entry — id 'ollama' still carrying that stock label — is therefore
 * rendered through the i18n catalog instead; a provider the user added or relabelled keeps its stored label.
 */
const STOCK_OLLAMA_LABEL = 'Ollama (yerel)';

export function providerDisplayLabel(id: string, label: string, t: (key: string) => string): string {
	return id === 'ollama' && label === STOCK_OLLAMA_LABEL ? t('ProvidersSettingsPage.ollamaLocal') : label;
}

/**
 * The same rule for a provider NAME that reached the client without its id — a coded notice's
 * `provider`/`from`/`to` param (chat-fallback.ts sends the stored label, or the bare id when the
 * entry has none). Only the stock built-in Ollama name is rewritten; anything else is the user's.
 */
export function isStockOllamaName(name: string): boolean {
	return name === STOCK_OLLAMA_LABEL || name === 'ollama';
}
