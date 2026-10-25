import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDecks } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import type { StudySummary } from '$lib/types';

/** See quizzes/+server.ts for the rationale. Not yet wired into
 * StudyPanel.svelte's UI: there's no /study/cards/[deckId] view route to
 * navigate a clicked deck to today (cards/ reviews the due queue across
 * all decks, not a single deck), so this exists for parity/future use. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const items: StudySummary[] = listDecks(v).map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		createdAt: r.created_at
	}));
	return json({ items });
};
