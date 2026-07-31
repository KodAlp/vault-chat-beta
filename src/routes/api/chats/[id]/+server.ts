import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChat, getMessages, updateChatModel, updateChatIncludedPaths } from '$lib/server/chats-db';
import type { ChatMessage, RetrievedChunk } from '$lib/types';

export const GET: RequestHandler = async ({ params }) => {
	const chat = getChat(params.id);
	if (!chat) error(404, 'Konuşma bulunamadı');

	const messages: ChatMessage[] = getMessages(params.id).map((row) => ({
		id: row.id,
		role: row.role,
		content: row.content,
		thinking: row.thinking ?? undefined,
		sources: row.sources_json ? (JSON.parse(row.sources_json) as RetrievedChunk[]) : undefined
	}));

	return json({ chat, messages });
};

/** Chat-header per-chat model/provider override (Chat.svelte's overrideModel)
 * and the source-tree scope selection (SourceTree.svelte, Faz 9 Adım 6) —
 * two independent, optional fields, either or both may be present. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	if (!getChat(params.id)) error(404, 'Konuşma bulunamadı');
	const body = (await request.json()) as { model?: string; includedPaths?: string[] | null };
	if (body.model === undefined && body.includedPaths === undefined) {
		error(400, "'model' veya 'includedPaths' gerekli");
	}
	if (body.model !== undefined) updateChatModel(params.id, body.model);
	if (body.includedPaths !== undefined) updateChatIncludedPaths(params.id, body.includedPaths);
	return json({ id: params.id, model: body.model, includedPaths: body.includedPaths });
};
