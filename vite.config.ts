import { defineConfig } from 'vite';
import { gitApi } from './server/gitApi';

export default defineConfig({
  plugins: [gitApi()],
  server: { open: true },
});
