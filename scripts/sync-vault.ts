// Re-imports a vault's markdown from its live Obsidian source, then
// re-indexes it — the missing piece after the app's data model moved to an
// imported *copy* of the vault (see vault-registry skill) rather than
// reading the vault in place: nothing kept that copy honest. The real
// library this app ships with went 6 weeks stale with no indicator anywhere
// before this existed.
//
//   npm run sync-vault -- [--vault <id>] [--source <path>]
//
// --vault defaults to the registry's active vault (same resolution as every
// other CLI here, see indexer/paths.ts). --source defaults to .env's
// VAULT_PATH; importObsidianVault() itself validates that it exists and is
// a directory.
//
// Does the same two-step a human does through Ayarlar → Kütüphane →
// "Obsidian'dan İçe Aktar" followed by `npm run index`, just without a
// browser: importObsidianVault() (src/lib/server/importObsidian.ts, already
// source-path-parameterized — this script is the only thing that gives it a
// CLI entrypoint) then indexer/index-vault.ts as a child process, exactly
// like `npm run index -- --vault <id>` would run it. Kept as two real
// process boundaries rather than importing index-vault.ts's module-scope
// script directly — that file runs its indexing as a side effect of being
// loaded, not through an exported function, so shelling out to it is the
// non-invasive way to reuse it unchanged.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

try {
	process.loadEnvFile();
} catch {
	// .env is optional — VAULT_PATH falls through to the --source flag or
	// importObsidianVault()'s own "path not found" error.
}

const { resolveVault, markVaultSynced } = await import('../src/lib/server/vaults');
const { importObsidianVault } = await import('../src/lib/server/importObsidian');

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}

const vaultId = argValue('--vault');
const sourcePath = argValue('--source') ?? process.env.VAULT_PATH;

if (!sourcePath) {
	console.error(
		'Kaynak vault yolu yok — .env dosyasında VAULT_PATH ayarla ya da --source <yol> ver.'
	);
	process.exit(1);
}

async function main() {
	const v = resolveVault(vaultId);
	console.log(`vault: ${v.name} (${v.id})`);
	console.log(`kaynak: ${sourcePath}`);

	console.log('\n[1/2] İçe aktarılıyor...');
	const summary = await importObsidianVault(v, sourcePath, (item) => {
		if (item.status !== 'skipped') console.log(`  ${item.status.padEnd(12)} ${item.fileName}`);
	});
	const counts = summary.items.reduce<Record<string, number>>((acc, item) => {
		acc[item.status] = (acc[item.status] ?? 0) + 1;
		return acc;
	}, {});
	console.log(
		`  toplam: ${summary.items.length} | ` +
			Object.entries(counts)
				.map(([status, n]) => `${status}: ${n}`)
				.join(', ')
	);

	console.log('\n[2/2] Yeniden indeksleniyor...');
	// process.execPath + tsx's own CLI entry, not `npx tsx` and not the
	// .bin/tsx.cmd shim — execFileSync spawns without a shell, and on
	// Windows neither npx (npx.cmd, ENOENT without one) nor a .cmd binary
	// (EINVAL without one) can be exec'd directly that way. Both confirmed
	// live. process.execPath is a real .exe on every platform, and tsx's
	// actual entry point (what tsx.cmd itself ends up invoking) is plain
	// JS, so this needs neither a shell nor any Windows-specific branch.
	const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
	execFileSync(process.execPath, [tsxCli, 'indexer/index-vault.ts', '--vault', v.id], {
		stdio: 'inherit'
	});

	markVaultSynced(v.id);
	console.log(`\nBitti — lastSyncedAt: ${new Date().toISOString()}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
