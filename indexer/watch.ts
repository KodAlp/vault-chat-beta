import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';
import { EXCLUDED_DIRS } from './excluded-dirs';

try {
	process.loadEnvFile();
} catch {
	// .env is optional
}

const VAULT_PATH = path.resolve(process.cwd(), process.env.VAULT_PATH ?? '..');
const DEBOUNCE_MS = 2000;

let debounceTimer: NodeJS.Timeout | undefined;
let running = false;
let rerunPending = false;

function runIndex() {
	if (running) {
		rerunPending = true;
		return;
	}
	running = true;
	console.log('[watch] değişiklik algılandı, indeksleniyor...');
	const child = spawn('npx', ['tsx', 'indexer/index-vault.ts'], {
		cwd: process.cwd(),
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	child.on('exit', () => {
		running = false;
		if (rerunPending) {
			rerunPending = false;
			scheduleIndex();
		}
	});
}

function scheduleIndex() {
	clearTimeout(debounceTimer);
	debounceTimer = setTimeout(runIndex, DEBOUNCE_MS);
}

function isExcluded(filePath: string): boolean {
	const rel = path.relative(VAULT_PATH, filePath);
	return rel.split(path.sep).some((segment) => EXCLUDED_DIRS.has(segment));
}

function onMarkdownEvent(filePath: string) {
	if (!filePath.endsWith('.md') || isExcluded(filePath)) return;
	scheduleIndex();
}

console.log(`[watch] izleniyor: ${VAULT_PATH}`);
console.log('[watch] Ctrl+C ile durdur. Varsayılan iş akışı manueldir — bu opsiyoneldir.');

const watcher = chokidar.watch(VAULT_PATH, {
	ignored: isExcluded,
	ignoreInitial: true
});

watcher.on('add', onMarkdownEvent);
watcher.on('change', onMarkdownEvent);
watcher.on('unlink', onMarkdownEvent);
