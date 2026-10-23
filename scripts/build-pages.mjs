// Production build for GitHub Pages: base path /<repository-name>/ into dist-pages/.
// Cross-platform (no shell env syntax). Usage:
//   npm run build:pages                     -> BASE_PATH from env, else /OpenConverter/
//   BASE_PATH=/MyFork/ npm run build:pages
import { build } from 'vite';

process.env.BASE_PATH ??= '/OpenConverter/';
process.env.OUT_DIR ??= 'dist-pages';
console.log(`Building for GitHub Pages: base ${process.env.BASE_PATH} -> ${process.env.OUT_DIR}/`);
await build();
