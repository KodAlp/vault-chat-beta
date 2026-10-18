<script lang="ts">
	// Animated, multi-part icons drawn inline (not masks) so each part can move.
	// Animations run on hover / keyboard focus of the surrounding button or link,
	// or while `play` is true. `active` carries state (panel open). Colour is
	// currentColor; motion is removed under prefers-reduced-motion.
	export type AnimatedIconName = 'cards' | 'mindmap' | 'panel-right' | 'panel-left' | 'sources' | 'report' | 'slides' | 'progress';
	type Props = {
		name: AnimatedIconName;
		size?: 'sm' | 'md' | 'lg' | number;
		active?: boolean;
		play?: boolean;
		label?: string;
		class?: string;
	};

	let { name, size = 'md', active = false, play = false, label, class: className = '' }: Props = $props();

	const uid = $props.id();
	const px = $derived(typeof size === 'number' ? size : size === 'sm' ? 16 : size === 'lg' ? 24 : 20);
	const strokeWidth = $derived(px <= 16 ? 1.6 : px <= 20 ? 1.35 : 1.2);
</script>

<svg
	class="ai ai-{name} {className}"
	class:active
	class:play
	width={px}
	height={px}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	{#if name === 'cards'}
		<g class="c-back"><path d="M8 3.5h10.5a2 2 0 0 1 2 2v8.5"/></g>
		<g class="c-mid"><path d="M5.5 6h10.5a2 2 0 0 1 2 2v8.5"/></g>
		<g class="c-front">
		  <rect x="3" y="8.5" width="13" height="12" rx="2"/>
		  <g class="c-q"><path d="M7.9 12.6a1.6 1.6 0 1 1 2.3 1.45c-.45.22-.7.55-.7 1v.3"/><path d="M9.5 17.6v.01"/></g>
		  <g class="c-a"><path d="M6 13h7"/><path d="M6 15.5h7"/><path d="M6 18h4"/></g>
		</g>
	{:else if name === 'mindmap'}
		<path class="m-b m-b1" pathLength="1" d="M8.5 11.25C6.5 11.25 7.3 6 5.75 6"/>
		<path class="m-b m-b2" pathLength="1" d="M8.5 12.75C6.5 12.75 7.3 18 5.75 18"/>
		<path class="m-b m-b3" pathLength="1" d="M15.5 11.25C17.5 11.25 16.7 6 18.25 6"/>
		<path class="m-b m-b4" pathLength="1" d="M15.5 12.75C17.5 12.75 16.7 18 18.25 18"/>
		<circle class="m-l m-l1" cx="4" cy="6" r="1.75"/>
		<circle class="m-l m-l2" cx="4" cy="18" r="1.75"/>
		<circle class="m-l m-l3" cx="20" cy="6" r="1.75"/>
		<circle class="m-l m-l4" cx="20" cy="18" r="1.75"/>
		<g class="m-core"><rect x="8.5" y="10" width="7" height="4" rx="2"/><path d="M10.75 12h2.5"/></g>
	{:else if name === 'panel-right'}
		<rect x="3" y="4.5" width="18" height="15" rx="2.5"/>
		<g class="p-pane"><path d="M15 4.5v15"/><path d="M17.25 8.5h1.5"/><path d="M17.25 11h1.5"/><path d="M17.25 13.5h1"/></g>
		<g class="p-nudge"><path class="p-chev" d="M8.25 9.5 10.75 12l-2.5 2.5"/></g>
	{:else if name === 'panel-left'}
		<g class="mir">
		<rect x="3" y="4.5" width="18" height="15" rx="2.5"/>
		<g class="p-pane"><path d="M15 4.5v15"/><path d="M17.25 8.5h1.5"/><path d="M17.25 11h1.5"/><path d="M17.25 13.5h1"/></g>
		<g class="p-nudge"><path class="p-chev" d="M8.25 9.5 10.75 12l-2.5 2.5"/></g>
		</g>
	{:else if name === 'sources'}
		<defs><clipPath id="{uid}-s"><rect x="0" y="0" width="24" height="10"/></clipPath></defs>
		<path d="M3 10V6.25A1.75 1.75 0 0 1 4.75 4.5H9l2 2h8.25A1.75 1.75 0 0 1 21 8.25V10"/>
		<g clip-path="url(#{uid}-s)"><g class="s-sheet"><path d="M7.5 13V8.75h9V13"/><path d="M10 11h4"/></g></g>
		<g class="s-flap"><path d="M3 10h18v8.25A1.75 1.75 0 0 1 19.25 20H4.75A1.75 1.75 0 0 1 3 18.25Z"/><path d="M10 14.5h4"/></g>
	{:else if name === 'report'}
		<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>
		<path d="M14 3v4a1 1 0 0 0 1 1h4"/>
		<path class="r-l r-l0" pathLength="1" d="M8 8.5h3"/>
		<path class="r-l r-l1" pathLength="1" d="M8 12h8"/>
		<path class="r-l r-l2" pathLength="1" d="M8 15h8"/>
		<path class="r-l r-l3" pathLength="1" d="M8 18h5"/>
	{:else if name === 'slides'}
		<defs><clipPath id="{uid}-b"><rect x="3.75" y="4.25" width="16.5" height="11"/></clipPath></defs>
		<rect x="3" y="3.5" width="18" height="12.5" rx="2"/>
		<path d="M12 16v3"/><path d="M8.5 21 12 19l3.5 2"/>
		<g clip-path="url(#{uid}-b)">
		  <g class="sl-a"><path d="M6.5 7h5"/><path d="M6.5 13 9.5 10.5 12 12l5.5-4.5"/></g>
		  <g class="sl-b"><path d="M6.5 7.25h11"/><path d="M6.5 10.25h.01"/><path d="M9 10.25h6"/><path d="M6.5 13h.01"/><path d="M9 13h8"/></g>
		</g>
	{:else if name === 'progress'}
		<path d="M3.5 20.5h17"/>
		<rect class="g-b g-b1" x="5.25" y="13" width="3" height="7.5" rx="1"/>
		<rect class="g-b g-b2" x="10.5" y="6.5" width="3" height="14" rx="1"/>
		<rect class="g-b g-b3" x="15.75" y="10" width="3" height="10.5" rx="1"/>
	{/if}
</svg>

<style>
.ai{--ai-base:var(--duration-base,220ms);--ai-ease:cubic-bezier(.2,0,0,1)}
.ai{display:inline-block;flex:none;overflow:visible;vertical-align:middle}
.ai *{transform-box:fill-box;transform-origin:center}
.ai .mir{transform-box:view-box;transform-origin:center;transform:scaleX(-1)}

/* cards: the stack fans out, the top card flips from question to answer */
.c-mid,.c-back{transition:transform var(--ai-base) var(--ai-ease)}
.c-a{opacity:0}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .c-mid, .ai:hover .c-mid, .ai.play .c-mid{transform:translate(.6px,-.6px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .c-back, .ai:hover .c-back, .ai.play .c-back{transform:translate(1.3px,-1.3px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .c-front, .ai:hover .c-front, .ai.play .c-front{animation:ai-flip 520ms var(--ai-ease) both}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .c-q, .ai:hover .c-q, .ai.play .c-q{animation:ai-out 520ms steps(1,end) both}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .c-a, .ai:hover .c-a, .ai.play .c-a{animation:ai-in 520ms steps(1,end) both}

/* mind map: branches grow from the core, leaves pop in turn */
.m-b{stroke-dasharray:1;stroke-dashoffset:0}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-core, .ai:hover .m-core, .ai.play .m-core{animation:ai-pulse 260ms var(--ai-ease)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-b, .ai:hover .m-b, .ai.play .m-b{animation:ai-draw 340ms var(--ai-ease) both}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-b2, .ai:hover .m-b2, .ai.play .m-b2{animation-delay:60ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-b3, .ai:hover .m-b3, .ai.play .m-b3{animation-delay:120ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-b4, .ai:hover .m-b4, .ai.play .m-b4{animation-delay:180ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-l, .ai:hover .m-l, .ai.play .m-l{animation:ai-pop 300ms var(--ai-ease) both}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-l1, .ai:hover .m-l1, .ai.play .m-l1{animation-delay:200ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-l2, .ai:hover .m-l2, .ai.play .m-l2{animation-delay:260ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-l3, .ai:hover .m-l3, .ai.play .m-l3{animation-delay:320ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .m-l4, .ai:hover .m-l4, .ai.play .m-l4{animation-delay:380ms}

/* panels: chevron shows what a click does, the pane previews it on hover */
.p-pane,.p-nudge{transition:transform var(--ai-base) var(--ai-ease)}
.p-chev{transition:transform var(--ai-base) var(--ai-ease);transform:rotate(180deg)}
.ai.active .p-chev{transform:rotate(0deg)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .p-pane, .ai:hover .p-pane, .ai.play .p-pane{transform:translateX(-1.5px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .p-nudge, .ai:hover .p-nudge, .ai.play .p-nudge{transform:translateX(-.75px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai.active .p-pane, .ai.active:hover .p-pane, .ai.play.active .p-pane{transform:translateX(1.5px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai.active .p-nudge, .ai.active:hover .p-nudge, .ai.play.active .p-nudge{transform:translateX(.75px)}

/* sources: a sheet rises out of the folder, the flap tips open */
.s-sheet,.s-flap{transition:transform var(--ai-base) var(--ai-ease)}
.s-flap{transform-origin:center bottom}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .s-sheet, .ai:hover .s-sheet, .ai.play .s-sheet{transform:translateY(-1.6px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .s-flap, .ai:hover .s-flap, .ai.play .s-flap{transform:scaleY(.9)}

/* report: lines write themselves */
.r-l{stroke-dasharray:1;stroke-dashoffset:0}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .r-l, .ai:hover .r-l, .ai.play .r-l{animation:ai-draw 300ms var(--ai-ease) both}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .r-l1, .ai:hover .r-l1, .ai.play .r-l1{animation-delay:90ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .r-l2, .ai:hover .r-l2, .ai.play .r-l2{animation-delay:180ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .r-l3, .ai:hover .r-l3, .ai.play .r-l3{animation-delay:270ms}

/* slides: next slide slides in */
.sl-a,.sl-b{transition:transform 320ms var(--ai-ease)}
.sl-b{transform:translateX(15px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .sl-a, .ai:hover .sl-a, .ai.play .sl-a{transform:translateX(-15px)}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .sl-b, .ai:hover .sl-b, .ai.play .sl-b{transform:translateX(0)}

/* progress: bars grow from the baseline */
.g-b{transform-origin:center bottom}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .g-b, .ai:hover .g-b, .ai.play .g-b{animation:ai-grow 420ms var(--ai-ease) both}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .g-b2, .ai:hover .g-b2, .ai.play .g-b2{animation-delay:70ms}
:global(:is(button, a, [role="button"], label, summary):is(:hover, :focus-visible)) .ai .g-b3, .ai:hover .g-b3, .ai.play .g-b3{animation-delay:140ms}

@keyframes ai-flip{0%{transform:scaleX(1)}45%,55%{transform:scaleX(0)}100%{transform:scaleX(1)}}
@keyframes ai-out{0%{opacity:1}50%,100%{opacity:0}}
@keyframes ai-in{0%{opacity:0}50%,100%{opacity:1}}
@keyframes ai-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes ai-pop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes ai-pulse{50%{transform:scale(1.08)}}
@keyframes ai-grow{from{transform:scaleY(.2)}to{transform:scaleY(1)}}

@media (prefers-reduced-motion: reduce){
  .ai *{animation:none !important;transition:none !important}
}
</style>
