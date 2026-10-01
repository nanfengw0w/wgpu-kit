/** Resolve site URLs from the deployment base embedded in every generated page. */
const configuredBase = document.documentElement.dataset.base ?? '/wgpu-kit/';
export const siteBase = '/' + configuredBase.replace(/^\/+|\/+$/g, '') + '/';

export function sitePath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith(siteBase)) return path;
  return siteBase + path.slice(1);
}

export function siteRoutePath(pathname: string): string | null {
  if (pathname === siteBase.slice(0, -1)) return '/';
  return pathname.startsWith(siteBase) ? '/' + pathname.slice(siteBase.length) : null;
}
