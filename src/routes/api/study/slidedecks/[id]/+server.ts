import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSlideDeck, getSlides } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import type { SlideDeckView, SlideView } from '$lib/types';

export const GET: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	const deck = getSlideDeck(v, params.id);
	if (!deck) error(404, 'Sunum bulunamadı');

	const slides: SlideView[] = getSlides(v, params.id).map((row) => ({
		id: row.id,
		position: row.position,
		content_markdown: row.content_markdown,
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
