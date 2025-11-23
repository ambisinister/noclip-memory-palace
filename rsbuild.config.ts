import { defineConfig, type RequestHandler } from '@rsbuild/core';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';
import { execSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import parseUrl from 'parseurl';
import send from 'send';
import { join } from 'node:path';

let gitCommit = '(unknown)';
try {
  gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
  console.warn('Failed to fetch Git commit hash', e);
}

export default defineConfig({
  source: {
    entry: {
      index: './src/main.ts',
      embed: './src/main.ts',
    },
    // Legacy decorators are used with `reflect-metadata`.
    // TODO: Migrate to TypeScript 5.0 / TC39 decorators.
    decorators: {
      version: 'legacy',
    },
    define: {
      __COMMIT_HASH: JSON.stringify(gitCommit),
      __OPENROUTER_API_KEY: JSON.stringify(process.env.OPENROUTER_API_KEY || ''),
    },
  },
  html: {
    template: './src/index.html',
  },
  output: {
    target: 'web',
    // Mark Node.js built-in modules as external.
    externals: ['fs', 'path', 'url'],
    // TODO: These should be converted to use `new URL('./file.wasm', import.meta.url)`
    // so that the bundler can resolve them. In the meantime, they're expected to be
    // at the root.
    copy: [
      { from: 'src/**/*.wasm', to: '[name][ext]' },
      { from: 'node_modules/librw/lib/librw.wasm', to: 'static/js/[name][ext]' },
      { from: 'src/vendor/basis_universal/basis_transcoder.wasm', to: 'static/js/[name][ext]' },
    ],
  },
  // Enable async TypeScript type checking.
  plugins: [pluginTypeCheck()],
  tools: {
    rspack(_config) {
    },
    // Disable standards-compliant class field transforms.
    swc: {
      jsc: {
        transform: {
          useDefineForClassFields: false,
        },
      },
    },
  },
  // Disable fallback to index for 404 responses.
  server: {
    htmlFallback: false,
  },
  // Setup middleware to serve the `data` directory.
  dev: {
    setupMiddlewares: [
      (middlewares, _server) => {
        middlewares.unshift(saveGeneratedImage);
        middlewares.unshift(serveData);
        return middlewares;
      },
    ],
  },
});

// Handle POST requests to save generated images
const saveGeneratedImage: RequestHandler = async (req, res, next) => {
  if (req.method !== 'POST' || req.url !== '/api/save-image') {
    next();
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const { imageData } = JSON.parse(body);

      if (!imageData || !imageData.startsWith('data:image/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid image data' }));
        return;
      }

      // Extract base64 data
      const base64Data = imageData.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      // Create unique filename with timestamp
      const timestamp = Date.now();
      const filename = `generated-${timestamp}.png`;
      const filepath = join('data', 'generations', filename);

      // Ensure directory exists
      await mkdir(join('data', 'generations'), { recursive: true });

      // Save file
      writeFile(filepath, buffer, (err) => {
        if (err) {
          console.error('Error saving image:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save image' }));
          return;
        }

        // Return the path that can be used to load the image
        const imagePath = `/data/generations/${filename}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: imagePath }));
        console.log(`✓ Saved generated image: ${imagePath}`);
      });
    } catch (error) {
      console.error('Error processing save request:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to process request' }));
    }
  });
};

// Serve files from the `data` directory.
const serveData: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const matches = parseUrl(req)?.pathname?.match(/^\/data(\/.*)?$/);
  if (!matches) {
    next();
    return;
  }
  // The `send` package handles Range requests, conditional GET,
  // ETag generation, Cache-Control, Last-Modified, and more.
  const stream = send(req, matches[1] || '', {
    index: false,
    root: 'data',
  });
  stream.on(
    'directory',
    function handleDirectory(
      this: send.SendStream,
      res: ServerResponse,
      path: string,
    ) {
      // Print directory listing
      readdir(path, (err, list) => {
        if (err) return this.error(500, err);
        const filtered = list.filter((file) => !file.startsWith('.'));
        if (filtered.length === 0) return this.error(404);
        res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        res.end(`${filtered.join('\n')}\n`);
      });
    },
  );
  stream.pipe(res);
};
