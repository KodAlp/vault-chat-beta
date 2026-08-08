import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getChat,
	getMessages,
	updateChatModel,
	updateChatIncludedPaths,
	setChatTitle,
	deleteChat
} from '$lib/server/chats-db';
import type { ChatMessage, RetrievedChunk } from '$lib/types';

export const GET: RequestHandler = async ({ params }) => {
	const chat = getChat(params.id);
	if (!chat) error(404, 'Konuşma bulunamadı');

	const messages: ChatMessage[] = getMessages(params.id).map((row) => ({
		id: row.id,
		role: row.role,
		content: row.content,
		thinking: row.thinking ?? undefined,
		sources: row.sources_json ? (JSON.parse(row.sources_json) as RetrievedChunk[]) : undefined,
		hedges: row.hallucination_hedges_json ? (JSON.parse(row.hallucination_hedges_json) as string[]) : undefined
	}));

	return json({ chat, messages });
};

/** Chat-header per-chat model/provider override (Chat.svelte's overrideModel),
 * the source-tree scope selection (SourceTree.svelte, Faz 9 Adım 6), and the
 * chat-list rename button's title edit — three independent, optional fields,
 * any subset may be present. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	if (!getChat(params.id)) error(404, 'Konuşma bulunamadı');
	const body = (await request.json()) as {
		model?: string;
		includedPaths?: string[] | null;
		title?: string;
	};
	if (body.model === undefined && body.includedPaths === undefined && body.title === undefined) {
		error(400, "'model', 'includedPaths' veya 'title' gerekli");
	}
	if (body.model !== undefined) updateChatModel(params.id, body.model);
	if (body.includedPaths !== undefined) updateChatIncludedPaths(params.id, body.includedPaths);
	if (body.title !== undefined) setChatTitle(params.id, body.title);
	return json({ id: params.id, model: body.model, includedPaths: body.includedPaths, title: body.title });
};

export const DELETE: RequestHandler = async ({ params }) => {
	if (!getChat(params.id)) error(404, 'Konuşma bulunamadı');
	try {
		deleteChat(params.id);
		return json({ ok: true });
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Sohbet silinemedi');
	}
};
