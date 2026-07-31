import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, data }) => {
	return { ...data, vaultId: params.id, chatId: params.chatId };
};
