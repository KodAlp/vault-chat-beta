export interface Settings {
	theme: 'light' | 'dark' | 'system';
	/** Small/fast model used for background utility calls (title generation). */
	defaultModel: string;
	fastModel: string;
	reasoningModel: string;
}

const STORAGE_KEY = 'vault-chat-settings';

const DEFAULTS: Settings = {
	theme: 'system',
	defaultModel: 'qwen3:8b',
	fastModel: 'qwen3:8b',
	reasoningModel: 'qwen3:8b'
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
