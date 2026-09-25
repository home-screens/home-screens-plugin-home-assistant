import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import * as mdi from '@mdi/js';

/** Home Assistant's icon catalog, written next to the bundle rather than
 *  into it: dist/mdi.json maps every @mdi/js export name to its path data,
 *  and the icon set's license ships beside it. Only the editor fetches the
 *  catalog (src/mdi-catalog.ts); a look rule saves the path it picked, so the
 *  display bundle never carries or loads the catalog. */
function mdiCatalog(): Plugin {
  return {
    name: 'mdi-catalog',
    generateBundle() {
      const catalog = Object.fromEntries(
        Object.entries(mdi).filter(([name, path]) => name.startsWith('mdi') && typeof path === 'string'),
      );
      this.emitFile({ type: 'asset', fileName: 'mdi.json', source: JSON.stringify(catalog) });
      this.emitFile({
        type: 'asset',
        fileName: 'mdi-icons-LICENSE.txt',
        source: readFileSync(fileURLToPath(new URL('./node_modules/@mdi/js/LICENSE', import.meta.url))),
      });
    },
  };
}

export default defineConfig({
  plugins: [mdiCatalog()],
  esbuild: {
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  },
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['iife'],
      name: '__HS_PLUGIN__',
      fileName: () => 'bundle.js',
    },
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        // 'named' ensures the IIFE always produces an object ({ default: ... })
        // rather than assigning a bare value when there is only a default export.
        // The plugin loader reads window.__HS_PLUGIN__['default'].
        exports: 'named',
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
      },
    },
  },
});
