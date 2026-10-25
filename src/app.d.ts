// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// Every server-thrown/handleError-returned error
		// carries a stable code (+ optional params) alongside its message, so
		// the client can localize it via ServerErrors.<code> instead of
		// rendering a hardcoded server-side string. See
		// src/lib/server/app-error.ts and src/hooks.server.ts's handleError.
		interface Error {
			message: string;
			code?: string;
			params?: Record<string, string | number>;
		}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
