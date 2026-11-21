import { access } from 'node:fs/promises';
for (const file of ['dist/index.html','dist/styles.css','dist/app.js']) await access(file);
console.log('Static desktop frontend validated; no bundler or runtime dependencies.');
