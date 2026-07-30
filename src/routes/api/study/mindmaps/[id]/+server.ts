import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMindMap, getMindMapNodes } from '$lib/server/study-db';
import type { MindMapNodeView, MindMapView } from '$lib/types';

export const GET: RequestHandler = async ({ params }) => {
	const mindmap = getMindMap(params.id);
	if (!mindmap) error(404, 'Zihin haritası bulunamadı');

	const nodes: MindMapNodeView[] = getMindMapNodes(params.id).map((row) => ({
		id: row.id,
		path: JSON.parse(row.path_json) as string[],
		source_path: row.source_path,
		heading_path: row.heading_path
	}));

	const view: MindMapView = { id: mindmap.id, title: mindmap.title, model: mindmap.model };
	return json({ mindmap: view, nodes });
};
