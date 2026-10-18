<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte';
	import { onMount } from 'svelte';
	import { pendingImports, refreshPendingImports } from '$lib/pending-imports.svelte';
	import { attentionCount } from '$lib/pending-imports-view';

	let { children } = $props();

	// Pending imports needing the user (ready + error): one fetch on entering settings; the panel on the
	// upload page keeps the shared store fresh afterwards.
	let pendingCount = $derived(attentionCount(pendingImports.items));
	onMount(() => {
		void refreshPendingImports();
	});

	// The content pane is its own scroll container, which SvelteKit's scroll
	// restoration doesn't reset — switching settings pages kept the old offset.
	let mainEl: HTMLDivElement | undefined = $state();
	afterNavigate(({ from, to }) => {
		if (from?.url?.pathname !== to?.url?.pathname) mainEl?.scrollTo(0, 0);
	});

	interface NavItem {
		href: string;
		label: string;
		icon: string;
		/** Leaves the settings area (a study page, not a settings page). */
		external?: boolean;
		/** Count shown as a small pill after the label (hidden at 0). */
		badge?: number;
	}

	let groups = $derived<{ title: string; items: NavItem[] }[]>([
		{
			title: t('SettingsNav.groupGeneral'),
			items: [
				{ href: '/settings', label: t('SettingsNav.appearance'), icon: 'palette' },
				{ href: '/settings/vaults', label: t('SettingsNav.vaults'), icon: 'archive' },
				{ href: '/settings/library', label: t('SettingsNav.upload'), icon: 'upload', badge: pendingCount },
				{ href: '/settings/skills', label: t('SettingsNav.skills'), icon: 'sparkles' },
				{ href: '/settings/memory', label: t('SettingsNav.memory'), icon: 'neurology' },
				{ href: '/study/progress', label: t('SettingsNav.progress'), icon: 'chart-column', external: true }
			]
		},
		{
			title: t('SettingsNav.groupAdvanced'),
			items: [
				{ href: '/settings/models', label: t('SettingsNav.models'), icon: 'cpu' },
				{ href: '/settings/providers', label: t('SettingsNav.providers'), icon: 'plug' },
				{ href: '/settings/embedding', label: t('SettingsNav.embedding'), icon: 'layers-2' },
				{ href: '/settings/smalltalk', label: t('SettingsNav.smalltalk'), icon: 'message-circle' }
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
			<Icon name="arrow-left" class="rtl-flip" />
			{t('SettingsNav.backToApp')}
		</a>
		<div class="settings-nav-title">{t('Common.ayarlar')}</div>
		{#each groups as group (group.title)}
			<div class="settings-group">
				<div class="vc-side-head">{group.title}</div>
				{#each group.items as item (item.href)}
					<a
						href={item.href}
						class="vc-side-row"
						aria-current={isActive(item, page.url.pathname) ? 'page' : undefined}
					>
						<Icon name={item.icon} />
						{item.label}
						{#if item.badge}
							<span class="nav-badge" aria-label={t('PendingImports.navBadgeLabel', { count: item.badge })}>{item.badge}</span>
						{/if}
						{#if item.external}
							<Icon name="arrow-up-right" size="sm" label={t('SettingsNav.leavesSettings')} class="meta" />
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
	.nav-badge {
		margin-inline-start: auto;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 9px;
		background: var(--accent-soft);
		color: var(--accent-text);
		font-size: 11px;
		line-height: 18px;
		text-align: center;
		font-weight: 600;
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
