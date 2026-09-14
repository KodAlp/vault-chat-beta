import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { setChatTitle } from './chats-db';
import { logAppEvent } from './app-log';

const SYSTEM_PROMPT =
	'Kullanıcının sorduğu soruyu 3-6 kelimelik kısa bir Türkçe başlığa dönüştür. Sadece başlığı yaz, tırnak işareti veya açıklama ekleme.';

/**
 * Fire-and-forget from the /api/chat handler — never awaited, never allowed
 * to throw out. A failed title generation must not surface to the user or
 * break the chat; the title just stays null and the history dropdown falls
 * back to showing the chat id or "(başlıksız)". No cancellation wiring here
 * (matches the pre-provider-layer behavior) — a fresh, never-aborted signal.
 *
 * `model` is required, not defaulted to a hardcoded title model — a
 * hardcoded default (previously always qwen3:8b) meant every new chat paid
 * for a hidden model swap through ollamaGate the instant the chat model
 * differed, and silently produced no title at all if that hardcoded model
 * was never pulled. The caller passes body.titleModel ?? body.model so
 * title generation reuses whatever's already loaded by default.
 */
export async function generateTitle(
	chatId: string,
	question: string,
	model: string,
	provider?: string
): Promise<void> {
	try {
		const messages: ChatMessage[] = [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: question }
		];
		let title = '';
		const signal = new AbortController().signal;
		for await (const event of chatWithFallback(
			'title',
			{ model, messages, think: false },
			signal,
			provider
		)) {
			if (event.type === 'text') title += event.text;
		}
		title = title.trim().replace(/^["']|["']$/g, '');
		if (title) setChatTitle(chatId, title);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
		console.error('Başlık üretilemedi:', err);
		logAppEvent({ kind: 'title_error', chatId, model, message });
	}
}
