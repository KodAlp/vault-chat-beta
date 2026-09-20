const SESSION_KEY = 'vault-chat-welcome-shown';

/** sessionStorage, not localStorage — "once per app launch" means once per
 * process/tab lifetime, not once ever. A closed and reopened app (or a new
 * Tauri window) is a new session, so the welcome screen shows again, same
 * as settings.showWelcomeScreen's own "her açılışında bir kere" wording. */
export function welcomeAlreadyShown(): boolean {
	if (typeof sessionStorage === 'undefined') return true;
	return sessionStorage.getItem(SESSION_KEY) === '1';
}

export function markWelcomeShown(): void {
	if (typeof sessionStorage === 'undefined') return;
	sessionStorage.setItem(SESSION_KEY, '1');
}
