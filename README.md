# Linekit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Linekit turns a photo of line art (PNG, JPEG, WebP, or HEIC) into clean SVG, entirely in the browser. The site is a static Vite app and is published with GitHub Pages at [awvivit.github.io/linekit](https://awvivit.github.io/linekit/).

**Privacy.** Linekit traces images only in your browser.

The display name, package name, and Pages base path (`/linekit/`) live in [`src/brand.ts`](src/brand.ts). The npm package name is `linekit`.

## Security

GitHub Pages cannot set HTTP response headers, so the Content Security Policy is a meta tag in the built page. `frame-ancestors` does not apply in a meta tag, and other sites can frame the page. Self-hosted copies can block embedding by sending a `frame-ancestors` HTTP header.

The photo and the traced SVG are shown from `blob:` URLs created in the page, so the policy allows `img-src 'self' blob:`. Scripts, workers, and connections stay on this origin. There is no `unsafe-inline` and no `unsafe-eval`.

## Requirements

- Node.js 22
- npm

Install from the lockfile:

```sh
npm ci
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run lint` | Oxlint |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Production build |
| `npm run preview` | Serve the production build |
| `npm run test:e2e` | Playwright smoke test against the production build |
| `npm run check-licenses` | Fail on GPL, AGPL, LGPL, SSPL, or an unknown license |
| `npm audit --audit-level=high` | Fail on high or critical advisories |

The dev server does not send the production Content Security Policy. Vite's dev client needs inline bootstrapping. Check the built site with:

```sh
npm run build && npm run preview -- --host 127.0.0.1 --port 4173
```

Then open [http://127.0.0.1:4173/linekit/](http://127.0.0.1:4173/linekit/).

## License policy

Linekit is [MIT](LICENSE), copyright 2026 Apolinario Vivit.

Dependencies must carry an identified license. The license check fails on GPL, AGPL, LGPL, SSPL, and unknown licenses. An SPDX `OR` expression is accepted when at least one side is an allowed, identified license. Potrace and any other GPL-family tracing library are out of bounds. Tracing uses [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) (public domain) and [SVGO](https://github.com/svg/svgo).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).
