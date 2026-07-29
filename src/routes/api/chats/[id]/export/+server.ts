import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChat, getMessages, type MessageRow } from '$lib/server/chats-db';
import type { RetrievedChunk } from '$lib/types';

function safeFilename(title: string | null, id: string): string {
	const base = (title ?? id).replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim();
	return base || id;
}

/**
 * Raw non-ASCII bytes (Turkish ü/ç/ğ/ı/ö/ş, common in generated titles) are
 * not valid in a plain HTTP header value — plain `filename="..."` silently
 * mangles them. RFC 5987 `filename*=UTF-8''<percent-encoded>` alongside an
 * ASCII-only fallback is the correct, broadly-supported fix.
 */
function contentDisposition(filenameBase: string, ext: string): string {
	const asciiFallback = filenameBase.replace(/[^\x20-\x7E]/g, '_') || 'chat';
	const encoded = encodeURIComponent(`${filenameBase}.${ext}`);
	return `attachment; filename="${asciiFallback}.${ext}"; filename*=UTF-8''${encoded}`;
}

function toMarkdown(title: string | null, model: string, messages: MessageRow[]): string {
	const lines = [`# ${title ?? 'Başlıksız konuşma'}`, '', `Model: ${model}`, ''];
	for (const m of messages) {
		lines.push(`## ${m.role === 'user' ? 'Kullanıcı' : 'Asistan'}`, '', m.content, '');
		if (m.sources_json) {
			const sources = JSON.parse(m.sources_json) as RetrievedChunk[];
			if (sources.length) {
				lines.push(`Kaynaklar: ${sources.map((s) => s.topic).join(', ')}`, '');
			}
		}
	}
	return lines.join('\n');
}

export const GET: RequestHandler = async ({ params, url }) => {
	const chat = getChat(params.id);
	if (!chat) error(404, 'Konuşma bulunamadı');
	const messages = getMessages(params.id);

	const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
	const filename = safeFilename(chat.title, chat.id);

	if (format === 'json') {
		return new Response(JSON.stringify({ chat, messages }, null, 2), {
			headers: {
				'content-type': 'application/json',
				'content-disposition': contentDisposition(filename, 'json')
			}
		});
	}

	return new Response(toMarkdown(chat.title, chat.model, messages), {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': contentDisposition(filename, 'md')
		}
	});
};
