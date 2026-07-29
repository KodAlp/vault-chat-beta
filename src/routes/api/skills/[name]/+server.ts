import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readSkillRaw, writeSkill, patchSkillFrontmatter, deleteSkill } from '$lib/server/userSkills';

export const GET: RequestHandler = async ({ params }) => {
	const raw = readSkillRaw(params.name);
	if (raw === undefined) error(404, 'Skill bulunamadı');
	return json({ name: params.name, raw });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { raw: string };
	try {
		writeSkill(params.name, body.raw);
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Geçersiz skill dosyası');
	}
	return json({ ok: true });
};

/** Quick-toggle path for the settings list — enable switch / priority
 * input, without round-tripping the full file body. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as Partial<{ enabled: boolean; priority: number }>;
	try {
		patchSkillFrontmatter(params.name, body);
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Geçersiz değer');
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const deleted = deleteSkill(params.name);
	if (!deleted) error(404, 'Skill bulunamadı');
	return json({ ok: true });
};
