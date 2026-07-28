// markdown.ts uses the browser build of DOMPurify (needs `window`); no SSR benefit
// for a single local-only chat page, so keep this off rather than add jsdom.
export const ssr = false;
