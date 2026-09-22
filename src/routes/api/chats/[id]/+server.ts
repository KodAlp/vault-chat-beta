import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getChat,
	getMessages,
	updateChatModel,
	updateChatProvider,
	updateChatIncludedPaths,
	updateChatMode,
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

/** Chat-header per-chat model/provider override (Chat.svelte's overrideModel/
 * overrideProvider), the source-tree scope selection (SourceTree.svelte, Faz 9
 * Adım 6), the chat-list rename button's title edit, and the F6 mode toggle
 * (Chat.svelte's chatMode) — five independent, optional fields, any subset
 * may be present. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	if (!getChat(params.id)) error(404, 'Konuşma bulunamadı');
	const body = (await request.json()) as {
		model?: string;
		provider?: string | null;
		includedPaths?: string[] | null;
		title?: string;
		mode?: string;
	};
	if (
		body.model === undefined &&
		body.provider === undefined &&
		body.includedPaths === undefined &&
		body.title === undefined &&
		body.mode === undefined
	) {
		error(400, "'model', 'provider', 'includedPaths', 'title' veya 'mode' gerekli");
	}
	if (body.model !== undefined) updateChatModel(params.id, body.model);
	if (body.provider !== undefined) updateChatProvider(params.id, body.provider);
	if (body.includedPaths !== undefined) updateChatIncludedPaths(params.id, body.includedPaths);
	if (body.title !== undefined) setChatTitle(params.id, body.title);
	if (body.mode !== undefined) updateChatMode(params.id, body.mode);
	return json({
		id: params.id,
		model: body.model,
		provider: body.provider,
		includedPaths: body.includedPaths,
		title: body.title,
		mode: body.mode
	});
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
