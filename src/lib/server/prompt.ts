import type { ChatMessage, RetrievedChunk } from '$lib/types';
import type { ChatMessage as ProviderChatMessage } from './providers/types';
import { renderUserSkillsBlock } from './userSkills';
import { computeMemoryBlock } from './memory-runtime';
import { computeReviewBlock } from './review-mode';
import { trimConversationHistory } from '../history-limits';
import type { VaultContext } from './vaults';
import { decideResponseLanguage, responseLanguageDirective } from './response-language';

/** Vault-level default when a vault has no LibrarySettings.allowedLanguages
 * of its own yet (pre-existing settings.json, or /api/skills/preview's
 * no-real-vault-context preview). */
export const DEFAULT_ALLOWED_LANGUAGES = ['Türkçe'];

/** LibrarySettings.responseLanguage's two modes — see the type's own doc comment in
 * $lib/types.ts. Exported so callers (chat route, tests) can reference the literal type. */
export type ResponseLanguageMode = 'match' | 'fixed';

/** Exported for /api/skills/preview alongside the analogous constants in
 * generate-quiz.ts/generate-cards.ts. `allowedLanguages` comes from the
 * requesting vault's LibrarySettings (see api/chat/+server.ts) — the first
 * entry is the primary response language, any further entries are hinted
 * as acceptable secondary languages (e.g. a language-learning vault set to
 * ['Türkçe', 'Korece']) instead of being treated as leaked/corrupted output.
 *
 * `responseLanguage` ('match', the default): the last user message's own language decides the
 * reply language, not the vault's primary — see response-language.ts's decideResponseLanguage
 * (measured 90/90 on scripts/eval-response-language.ts's battery vs. ~57% for always naming the
 * primary language). 'fixed': today's original behavior, always name the primary language — kept
 * for language-learning vaults, whose whole point is answering in a language other than the
 * question's. */
export function coreIntro(allowedLanguages: string[], responseLanguage: ResponseLanguageMode = 'match'): string {
	const [primary, ...extra] = allowedLanguages.length ? allowedLanguages : DEFAULT_ALLOWED_LANGUAGES;
	const extraNote = extra.length
		? ` Gerektiğinde şu dillerden kelime/örnek de kullanabilirsin: ${extra.join(', ')}.`
		: '';
	const languageRule =
		responseLanguage === 'fixed'
			? `Her zaman ${primary} dilinde cevap ver.`
			: `Kullanıcının son mesajı hangi dilde yazılmışsa o dilde cevap ver; sohbetin önceki dili değil, son mesajın dili belirleyicidir. Son mesaj dili anlaşılamayacak kadar kısaysa ya da yalnızca kod/formülden oluşuyorsa ${primary} kullan.`;
	return `Sen bu kişisel bilgi kütüphanesinin öğretici asistanısın.
${languageRule}${extraNote}`;
}

/*
 * The last rule below is measured wording, do not "improve" it casually. Retrieval attaches
 * sources to small talk the gate has not learned yet (smalltalk-gate.ts), and the two rules
 * above ("use the notes", "say if they do not cover it") made the model weave them into its
 * answer. A/B on the real vault, 36 small-talk answers with sources per variant: no rule 16
 * odd/long (e.g. "Bilgi kaynağına göre, Borg sisteminin…"); "…<context> bloğunu yok say… kısa
 * ve doğal bir karşılık ver" 2, but real answers got 35% shorter and the model started
 * narrating the rule ("…bloğunu yok sayarak…", 4/36); this wording 1, no echo, real questions
 * still sourced and on topic. Keep it positive and free of the words the model echoes
 * (<context>, "yok say", "bilgi sorusu", "kısa").
 */

/**
 * Non-overridable, appended after any user skills — see userSkills.ts and
 * the user-skills skill doc's "assembly order" section. Local models weight
 * later instructions more heavily, so these must always be last.
 *
 * The last two bullets (F7) are a compressed, always-on version of the
 * `educational-agent` skill's epistemic-model.md — that file stays as the
 * more detailed, opt-in reinforcement (per-category sentence openers, the
 * two most common failure modes) for when the skill is actually enabled;
 * these two lines are the floor every chat gets regardless. Deliberately
 * prose, not bracketed tags: a past attempt at machine-readable confidence
 * tags ([LOW]/[HIGH], "ConfidenceBadge") was abandoned because prompt.ts
 * never actually asked the model to produce them, so the parser had nothing
 * to parse — see .claude/ROADMAP.md. Character/token cost of these two
 * lines was not measured live (no Ollama timing run for this specific
 * change); see the F7 section of the plan doc for the estimate.
 */
