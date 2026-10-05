<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import PaletteIcon from '@lucide/svelte/icons/palette';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import FolderInputIcon from '@lucide/svelte/icons/folder-input';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import Layers2Icon from '@lucide/svelte/icons/layers-2';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import type { Component } from 'svelte';

	let { children } = $props();

	// The content pane is its own scroll container, which SvelteKit's scroll
	// restoration doesn't reset — switching settings pages kept the old offset.
	let mainEl: HTMLDivElement | undefined = $state();
	afterNavigate(({ from, to }) => {
		if (from?.url?.pathname !== to?.url?.pathname) mainEl?.scrollTo(0, 0);
	});

	interface NavItem {
		href: string;
		label: string;
		icon: Component<any>;
		/** Leaves the settings area (a study page, not a settings page). */
		external?: boolean;
	}

	let groups = $derived<{ title: string; items: NavItem[] }[]>([
		{
			title: t('SettingsNav.groupGeneral'),
			items: [
				{ href: '/settings', label: t('SettingsNav.appearance'), icon: PaletteIcon },
				{ href: '/settings/vaults', label: t('SettingsNav.vaults'), icon: ArchiveIcon },
				{ href: '/settings/library', label: t('SettingsNav.upload'), icon: UploadIcon },
				{ href: '/settings/import', label: t('SettingsNav.importLibrary'), icon: FolderInputIcon },
				{ href: '/settings/skills', label: t('SettingsNav.skills'), icon: SparklesIcon },
				{ href: '/settings/memory', label: t('SettingsNav.memory'), icon: BrainIcon },
				{ href: '/study/progress', label: t('SettingsNav.progress'), icon: ChartColumnIcon, external: true }
			]
		},
		{
			title: t('SettingsNav.groupAdvanced'),
			items: [
				{ href: '/settings/models', label: t('SettingsNav.models'), icon: CpuIcon },
				{ href: '/settings/providers', label: t('SettingsNav.providers'), icon: PlugIcon },
				{ href: '/settings/embedding', label: t('SettingsNav.embedding'), icon: Layers2Icon },
				{ href: '/settings/smalltalk', label: t('SettingsNav.smalltalk'), icon: MessageCircleIcon }
			]
		}
	]);

	function isActive(item: NavItem, pathname: string): boolean {
		if (item.external) return false;
		const path = pathname.replace(/\/+$/, '') || '/';
		return item.href === '/settings' ? path === '/settings' : path === item.href || path.startsWith(item.href + '/');
	}

	let pageTitle = $derived(
		groups.flatMap((g) => g.items).find((i) => isActive(i, page.url.pathname))?.label ?? t('Common.ayarlar')
	);
</script>

<div class="settings-shell">
	<nav class="vc-sidebar settings-nav" aria-label={t('Common.ayarlar')}>
		<a href="/" class="vc-side-row settings-back">
			<ArrowLeftIcon class="rtl-flip" size={20} strokeWidth={1.75} aria-hidden="true" />
			{t('SettingsNav.backToApp')}
		</a>
		<div class="settings-nav-title">{t('Common.ayarlar')}</div>
		{#each groups as group (group.title)}
			<div class="settings-group">
				<div class="vc-side-head">{group.title}</div>
				{#each group.items as item (item.href)}
					{@const Icon = item.icon}
					<a
						href={item.href}
						class="vc-side-row"
						aria-current={isActive(item, page.url.pathname) ? 'page' : undefined}
					>
						<Icon size={20} strokeWidth={1.75} aria-hidden="true" />
						{item.label}
						{#if item.external}
							<ArrowUpRightIcon class="meta" size={16} strokeWidth={1.75} aria-label={t('SettingsNav.leavesSettings')} />
						{/if}
					</a>
				{/each}
			</div>
		{/each}
	</nav>

	<div class="settings-main" bind:this={mainEl}>
		<div class="settings-content">
			<h1 class="text-title-1 settings-title">{pageTitle}</h1>
			{@render children()}
		</div>
	</div>
</div>

<style>
	.settings-shell {
		display: flex;
		height: 100%;
		min-height: 0;
	}
	.settings-nav {
		--sidebar-width: 240px;
		flex: none;
		overflow-y: auto;
	}
	.settings-nav-title {
		font: var(--text-title-2);
		letter-spacing: var(--tracking-title-2, normal);
		padding: var(--space-3) var(--space-3) var(--space-1);
	}
	.settings-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.settings-nav :global(.vc-side-row) {
		text-decoration: none;
		flex: none;
	}
	.settings-nav :global(.vc-side-row:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}
	.settings-nav :global(.vc-side-row .meta) {
		margin-inline-start: auto;
		color: var(--label-secondary);
	}
	.settings-main {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		background: var(--bg-grouped);
	}
	.settings-content {
		max-width: 720px;
		margin: 0 auto;
		padding: var(--space-6, 24px) var(--space-6, 24px) 64px;
	}
	.settings-title {
		margin: 0 0 var(--space-5, 20px);
		color: var(--label);
	}

	@media (max-width: 760px) {
		.settings-shell {
			flex-direction: column;
		}
		.settings-nav {
			--sidebar-width: 100%;
			width: 100%;
			flex-direction: row;
			align-items: center;
			gap: 2px;
			overflow-x: auto;
			overflow-y: hidden;
			border-inline-end: none;
			border-bottom: 1px solid var(--separator);
			padding: var(--space-2);
		}
		.settings-nav-title,
		.settings-nav :global(.vc-side-head) {
			display: none;
		}
		.settings-group {
			flex-direction: row;
			gap: 2px;
		}
		.settings-content {
			padding: var(--space-4, 16px) var(--space-4, 16px) 48px;
		}
	}
</style>
