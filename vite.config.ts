import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { site } from './src/brand.ts'

export default defineConfig({
  base: site.basePath,
  plugins: [
    react(),
    {
      name: 'linekit-app-name',
      transformIndexHtml(html) {
        return html.replaceAll('__APP_NAME__', site.name)
      },
    },
    {
      name: 'linekit-content-security-policy',
      // Vite's dev client needs inline bootstrapping and eval. The built site is what ships.
      // A meta policy applies only to content that follows it, so this runs after asset injection
      // and places the tag immediately after the charset declaration.
      apply: 'build',
      enforce: 'post',
      transformIndexHtml(html) {
        const meta = `<meta http-equiv="Content-Security-Policy" content="${site.contentSecurityPolicy}" />`
        if (html.includes('Content-Security-Policy')) {
          return html
        }
        const charset = '<meta charset="UTF-8" />'
        if (!html.includes(charset)) {
          throw new Error('index.html is missing the charset meta tag')
        }
        return html.replace(charset, `${charset}\n    ${meta}`)
      },
    },
  ],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  },
})
