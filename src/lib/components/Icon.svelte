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

	// Glyphs that encode a direction mirror in RTL (the .rtl-flip utility lives in app.css's base layer).
	const DIRECTIONAL = new Set(['arrow-forward', 'send', 'panel-right']);
	const flipClass = $derived(DIRECTIONAL.has(name) ? 'rtl-flip' : '');
	const sizeClass = $derived(size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : '');
</script>

<span
	class="vc-icon {sizeClass} {flipClass} {className}"
	style="--icon:url(/icons/{name}.svg)"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
></span>
