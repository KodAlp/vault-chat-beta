import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeck, getDeckCards } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import { fail } from '$lib/server/app-error';
import type { CardView } from '$lib/types';

/** Backs /study/cards/[id] — the previously-unused getDeckCards() (see its
 * own doc comment for why this is unfiltered by due date, unlike
 * /api/study/cards/queue). 404s on an unknown deck id so the page can tell
 * "empty deck" apart from "deck doesn't exist / wrong vault". */
export const GET: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	const deck = getDeck(v, params.id);
	if (!deck) fail('NOT_FOUND', { entity: 'deck' }, 404);

	const cards: CardView[] = getDeckCards(v, params.id).map((row) => ({
		id: row.id,
		front: row.front,
		back: row.back,
		source_path: row.source_path,
		heading_path: row.heading_path
	}));
	return json({ deckName: deck.name, cards });
};
