/**
 * L4 — what to tell a macOS/Linux user where Windows gets a winget install button. Pure so it can be unit
 * tested; the page decides how to render it. Deliberately never suggests piping a script into a shell.
 */

export type InstallHint =
	| { kind: 'brew'; command: string }
	| { kind: 'package-manager' }
	| { kind: 'none' };

/** Homebrew formulae for the tools the setup page can ask about (LM Studio / Jan are GUI apps: download page only). */
const BREW_COMMANDS: Record<string, string> = {
	ollama: 'brew install ollama',
	llamacpp: 'brew install llama.cpp',
	python: 'brew install python@3.12',
	pandoc: 'brew install pandoc'
};

/** `platform` is the server's process.platform ('win32' | 'darwin' | 'linux' | ...). */
export function installHint(platform: string | null, tool: string): InstallHint {
	if (platform === 'darwin') {
		const command = BREW_COMMANDS[tool];
		return command ? { kind: 'brew', command } : { kind: 'none' };
	}
	if (platform === 'linux') {
		// Ollama's official Linux installer is a curl|sh one-liner: not suggested, the download page covers it.
		return tool === 'lmstudio' || tool === 'jan' || tool === 'ollama' ? { kind: 'none' } : { kind: 'package-manager' };
	}
	return { kind: 'none' };
}

/** winget exists only on Windows — the "winget wasn't found" note must not appear anywhere else. */
export function showWingetNote(platform: string | null): boolean {
	return platform === 'win32';
}
