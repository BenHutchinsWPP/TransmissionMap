import { defineConfig } from 'vite';
import { copyFileSync, statSync, createReadStream } from 'fs';
import path from 'path';

export default defineConfig(({ command }) => ({
  root: '.',
  base: command === 'build' ? '/TransmissionMap/' : '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 3000,
  },
  plugins: [
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
    {
      name: 'copy-sw',
      closeBundle() {
        copyFileSync('sw.js', 'dist/sw.js');
      },
    },
  ],
}));
