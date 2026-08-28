export interface Settings {
	theme: 'light' | 'dark' | 'system';
	/** Small/fast model used for background utility calls (title generation). */
	defaultModel: string;
	fastModel: string;
	reasoningModel: string;
	/**
	 * Which provider each of the three model ids above belongs to (Faz 17 —
	 * providerId end-to-end). Before this, only a bare model id was ever
	 * stored, so `chatWithFallback` had no way to know a chosen model like
	 * "deepseek-chat" wasn't just an unusual Ollama tag — it always routed
	 * through providers.json's task chain (always `["ollama"]` today)
	 * regardless of which provider the model actually came from. Defaults
	 * to 'ollama', matching every pre-existing installation's only
	 * enabled provider — see registry.ts's chatWithFallback pinnedProviderId.
	 */
	defaultProvider: string;
	fastProvider: string;
	reasoningProvider: string;
}

const STORAGE_KEY = 'vault-chat-settings';

const DEFAULTS: Settings = {
	theme: 'system',
	defaultModel: 'qwen3:8b',
	fastModel: 'qwen3:8b',
	reasoningModel: 'qwen3:8b',
	defaultProvider: 'ollama',
	fastProvider: 'ollama',
	reasoningProvider: 'ollama'
};

function loadInitial(): Settings {
	if (typeof localStorage === 'undefined') return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
	} catch {
		return { ...DEFAULTS };
	}
}

/** Client device/browser preference, not conversation data — localStorage, not chats.db. */
export const settings = $state<Settings>(loadInitial());

export function persistSettings(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
