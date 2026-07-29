/**
 * Hand-off from the welcome screen's own compose box to the chat screen it
 * navigates to. A module-level singleton survives client-side navigation
 * (the JS runtime isn't torn down between routes) — no need for
 * sessionStorage for something this short-lived and same-tab-only.
 */
let pending: { chatId: string; question: string } | null = null;

export function setPendingMessage(value: { chatId: string; question: string }): void {
	pending = value;
}

export function takePendingMessage(chatId: string): string | undefined {
	if (!pending || pending.chatId !== chatId) return undefined;
	const question = pending.question;
	pending = null;
	return question;
}
