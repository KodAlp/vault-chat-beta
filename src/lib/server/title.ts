import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { setChatTitle } from './chats-db';

const DEFAULT_TITLE_MODEL = 'qwen3:8b';
const SYSTEM_PROMPT =
	'Kullanıcının sorduğu soruyu 3-6 kelimelik kısa bir Türkçe başlığa dönüştür. Sadece başlığı yaz, tırnak işareti veya açıklama ekleme.';

/**
 * Fire-and-forget from the /api/chat handler — never awaited, never allowed
 * to throw out. A failed title generation must not surface to the user or
 * break the chat; the title just stays null and the history dropdown falls
 * back to showing the chat id or "(başlıksız)". No cancellation wiring here
 * (matches the pre-provider-layer behavior) — a fresh, never-aborted signal.
 */
export async function generateTitle(chatId: string, question: string, model?: string): Promise<void> {
	try {
		const messages: ChatMessage[] = [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: question }
		];
		let title = '';
		const signal = new AbortController().signal;
		for await (const event of chatWithFallback(
			'title',
			{ model: model || DEFAULT_TITLE_MODEL, messages, think: false },
			signal
		)) {
			if (event.type === 'text') title += event.text;
		}
		title = title.trim().replace(/^["']|["']$/g, '');
		if (title) setChatTitle(chatId, title);
	} catch (err) {
		console.error('Başlık üretilemedi:', err);
	}
}
