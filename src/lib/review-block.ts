import { REVIEW_MAX_CHARS } from './review-limits';

/**
 * F6 — formats the REVIEW-mode block spliced into the chat prompt (prompt.ts) when a chat is in review mode.
 * Pure and dependency-free, like memory-block.ts: the caller (review-mode.ts) shapes plain data from F1b/F2's
 * already-computed, already-validated learner profile and weak-spot list plus the existing due-card query — this
 * module never touches a database and never calls an LLM. It only templates what to prioritize; the model does
 * the actual asking/grading, as instructed.
 *
 * Unlike memory-block.ts, the result is never '' — review mode is something the user explicitly chose, so if
 * there is genuinely nothing to review the block says that plainly rather than leaving the model with no
 * guidance and silently reading as an ordinary free_chat turn.
 */

export interface ReviewBlockInput {
	/** Most overdue first (review-mode.ts already sorts getDueCards this way). */
	dueCards: readonly { front: string }[];
	weakDomains: readonly { name: string; masteryPct: number }[];
	openWeakSpots: readonly { noteName: string; openErrors: number }[];
	staleDomains: readonly { name: string; daysSince: number }[];
}

function trimmed(text: string, max = 160): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function sections(input: ReviewBlockInput): string[] {
	const out: string[] = [];
	if (input.dueCards.length > 0) out.push(`Vadesi gelen kartlar: ${input.dueCards.map((c) => trimmed(c.front)).join('; ')}.`);
	if (input.openWeakSpots.length > 0) out.push(`Açık zayıf noktalar: ${input.openWeakSpots.map((s) => `${s.noteName} (${s.openErrors})`).join(', ')}.`);
	if (input.weakDomains.length > 0) out.push(`Zayıf alanlar: ${input.weakDomains.map((d) => `${d.name} (~%${Math.round(d.masteryPct)})`).join(', ')}.`);
	if (input.staleDomains.length > 0) out.push(`Uzun süredir tekrarlanmamış: ${input.staleDomains.map((d) => `${d.name} (${d.daysSince} gün)`).join(', ')}.`);
	return out;
}

const HEADER = '## Tekrar oturumu';
const NOTHING_DUE = `${HEADER}\nBu sohbet tekrar modunda ama şu anda belirgin bir öncelik yok (vadesi gelen kart, zayıf alan ya da uzun süredir tekrarlanmamış konu yok). Normal bir sohbet gibi devam et.`;

const AGENDA_INTRO = 'Bu sohbet tekrar modunda. Şunları önceliklendir, kullanıcıya sorular sor, cevaplarını değerlendir:';

/** Trims sections least-urgent-first (stale domains, then weak domains, then open weak spots) when over budget;
 * due cards — the most concrete, actionable item — are kept until nothing else is left to drop. */
export function buildReviewBlockText(input: ReviewBlockInput): string {
	let staleDomains = input.staleDomains;
	let weakDomains = input.weakDomains;
	let openWeakSpots = input.openWeakSpots;
	const { dueCards } = input;

	const body = () => {
		const lines = sections({ dueCards, weakDomains, openWeakSpots, staleDomains });
		return lines.length === 0 ? null : `${HEADER}\n${AGENDA_INTRO}\n${lines.join('\n')}`;
	};

	let text = body();
	if (text === null) return NOTHING_DUE;

	while (text.length > REVIEW_MAX_CHARS && staleDomains.length > 0) {
		staleDomains = staleDomains.slice(0, -1);
		text = body() ?? NOTHING_DUE;
	}
	while (text.length > REVIEW_MAX_CHARS && weakDomains.length > 0) {
		weakDomains = weakDomains.slice(0, -1);
		text = body() ?? NOTHING_DUE;
	}
	while (text.length > REVIEW_MAX_CHARS && openWeakSpots.length > 0) {
		openWeakSpots = openWeakSpots.slice(0, -1);
		text = body() ?? NOTHING_DUE;
	}

	return text;
}
