import type { ChatMessage, RetrievedChunk } from '$lib/types';
import type { ChatMessage as ProviderChatMessage } from './providers/types';
import { renderUserSkillsBlock } from './userSkills';

/** Exported for /api/skills/preview alongside the analogous constants in
 * generate-quiz.ts/generate-cards.ts. */
export const CORE_INTRO = `Sen bu kişisel bilgi kasasının (Obsidian tabanlı ikinci beyin) öğretici asistanısın.
Her zaman kullanıcının dilinde (Türkçe) cevap ver.`;

/**
 * Non-overridable, appended after any user skills — see userSkills.ts and
 * the user-skills skill doc's "assembly order" section. Local models weight
 * later instructions more heavily, so these must always be last.
 */
export const CORE_INVARIANTS = `Kurallar:
- Tüm matematiği kesinlikle $...$ (satır içi) veya $$...$$ (blok) içinde yaz.
  Asla \\( \\) ya da \\[ \\] kullanma, asla çıplak LaTeX komutu yazma.
- Bir formülü yazmaya başladıysan yarım bırakma: her \\frac{}{}, \\sqrt{},
  üst/alt simge gibi yapının açtığı parantez/süslü parantezi kapat ve
  formülü tamamla, sonra $ veya $$ ile kapat.
- Aşağıdaki <context> bloğundaki notları kullandığında kaynağını topic başlığıyla belirt.
- <context> soruyu kapsamıyorsa bunu açıkça söyle; kapsamayan bir konuda uydurma cevap verme.`;

/**
 * Injects retrieved chunks as a fenced <context> block above the latest user
 * question, each prefixed with its source path and frontmatter summary.
 */
export async function buildPromptMessages(
	history: ChatMessage[],
	chunks: RetrievedChunk[]
): Promise<ProviderChatMessage[]> {
	const lastUser = history[history.length - 1];
	const priorTurns: ProviderChatMessage[] = history
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

	const skillsBlock = await renderUserSkillsBlock('chat');
	const systemPrompt = [CORE_INTRO, skillsBlock, CORE_INVARIANTS].filter(Boolean).join('\n\n');

	return [
		{ role: 'system', content: systemPrompt },
		...priorTurns,
		{ role: 'user', content: `${context}${lastUser.content}` }
	];
}
