import { streamChat, type OllamaChatMessage } from './ollama';
import { setChatTitle } from './chats-db';

const TITLE_MODEL = 'qwen3:8b';
const SYSTEM_PROMPT =
	'Kullanıcının sorduğu soruyu 3-6 kelimelik kısa bir Türkçe başlığa dönüştür. Sadece başlığı yaz, tırnak işareti veya açıklama ekleme.';

/**
 * Fire-and-forget from the /api/chat handler — never awaited, never allowed
 * to throw out. A failed title generation must not surface to the user or
 * break the chat; the title just stays null and the history dropdown falls
 * back to showing the chat id or "(başlıksız)".
 */
export async function generateTitle(chatId: string, question: string): Promise<void> {
	try {
		const messages: OllamaChatMessage[] = [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: question }
		];
		let title = '';
		for await (const piece of streamChat(TITLE_MODEL, messages, false)) {
			if (piece.kind === 'content') title += piece.text;
		}
		title = title.trim().replace(/^["']|["']$/g, '');
		if (title) setChatTitle(chatId, title);
	} catch (err) {
		console.error('Başlık üretilemedi:', err);
	}
}
