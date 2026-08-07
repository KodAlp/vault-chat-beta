import { runVaultMigrationIfNeeded } from '$lib/server/migrateVaults';
import { logAppEvent } from '$lib/server/app-log';

// Runs once per server process start, before any request is handled —
// exactly what a one-time "migrate legacy single-library layout to the
// vault registry" step needs. See vault-registry skill.
runVaultMigrationIfNeeded();

// Nothing in this app installed these before — Node's default behavior for
// either is to print to stderr and kill the whole process. In the packaged
// desktop build that's silent death: the sidecar's stdout/stderr pipes are
// only drained once, during the Rust side's 15s startup-timeout check
// (src-tauri/src/lib.rs) — once the port opens, nothing ever reads them
// again, so a crash after that point leaves zero trace and the webview just
// sees a refused connection. Log first so the next occurrence is
// diagnosable instead of a mystery.
process.on('uncaughtException', (err) => {
	logAppEvent({
		kind: 'fatal_error',
		message: `uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
	});
	// Matches Node's own guidance: don't keep serving after a truly uncaught
	// exception, state may be inconsistent.
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	logAppEvent({
		kind: 'fatal_error',
		message: `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
	});
});
