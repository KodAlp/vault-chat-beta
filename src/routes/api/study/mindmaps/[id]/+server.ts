import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMindMap, getMindMapNodes, deleteMindMap } from '#lib/server/study-db.js';
import { vaultFromUrl, vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';
import type { MindMapNodeView, MindMapView } from '#lib/types.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	const mindmap = getMindMap(v, params.id);
	if (!mindmap) fail('NOT_FOUND', { entity: 'mindmap' }, 404);

	const nodes: MindMapNodeView[] = getMindMapNodes(v, params.id).map((row) => ({
		id: row.id,
		path: JSON.parse(row.path_json) as string[],
		summary: row.summary,
		source_path: row.source_path,
		heading_path: row.heading_path
	}));

	const view: MindMapView = {
		id: mindmap.id,
		title: mindmap.title,
		model: mindmap.model,
		rootSummary: mindmap.root_summary
	};
	return json({ mindmap: view, nodes });
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { vault?: string };
	const v = vaultFromId(body.vault);
	if (!getMindMap(v, params.id)) fail('NOT_FOUND', { entity: 'mindmap' }, 404);
	deleteMindMap(v, params.id);
	return json({ ok: true });
};
