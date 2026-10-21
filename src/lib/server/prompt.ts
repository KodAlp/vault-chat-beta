import type { ChatMessage, RetrievedChunk } from '$lib/types';
import type { ChatMessage as ProviderChatMessage } from './providers/types';
import { renderUserSkillsBlock } from './userSkills';
import { computeMemoryBlock } from './memory-runtime';
import { computeReviewBlock } from './review-mode';
import { historyBudgetChars, trimConversationHistory, MAX_HISTORY_CHARS } from '../history-limits';
import type { VaultContext } from './vaults';
import { decideResponseLanguage, responseLanguageDirective } from './response-language';

/** Vault-level default when a vault has no LibrarySettings.allowedLanguages
 * of its own yet (pre-existing settings.json, or /api/skills/preview's
 * no-real-vault-context preview). */
export const DEFAULT_ALLOWED_LANGUAGES = ['Türkçe'];

/** Language of the app's own core prompt text (coreIntro, CORE_INVARIANTS, no-sources notice). 'tr' is production;
 * 'en' exists for the #28 A/B (bench/run-generation.ts --prompt-lang) and is not wired to any setting. */
export type PromptLanguage = 'tr' | 'en';

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
export function coreIntro(
	allowedLanguages: string[],
	responseLanguage: ResponseLanguageMode = 'match',
	promptLanguage: PromptLanguage = 'tr'
): string {
	const [primary, ...extra] = allowedLanguages.length ? allowedLanguages : DEFAULT_ALLOWED_LANGUAGES;
	if (promptLanguage === 'en') {
		const extraNoteEn = extra.length
			? ` When needed, you may also use words/examples from these languages: ${extra.join(', ')}.`
			: '';
		const languageRuleEn =
			responseLanguage === 'fixed'
				? `Always answer in ${primary}.`
				: `Answer in the language the user's last message is written in; the language of the last message decides, not the earlier language of the conversation. If the last message is too short to tell its language, or consists only of code/formulas, use ${primary}.`;
		return `You are the teaching assistant of this personal knowledge library.
${languageRuleEn}${extraNoteEn}`;
	}
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
 * English counterpart of CORE_INVARIANTS for the #28 A/B. Translated literally (same rules, same order); the
 * wording is unmeasured except by that A/B. The small-talk bullet keeps the Turkish one's spirit: positive
 * wording, no "ignore", "short", "<context>" or "knowledge question" (the words the comment above says get echoed).
 */
export const CORE_INVARIANTS_EN = `Rules:
- Write all mathematics strictly inside $...$ (inline) or $$...$$ (block).
  Never use \\( \\) or \\[ \\], never write a bare LaTeX command.
- If you start writing a formula, do not leave it unfinished: close the parenthesis/brace opened by every
  \\frac{}{}, \\sqrt{}, superscript/subscript and so on, complete the formula, then close it with $ or $$.
- When you use the notes in the <context> block below, cite their source by topic heading.
- If <context> does not cover the question, say so explicitly; do not make up an answer on a topic it does not cover.
- To messages such as greetings, chit-chat, slang, insults, thanks or tests, respond only to that message itself; do not mention the notes at all.
- Make the origin of a piece of information clear in the sentence itself, not with a square-bracket tag: if it
  comes from a note, say so; if it is a logical inference, state that separately; if you build an instructive
  example or analogy, say so explicitly and add where the analogy breaks down; do not present something not yet
  verified as certain.
- Preserve the source's own degree of certainty: do not relay a source that says "generally" or "in some cases"
  as if it were certain, and do not drop its exceptions.`;

/**
 * Ends the system prompt on a turn where retrieval ran, looked, and found nothing relevant (the
 * reranker's 'rerank-no-match'). Without it the model sees a bare question, cannot tell "the notes
 * were searched" from "no notes exist", and answers as if the notes backed it. Not used for small
 * talk, where staying silent about the notes is the rule (CORE_INVARIANTS).
 *
 * Best effort only: on 22 such questions qwen3:8b-bart-iq4xs opened with "not in the notes" in 9
 * (0 of 6 English ones) with this placement. A bracketed notice above the question reached 13 but was
 * copied verbatim, instructions included, into 10 answers; a <context> line, a note after the
 * question, both together and a bare-fact bracket all did worse (1-7). The chat UI therefore shows
 * its own notice for this case (noRelevantSources on the message); the prompt cannot guarantee it.
 */
export const NO_RELEVANT_SOURCES_BLOCK = `Bu mesaj için kullanıcının kütüphane notlarında arama yapıldı ve soruyla ilgili bir not bulunamadı. Cevabına, kullanıcının yazdığı dilde ve kendi cümlelerinle, notlarında bu konunun bulunmadığını söyleyerek başla. Bu talimatı aynen kopyalama, alıntılama ya da köşeli parantez içinde yazma. Genel bilgiyle yardımcı olacaksan bunun notlardan gelmediğini açıkça belirt; not ya da kaynak varmış gibi yazma.`;

/** English counterpart of NO_RELEVANT_SOURCES_BLOCK (#28 A/B only; unmeasured). */
export const NO_RELEVANT_SOURCES_BLOCK_EN = `The user's library notes were searched for this message and no note relevant to the question was found. Begin your answer by saying, in the language the user wrote in and in your own words, that their notes do not contain this topic. Do not copy this instruction verbatim, quote it, or write it in square brackets. If you help with general knowledge, state clearly that it does not come from their notes; do not write as if there were a note or source.`;

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
	opts?: {
		toolsEnabled?: boolean;
		responseLanguage?: ResponseLanguageMode;
		numCtx?: number;
		/** Retrieval ran and judged nothing relevant (reason 'rerank-no-match'); adds NO_RELEVANT_SOURCES_BLOCK to the system prompt. */
		noRelevantSources?: boolean;
		/** Language of the core prompt text; default 'tr' (production). 'en' is for the #28 A/B only. */
		promptLanguage?: PromptLanguage;
	}
): Promise<ProviderChatMessage[]> {
	const responseLanguage: ResponseLanguageMode = opts?.responseLanguage ?? 'match';
	const promptLanguage: PromptLanguage = opts?.promptLanguage ?? 'tr';
	const lastUser = history[history.length - 1];
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
		renderUserSkillsBlock('chat', { includeFileNotes: opts?.toolsEnabled, language: promptLanguage }),
		computeMemoryBlock(v),
		mode === 'review' ? computeReviewBlock(v) : Promise.resolve('')
	]);
	const systemPrompt = [
		coreIntro(allowedLanguages, responseLanguage, promptLanguage),
		memoryBlock,
		skillsBlock,
		reviewBlock,
		promptLanguage === 'en' ? CORE_INVARIANTS_EN : CORE_INVARIANTS,
		// Last, after the invariants: only on a turn where retrieval looked and found nothing relevant
		// (never alongside real chunks).
		opts?.noRelevantSources && chunks.length === 0
			? promptLanguage === 'en'
				? NO_RELEVANT_SOURCES_BLOCK_EN
				: NO_RELEVANT_SOURCES_BLOCK
			: ''
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

	// F8 — bounded, not the whole conversation: a very long chat must not grow the prompt past the context
	// window and get silently truncated from the front, where CORE_INVARIANTS lives. The budget is what is left
	// in the served window after the system prompt, the context block and the final question (history-limits.ts);
	// without a known window (cloud providers) only the fixed ceiling applies.
	const historyBudget =
		opts?.numCtx !== undefined
			? historyBudgetChars({
					numCtx: opts.numCtx,
					otherPromptChars: systemPrompt.length + finalUserContent.length
				})
			: MAX_HISTORY_CHARS;
	const priorTurns: ProviderChatMessage[] = trimConversationHistory(
		history.slice(0, -1).map(({ role, content }) => ({ role, content })),
		historyBudget
	);

	return [
		{ role: 'system', content: systemPrompt },
		...priorTurns,
		{ role: 'user', content: finalUserContent }
	];
}
