import type { ChatMessage, RetrievedChunk } from '$lib/types';
import type { OllamaChatMessage } from './ollama';

const SYSTEM_PROMPT = `Sen bu kişisel bilgi kasasının (Obsidian tabanlı ikinci beyin) öğretici asistanısın.

Kurallar:
- Her zaman kullanıcının dilinde (Türkçe) cevap ver.
- Tüm matematiği kesinlikle $...$ (satır içi) veya $$...$$ (blok) içinde yaz.
  Asla \\( \\) ya da \\[ \\] kullanma, asla çıplak LaTeX komutu yazma.
- Aşağıdaki <context> bloğundaki notları kullandığında kaynağını topic başlığıyla belirt.
- <context> soruyu kapsamıyorsa bunu açıkça söyle; kapsamayan bir konuda uydurma cevap verme.`;

/**
 * Injects retrieved chunks as a fenced <context> block above the latest user
 * question, each prefixed with its source path and frontmatter summary.
 */
export function buildPromptMessages(
	history: ChatMessage[],
	chunks: RetrievedChunk[]
): OllamaChatMessage[] {
	const lastUser = history[history.length - 1];
	const priorTurns: OllamaChatMessage[] = history
		.slice(0, -1)
		.map(({ role, content }) => ({ role, content }));

	const context =
		chunks.length > 0
			? `<context>\n${chunks
					.map(
						(c) =>
							`[${c.topic} | ${c.heading_path}] (${c.path}, depth: ${c.depth})\n${c.display_text}`
					)
					.join('\n\n---\n\n')}\n</context>\n\n`
			: '';

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		...priorTurns,
		{ role: 'user', content: `${context}${lastUser.content}` }
	];
}
