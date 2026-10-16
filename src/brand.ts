const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: is the on-device preview for the photo and the traced SVG. No remote origins.
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

/** Display name, npm package name, and GitHub Pages base path. */
export const site = {
  name: 'Linekit',
  packageName: 'linekit',
  basePath: '/linekit/',
  contentSecurityPolicy,
} as const
