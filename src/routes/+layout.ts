// markdown.ts uses the browser build of DOMPurify (needs `window`); no SSR benefit
// for a local-only app, so keep this off everywhere rather than add jsdom.
export const ssr = false;
