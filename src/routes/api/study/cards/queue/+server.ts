import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDueCards } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import type { CardView } from '$lib/types';

const DEFAULT_LIMIT = 50;

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const limitParam = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;
	// Optional per-deck scoping (per-deck review) — omitted keeps the
	// existing cross-deck behavior exactly as before.
	const deckId = url.searchParams.get('deck') ?? undefined;

	const rows = getDueCards(v, new Date().toISOString(), limit, deckId);
	const cards: CardView[] = rows.map((row) => ({
		id: row.id,
		front: row.front,
		back: row.back,
		source_path: row.source_path,
		heading_path: row.heading_path
	}));
	return json({ cards });
};
