import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChat, getMessages, updateChatModel } from '$lib/server/chats-db';
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

/** Chat-header per-chat model/provider override, see Chat.svelte's
 * overrideModel state — persisted so the choice survives a reload. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	if (!getChat(params.id)) error(404, 'Konuşma bulunamadı');
	const body = (await request.json()) as { model?: string };
	if (!body.model) error(400, "'model' gerekli");
	updateChatModel(params.id, body.model);
	return json({ id: params.id, model: body.model });
};
