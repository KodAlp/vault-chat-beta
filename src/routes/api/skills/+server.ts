import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAllUserSkillFiles } from '#lib/server/userSkills.js';

export const GET: RequestHandler = async () => {
	return json({ skills: listAllUserSkillFiles() });
};
