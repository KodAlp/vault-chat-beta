import { runVaultMigrationIfNeeded } from '$lib/server/migrateVaults';
import { logAppEvent } from '$lib/server/app-log';

// Runs once per server process start, before any request is handled —
// exactly what a one-time "migrate legacy single-library layout to the
// vault registry" step needs. See vault-registry skill.
runVaultMigrationIfNeeded();

// Nothing in this app installed these before — Node's default behavior for
// either is to print to stderr and kill the whole process. Installing a
// handler suppresses that default printing, so each handler below writes
// to stderr ITSELF, first — the packaged desktop build's Rust side now
// continuously drains the sidecar's stdout/stderr for its whole life (see
// spawn_sidecar in src-tauri/src/lib.rs), so this is what actually reaches
// launch.log. logAppEvent's data/app-log.jsonl entry is the durable,
// structured second copy, not the only copy.
process.on('uncaughtException', (err) => {
	const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
	process.stderr.write(`uncaughtException: ${text}\n`);
	logAppEvent({ kind: 'fatal_error', message: `uncaughtException: ${text}` });
	// Matches Node's own guidance: don't keep serving after a truly uncaught
	// exception, state may be inconsistent.
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
	process.stderr.write(`unhandledRejection: ${text}\n`);
	logAppEvent({ kind: 'fatal_error', message: `unhandledRejection: ${text}` });
});
