<script lang="ts">
	// Mask-based icon (static/icons/<name>.svg) — takes currentColor via the
	// .vc-icon rule in src/styles/components.css. Decorative unless `label` is set.
	type Props = {
		name: string;
		size?: 'sm' | 'md' | 'lg';
		label?: string;
		class?: string;
	};

	let { name, size = 'md', label, class: className = '' }: Props = $props();

	const sizeClass = $derived(size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : '');
</script>

<span
	class="vc-icon {sizeClass} {className}"
	style="--icon:url(/icons/{name}.svg)"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
></span>
