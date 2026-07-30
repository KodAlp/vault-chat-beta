import { runVaultMigrationIfNeeded } from '$lib/server/migrateVaults';

// Runs once per server process start, before any request is handled —
// exactly what a one-time "migrate legacy single-library layout to the
// vault registry" step needs. See vault-registry skill.
runVaultMigrationIfNeeded();
