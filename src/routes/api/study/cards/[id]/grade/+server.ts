import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCard, updateCardSchedule } from '$lib/server/study-db';
import { schedule, type Grade } from '$lib/server/schedule';

const VALID_GRADES: Grade[] = ['again', 'hard', 'good', 'easy'];

export const POST: RequestHandler = async ({ params, request }) => {
	const card = getCard(params.id);
	if (!card) error(404, 'Kart bulunamadı');

	const body = (await request.json()) as { grade: Grade };
	if (!VALID_GRADES.includes(body.grade)) error(400, 'Geçersiz derece');

	const next = schedule(
		{
			ease: card.ease,
			interval_days: card.interval_days,
			due_at: card.due_at,
			reps: card.reps,
			lapses: card.lapses
		},
		body.grade
	);
	updateCardSchedule(card.id, next);
	return json({ ok: true });
};
