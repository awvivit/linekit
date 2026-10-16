# Contributing to Linekit

Thanks for helping. Linekit is an MIT-licensed static site. The app runs in the browser, with no server and no analytics.

## Setup

1. Use Node.js 22.
2. Install from the lockfile with `npm ci`.
3. Run the same checks that pull requests run:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run check-licenses
npx playwright install --with-deps chromium
npm run test:e2e
```

`npm run dev` is for local UI work. The production Content Security Policy is applied to the built site only. Preview it at `http://127.0.0.1:4173/linekit/` after `npm run build && npm run preview -- --host 127.0.0.1 --port 4173`.

## Project rules

- Keep the site static. Do not add a backend, upload endpoint, analytics, or a font or script CDN.
- The Pages base path is `/linekit/`. Change it in `src/brand.ts` if the repository name changes.
- Dependencies must use an identified license. GPL, AGPL, LGPL, SSPL, and unknown licenses fail CI.
- An SPDX `OR` expression is acceptable when one side is an allowed license. `AND` with a forbidden license is not.
- Potrace and other GPL-family tracers are not acceptable. Tracing uses imagetracerjs (public domain) and SVGO.
- Do not configure Dependabot auto-merge.

## Pull requests

Open pull requests against `main`. Describe what changed and how you checked it. Keep commits focused.

By contributing, you agree that your contributions are licensed under the MIT License, copyright 2026 Apolinario Vivit, the same as the rest of the repository.
