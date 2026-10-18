<script lang="ts">
	import { onMount } from 'svelte';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { t } from '$lib/i18n/index.svelte';

	/**
	 * Custom title bar for the Tauri desktop window on Windows, where the native
	 * decorations are switched off (src-tauri/tauri.windows.conf.json). The bar
	 * and its non-interactive children carry data-tauri-drag-region (Tauri only
	 * drags from elements with the attribute; a double-click on it toggles
	 * maximize natively). The three caption buttons call the window API
	 * directly; the maximize/restore glyph follows the real window state via
	 * onResized + isMaximized(). Rendered by +layout.svelte, hidden in fullscreen.
	 */
	let maximized = $state(false);

	onMount(() => {
		const win = getCurrentWindow();
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const refresh = () => {
			win
				.isMaximized()
				.then((m) => {
					if (!disposed) maximized = m;
				})
				.catch(() => {});
		};
		refresh();
		win
			.onResized(refresh)
			.then((fn) => {
				if (disposed) fn();
				else unlisten = fn;
			})
			.catch(() => {});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	const minimize = () => void getCurrentWindow().minimize();
	const toggleMaximize = () => void getCurrentWindow().toggleMaximize();
	const close = () => void getCurrentWindow().close();
</script>

<div class="window-titlebar" data-tauri-drag-region>
	<img class="app-logo" src="/logo.png" alt="" width="16" height="16" draggable="false" data-tauri-drag-region />
	<span class="app-name" data-tauri-drag-region>Vault Chat</span>
	<div class="caption-buttons">
		<button type="button" class="cap" onclick={minimize} aria-label={t('WindowTitleBar.minimize')} title={t('WindowTitleBar.minimize')}>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
				<path d="M0 5.5h10" />
			</svg>
		</button>
		<button
			type="button"
			class="cap"
			onclick={toggleMaximize}
			aria-label={maximized ? t('WindowTitleBar.restore') : t('WindowTitleBar.maximize')}
			title={maximized ? t('WindowTitleBar.restore') : t('WindowTitleBar.maximize')}
		>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
				{#if maximized}
					<path d="M2.5 2.5V0.5h7v7h-2" />
					<rect x="0.5" y="2.5" width="7" height="7" />
				{:else}
					<rect x="0.5" y="0.5" width="9" height="9" />
				{/if}
			</svg>
		</button>
		<button type="button" class="cap close" onclick={close} aria-label={t('WindowTitleBar.close')} title={t('WindowTitleBar.close')}>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
				<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
			</svg>
		</button>
	</div>
</div>

<style>
	.window-titlebar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		height: 32px;
		background: var(--bg-sidebar);
		border-bottom: 1px solid var(--separator);
		user-select: none;
		-webkit-user-select: none;
	}

	.app-logo {
		margin-inline-start: var(--space-3);
		flex-shrink: 0;
		pointer-events: none;
	}

	.app-name {
		flex: 1;
		min-width: 0;
		padding-inline: var(--space-2) var(--space-3);
		font: 500 12px/32px var(--font-sans);
		color: var(--label-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.caption-buttons {
		display: flex;
		height: 100%;
	}

	.cap {
		all: unset;
		box-sizing: border-box;
		cursor: default;
		display: grid;
		place-items: center;
		width: 46px;
		height: 100%;
		color: var(--label);
		transition: background-color var(--duration-fast);
	}

	.cap:hover {
		background: var(--fill-hover);
	}

	.cap.close:hover {
		background: var(--danger);
		color: #fff;
	}

	.cap:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}
</style>