export const CORE_INVARIANTS = `Kurallar:
- Tüm matematiği kesinlikle $...$ (satır içi) veya $$...$$ (blok) içinde yaz.
  Asla \\( \\) ya da \\[ \\] kullanma, asla çıplak LaTeX komutu yazma.
- Bir formülü yazmaya başladıysan yarım bırakma: her \\frac{}{}, \\sqrt{},
  üst/alt simge gibi yapının açtığı parantez/süslü parantezi kapat ve
  formülü tamamla, sonra $ veya $$ ile kapat.
- Aşağıdaki <context> bloğundaki notları kullandığında kaynağını topic başlığıyla belirt.
- <context> soruyu kapsamıyorsa bunu açıkça söyle; kapsamayan bir konuda uydurma cevap verme.
- Selamlaşma, sohbet, argo, hakaret, teşekkür ya da deneme gibi mesajlara yalnızca o mesajın kendisine karşılık ver; notlardan hiç söz etme.
- Bilginin kaynağını köşeli parantez etiketiyle değil cümlenin kendisiyle belli et: nottan
  geliyorsa öyle söyle, mantıksal bir çıkarımsa ayrı belirt, öğretici bir örnek ya da benzetme
  kuruyorsan bunu açıkça söyle ve benzetmenin nerede kırıldığını da ekle, henüz doğrulanmamış
  bir şeyi kesinmiş gibi sunma.
- Kaynağın kendi kesinlik derecesini koru: "genellikle", "bazı durumlarda" diyen bir kaynağı
  kesinmiş gibi aktarma, istisnalarını düşürme.`;

/**
 * Injects retrieved chunks as a fenced <context> block above the latest user
 * question, each prefixed with its source path and frontmatter summary.
 */
export async function buildPromptMessages(
	history: ChatMessage[],
	chunks: RetrievedChunk[],
	allowedLanguages: string[],
	v: VaultContext,
	mode: string = 'free_chat',
	opts?: { toolsEnabled?: boolean; responseLanguage?: ResponseLanguageMode }
): Promise<ProviderChatMessage[]> {
	const responseLanguage: ResponseLanguageMode = opts?.responseLanguage ?? 'match';
	const lastUser = history[history.length - 1];
	// F8 — bounded, not the whole conversation: a very long chat must not grow the prompt past the context
	// window and get silently truncated from the front, where CORE_INVARIANTS lives. See history-limits.ts.
	const priorTurns: ProviderChatMessage[] = trimConversationHistory(
		history.slice(0, -1).map(({ role, content }) => ({ role, content }))
	);

	const context =
		chunks.length > 0
			? `<context>\n${chunks
					.map(
						(c) =>
							`[${c.topic} | ${c.heading_path}] (${c.path}, depth: ${c.depth})\n${c.display_text}`
					)
					.join('\n\n---\n\n')}\n</context>\n\n`
			: '';

	// Order matters: local models weight later instructions more heavily (see CORE_INVARIANTS's own doc comment).
	// The memory block (F3, facts about the learner) sits below the user's own explicit skill customizations —
	// it should outweigh nothing. The review block (F6), when this chat is in review mode, sits ABOVE the user's
	// skills: it's a stronger, session-defining directive (what THIS conversation is for), but still yields to
	// the hard invariants right below it. computeReviewBlock only runs for mode === 'review' — an ordinary
	// free_chat turn does no extra work and produces the exact same prompt as before F6.
	const [skillsBlock, memoryBlock, reviewBlock] = await Promise.all([
		renderUserSkillsBlock('chat', { includeFileNotes: opts?.toolsEnabled }),
		computeMemoryBlock(v),
		mode === 'review' ? computeReviewBlock(v) : Promise.resolve('')
	]);
	const systemPrompt = [
		coreIntro(allowedLanguages, responseLanguage),
		memoryBlock,
		skillsBlock,
		reviewBlock,
		CORE_INVARIANTS
	]
		.filter(Boolean)
		.join('\n\n');

	// 'match' mode: tell the model, concretely, which language the LAST user message is written
	// in — appended only to that final turn (never historical ones, which were already sent to
	// the model in earlier requests as-is). See response-language.ts's doc comment for why this
	// beats a fixed-language instruction alone (measured 90/90 vs ~57% on the eval battery).
	let finalUserContent = `${context}${lastUser.content}`;
	if (responseLanguage === 'match') {
		const primary = allowedLanguages.length ? allowedLanguages[0] : DEFAULT_ALLOWED_LANGUAGES[0];
		const priorUserMessages = history
			.slice(0, -1)
			.filter((m) => m.role === 'user')
			.map((m) => m.content);
		const decision = decideResponseLanguage(lastUser.content, priorUserMessages, primary);
		finalUserContent = `${finalUserContent}\n\n${responseLanguageDirective(decision)}`;
	}

	return [
		{ role: 'system', content: systemPrompt },
		...priorTurns,
		{ role: 'user', content: finalUserContent }
	];
}
