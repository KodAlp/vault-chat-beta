import type { ChatMessage, RetrievedChunk } from '$lib/types';
import type { ChatMessage as ProviderChatMessage } from './providers/types';
import { renderUserSkillsBlock } from './userSkills';

/** Vault-level default when a vault has no LibrarySettings.allowedLanguages
 * of its own yet (pre-existing settings.json, or /api/skills/preview's
 * no-real-vault-context preview). */
export const DEFAULT_ALLOWED_LANGUAGES = ['Türkçe'];

/** Exported for /api/skills/preview alongside the analogous constants in
 * generate-quiz.ts/generate-cards.ts. `allowedLanguages` comes from the
 * requesting vault's LibrarySettings (see api/chat/+server.ts) — the first
 * entry is the primary response language, any further entries are hinted
 * as acceptable secondary languages (e.g. a language-learning vault set to
 * ['Türkçe', 'Korece']) instead of being treated as leaked/corrupted output. */
export function coreIntro(allowedLanguages: string[]): string {
	const [primary, ...extra] = allowedLanguages.length ? allowedLanguages : DEFAULT_ALLOWED_LANGUAGES;
	const extraNote = extra.length
		? ` Gerektiğinde şu dillerden kelime/örnek de kullanabilirsin: ${extra.join(', ')}.`
		: '';
	return `Sen bu kişisel bilgi kasasının (Obsidian tabanlı ikinci beyin) öğretici asistanısın.
Her zaman ${primary} dilinde cevap ver.${extraNote}`;
}

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
	chunks: RetrievedChunk[],
	allowedLanguages: string[],
	opts?: { toolsEnabled?: boolean }
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

	const skillsBlock = await renderUserSkillsBlock('chat', { includeFileNotes: opts?.toolsEnabled });
	const systemPrompt = [coreIntro(allowedLanguages), skillsBlock, CORE_INVARIANTS].filter(Boolean).join('\n\n');

	return [
		{ role: 'system', content: systemPrompt },
		...priorTurns,
		{ role: 'user', content: `${context}${lastUser.content}` }
	];
}
