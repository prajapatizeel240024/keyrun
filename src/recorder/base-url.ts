/** Default base URL for a recording: the tenant root for the mock apps (/t/<id>), else the origin. */
export function guessBaseUrl(url: string): string {
  const u = new URL(url);
  const m = /^\/t\/[^/]+/.exec(u.pathname);
  return u.origin + (m ? m[0] : '');
}
