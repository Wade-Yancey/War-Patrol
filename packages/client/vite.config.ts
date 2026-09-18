import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // Long-lived SSE: do not time out or buffer event streams.
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('X-Accel-Buffering', 'no');
              // Disable Node response buffering for progressive SSE chunks.
              (res as { flushHeaders?: () => void }).flushHeaders?.();
            }
          });
        },
      },
    },
  },
});
