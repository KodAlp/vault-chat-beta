import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSlideDeck, getSlides, deleteSlideDeck } from '$lib/server/study-db';
import { vaultFromUrl, vaultFromId } from '$lib/server/requestVault';
import { fail } from '$lib/server/app-error';
import type { SlideDeckView, SlideView } from '$lib/types';

export const GET: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	const deck = getSlideDeck(v, params.id);
	if (!deck) fail('NOT_FOUND', { entity: 'slidedeck' }, 404);

	const slides: SlideView[] = getSlides(v, params.id).map((row) => ({
		id: row.id,
		position: row.position,
		layout: row.layout,
		heading: row.heading,
		content_markdown: row.content_markdown,
		notes: row.notes,
		source_path: row.source_path
	}));

	const view: SlideDeckView = {
		id: deck.id,
		title: deck.title,
		model: deck.model,
		rendered_html: deck.rendered_html,
		rendered_css: deck.rendered_css
	};
	return json({ deck: view, slides });
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { vault?: string };
	const v = vaultFromId(body.vault);
	if (!getSlideDeck(v, params.id)) fail('NOT_FOUND', { entity: 'slidedeck' }, 404);
	deleteSlideDeck(v, params.id);
	return json({ ok: true });
};
