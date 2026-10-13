// Starts `vite dev` against a throwaway DATA_DIR for the Playwright suite. Never touches real user data:
// the directory is wiped on start and must live under the OS temp dir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = process.env.E2E_PORT || '5185';
const dir = path.resolve(process.env.E2E_DATA_DIR || path.join(os.tmpdir(), 'vault-chat-e2e-data'));
const tmp = path.resolve(os.tmpdir());
if (!dir.toLowerCase().startsWith(tmp.toLowerCase() + path.sep) || dir.split(path.sep).length < 4) {
	console.error(`e2e: refusing to use DATA_DIR outside the temp dir: ${dir}`);
	process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const vite = path.resolve('node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(process.execPath, [vite, 'dev', '--port', port, '--strictPort', '--host', '127.0.0.1'], {
	stdio: 'inherit',
	env: { ...process.env, DATA_DIR: dir }
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
