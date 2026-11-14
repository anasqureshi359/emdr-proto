// Bundles src/main.js with three.js and inlines it into src/template.html.
// Output: ../index.html (the page GitHub Pages serves).
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome110'],
  write: false,
  legalComments: 'eof',
});
let js = out.outputFiles[0].text;
js = js.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/template.html', 'utf8').replace('/*__BUNDLE__*/', () => js);
writeFileSync('../index.html', html);
console.log('../index.html', (html.length / 1024).toFixed(0) + ' KB');
