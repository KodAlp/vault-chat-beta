import { error, redirect } from '@sveltejs/kit';
import { getChat } from '$lib/server/chats-db';
import type { PageServerLoad } from './$types';

/** Pre-Faz-9 bookmarks/links pointed at /chat/[id] directly, with no vault
 * in the URL at all. getChat() already returns vault_id on every row
 * (Faz 8 column) — look it up and redirect to the real vault-scoped path
 * instead of needing a second "which vault is this chat in" mechanism. */
export const load: PageServerLoad = async ({ params }) => {
	const chat = getChat(params.id);
	if (!chat) error(404, 'Konuşma bulunamadı');
	redirect(308, `/vault/${chat.vault_id}/chat/${params.id}`);
};
