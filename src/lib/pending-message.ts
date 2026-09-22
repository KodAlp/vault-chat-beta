/**
 * Hand-off from the welcome screen's own compose box to the chat screen it
 * navigates to. A module-level singleton survives client-side navigation
 * (the JS runtime isn't torn down between routes) — no need for
 * sessionStorage for something this short-lived and same-tab-only.
 */
export interface PendingMessage {
	chatId: string;
	question: string;
	/** Model/provider/think-mode chosen on the welcome screen's own picker
	 * before the chat even exists — undefined means "no explicit choice,
	 * use the current task default", same fallback Chat.svelte already
	 * applies via its overrideModel/overrideProvider. Applies to this one
	 * new chat only; never touches the global settings defaults. */
	providerId?: string;
	modelId?: string;
	think?: boolean;
	/** F6 — 'review' if the welcome screen's own review-mode toggle was on; undefined (→ 'free_chat') otherwise. */
	mode?: string;
}

let pending: PendingMessage | null = null;

export function setPendingMessage(value: PendingMessage): void {
	pending = value;
}

export function takePendingMessage(chatId: string): PendingMessage | undefined {
	if (!pending || pending.chatId !== chatId) return undefined;
	const value = pending;
	pending = null;
	return value;
}
