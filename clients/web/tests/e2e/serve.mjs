import { createServer } from 'vite';

// No real backend, provider or demo configuration is used by this suite.
process.env.VITE_DEMO_MODE = 'false';
process.env.SHINEMA_DEMO_DELAY_MS = '0';
process.env.SHINEMA_API_ORIGIN = 'http://127.0.0.1:1';
const server = await createServer({
  configFile: 'vite.config.ts',
  server: {
    host: '127.0.0.1',
    port: 4187,
    strictPort: true,
    hmr: { overlay: false },
  },
  plugins: [
    {
      name: 'synthetic-api-only',
      configureServer(server) {
        // Registered before Vite's proxy middleware, so no API can reach a backend.
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/api/')) {
            response.statusCode = 503;
            response.end('Synthetic test API route missing');
          } else next();
        });
      },
    },
  ],
});
await server.listen();
