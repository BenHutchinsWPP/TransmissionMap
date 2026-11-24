import { defineConfig, runnerImport } from 'vite';
import { copyFileSync, statSync, createReadStream } from 'fs';
import path from 'path';

// The production page's Content Security Policy, as a <meta http-equiv> right
// after <meta charset> (which must stay in the first 1024 bytes), so it comes
// before every script and modulepreload link. Build only: the dev server's HMR
// websocket and inline client stay unrestricted. The policy is
// assets/constants.ts's CSP_POLICY, imported through Vite with the build's own
// env (PROD, the Esri key), so its hosts are the origins this bundle fetches from.
// The same pass adds the Cloudflare Web Analytics beacon (constants.ts ANALYTICS_*)
// before </body> when TM_ANALYTICS=1, which only the deploy workflow sets, so local
// builds and previews send nothing. "spa": false counts page loads only: the app
// rewrites the hash on every pan, which the beacon would otherwise count as a view.
const CHARSET = '<meta charset="utf-8">';
function cspMeta() {
  let env = {};
  return {
    name: 'csp-meta',
    apply: 'build',
    configResolved(config) { env = config.env; },
    async transformIndexHtml(html) {
      if (!html.includes(CHARSET)) throw new Error(`csp-meta: index.html has no ${CHARSET}`);
      const define = Object.fromEntries(
        Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));
      const { module } = await runnerImport('/assets/constants.ts', { configFile: false, logLevel: 'silent', define });
      html = html.replace(CHARSET, `${CHARSET}\n  <meta http-equiv="Content-Security-Policy" content="${module.CSP_POLICY}">`);
      if (process.env.TM_ANALYTICS !== '1') return html;
      if (!html.includes('</body>')) throw new Error('csp-meta: index.html has no </body>');
      const beacon = `<script type="module" src="${module.ANALYTICS_SCRIPT_URL}" data-cf-beacon='{"token": "${module.ANALYTICS_TOKEN}", "spa": false}'></script>`;
      return html.replace('</body>', `  ${beacon}\n</body>`);
    },
  };
}

function copySw() {
  let outDir = 'dist';
  return {
    name: 'copy-sw',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() { copyFileSync('sw.js', path.join(outDir, 'sw.js')); },
  };
}

export default defineConfig({
  root: '.',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 3000,
    // data/ and tmp/ hold build outputs with tens of thousands of files; the app
    // fetches them, it never imports them, so they need no file watch.
    watch: { ignored: ['**/data/**', '**/tmp/**', '**/venv/**', '**/coverage/**'] },
  },
  plugins: [
    cspMeta(),
    {
      name: 'dev-static-fixes',
      configureServer(server) {
        // Strip Content-Encoding: gzip on .gz files so the browser delivers raw
        // bytes to fetch() — map-layers.js decompresses manually via DecompressionStream.
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.includes('.gz')) {
            const orig = res.setHeader.bind(res);
            res.setHeader = (name, value) => {
              if (name.toLowerCase() === 'content-encoding') return;
              return orig(name, value);
            };
          }
          next();
        });

        // Serve HTTP Range requests for PMTiles byte-serving.
        server.middlewares.use((req, res, next) => {
          const rangeHeader = req.headers['range'];
          if (!rangeHeader) return next();

          const pathname = new URL(req.url, 'http://localhost').pathname;
          const filePath = path.join(process.cwd(), pathname);
          let stat;
          try { stat = statSync(filePath); } catch { return next(); }

          const fileSize = stat.size;
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (!match) return next();

          const start = parseInt(match[1]);
          const end = match[2] ? parseInt(match[2]) : fileSize - 1;

          res.writeHead(206, {
            'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges':  'bytes',
            'Content-Length': end - start + 1,
            'Content-Type':   'application/octet-stream',
          });
          createReadStream(filePath, { start, end }).pipe(res);
        });
      },
    },
    copySw(),
  ],
});
