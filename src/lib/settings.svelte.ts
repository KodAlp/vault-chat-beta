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
	 * to '' (no pin, task chain) — see registry.ts's chatWithFallback pinnedProviderId.
	 */
	defaultProvider: string;
	fastProvider: string;
	reasoningProvider: string;
	/**
	 * Off by default (Faz 18): each of the 5 generation dialogs disables its
	 * own "Oluştur" button while ANY generation of that same type is still
	 * running (see *Dialog.svelte's `alreadyGenerating` derived), purely to
	 * stop the same weak local GPU from being asked to do two heavy
	 * JSON-schema-constrained decodes at once. The *-generation.svelte.ts
	 * stores were already array-based (Faz 13) and GenerationStatusToast
	 * already stacks multiple toasts — concurrent generation is otherwise
	 * fully supported UI-side, this is the only gate. A user with a
	 * beefier machine (or a cloud provider pinned via Faz 17's per-task
	 * provider) can turn it on to queue several at once.
	 */
	allowConcurrentGeneration: boolean;
	/** Whether /welcome shows once per app launch before the vault picker —
	 * see $lib/welcome.ts for the per-session "already shown" flag this
	 * gates alongside. On by default; a user who finds it slows down
	 * getting to their vault can turn it off from /settings. */
	showWelcomeScreen: boolean;
	/**
	 * Experimental, OFF by default: label every generated quiz question with a cognitive level (recall / understanding / application /
	 * higher) so the learner model can report per level. It asks the model to write each question FOR a level, which a small local
	 * model does not do reliably (measured agreement with an independent re-labelling: about 50%), so it stays opt-in.
	 */
	quizLevelLabels: boolean;
}

/** Exported so +layout.ts's migration check can tell "nothing in
 * localStorage yet" apart from "loadInitial() already read it" without
 * duplicating the literal string. */
export const STORAGE_KEY = 'vault-chat-settings';

const DEFAULTS: Settings = {
	theme: 'system',
	// Aşama 4c: blank = "no choice made" — the client sends no model/provider and the server uses the first
	// provider of the task chain with ITS defaultModel (the first-run wizard, or Settings, fills these in).
	defaultModel: '',
	fastModel: '',
	reasoningModel: '',
	defaultProvider: '',
	fastProvider: '',
	reasoningProvider: '',
	allowConcurrentGeneration: false,
	showWelcomeScreen: true,
	quizLevelLabels: false
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
	// Fire-and-forget: see i18n/index.svelte.ts's persistLocale for why a
	// failed PUT here is swallowed rather than surfaced.
	if (typeof window !== 'undefined') {
		fetch('/api/ui-prefs', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ settings })
		}).catch((err) => console.warn('ui-prefs settings PUT failed', err));
	}
}

/** Applied from +layout.ts's load with the server-persisted copy. Shallow
 * merge, not replace — a patch only ever carries the fields the server had
 * sanitized (see ui-prefs-store.ts's sanitizeSettings), so this must not
 * blow away a field the patch simply doesn't mention. */
export function applySettings(patch: Partial<Settings> | undefined): void {
	if (!patch) return;
	Object.assign(settings, patch);
}
