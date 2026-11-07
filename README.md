# Linekit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Linekit**: Draw it. Snap it. Get clean SVG.
> Take a photo of a drawing on paper, and Linekit turns it into SVG on this device. Nothing is uploaded. Works with PNG, JPEG and WebP, and with HEIC in browsers that can open it.

**Auto** is the default. It looks at the image in the browser. Plain two-tone ink becomes **Lines**: one editable stroke through the middle of the ink, with straighten, close gaps, and erase. Gray shading, tapered ink, or several flat colors become **Full trace**: filled shapes that keep thickness, tapered ends, gray fills, and flat color. A short note says which one Auto picked, including the starting number of colors for Full trace. One tap switches to Lines or Full trace. Undo puts Auto's result back.

**More controls** holds Smooth out noise, Edge detail, Even out lighting, and, for Full trace, Number of colors. Lines also keeps Pick up faint lines, Smoothing, and Remove specks. Reset puts those controls back to Auto's values and leaves eraser marks and other edits alone. Whether the panel is open is remembered on that device. Fix perspective and crop stay in that panel.

**Straighten shapes** snaps a nearly straight stroke to a line, and a nearly rectangular, circular, or elliptical outline to that shape. The Straighten tolerance slider sets how far the ink may stray. **Close gaps** joins ends that fall inside the gap size you set. **Eraser** erases lines on the result. **Fix perspective** drags the four corners of the photo before tracing. Select a line and move **Smooth this line** to soften that line on its own. **Undo** and **Redo** (Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z) step through those edits.

The photo shown beside the trace is a smaller copy (about 2000px on the long edge), and the tracing code loads only after you open a photo.

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

Dependencies must carry an identified license. The license check fails on GPL, AGPL, LGPL, SSPL, and unknown licenses. An SPDX `OR` expression is accepted when at least one side is an allowed, identified license. Potrace and any other GPL-family tracing library are out of bounds. Full trace and the legacy outline use [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) 1.2.6, dedicated to the public domain under [The Unlicense](https://unlicense.org/) (`node_modules/imagetracerjs/LICENSE`). Its optional `nodecli` folder vendors a separate MIT PNG reader that Linekit does not import. SVGO optimizes the SVG in the browser. Centerlines are implemented in this repo: Zhang–Suen thinning, a Euclidean distance transform, and Schneider cubic fitting. Those papers were used as references; their source was not copied. There is no Potrace and no GPL tracer.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).
