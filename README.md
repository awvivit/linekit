# Linekit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Linekit turns line art (PNG, JPG, or WebP) into clean SVG, entirely in the browser. The site is a static Vite app and is published with GitHub Pages at [awvivit.github.io/linekit](https://awvivit.github.io/linekit/).

**Privacy.** Linekit is being built to process images only in your browser. This early version doesn't trace images yet.

The display name, package name, and Pages base path (`/linekit/`) live in [`src/brand.ts`](src/brand.ts). The npm package name is `linekit`.

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

Dependencies must carry an identified license. The license check fails on GPL, AGPL, LGPL, SSPL, and unknown licenses. An SPDX `OR` expression is accepted when at least one side is an allowed, identified license. Potrace and any other GPL-family tracing library are out of bounds. Later tracing is planned around [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) (public domain) and [SVGO](https://github.com/svg/svgo).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).
