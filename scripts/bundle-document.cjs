const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/document-engine.js')],
  outfile: path.join(__dirname, '../assets/document-engine.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'warning'
});

// Modern browsers use WOFF2. Remove redundant font fallbacks from the static bundle.
const assets = path.join(__dirname, '../assets');
const cssPath = path.join(assets, 'document-engine.css');
const css = fs.readFileSync(cssPath, 'utf8').replace(/,url\("[^"]+\.(?:woff|ttf)"\) format\("(?:woff|truetype)"\)/gu, '');
fs.writeFileSync(cssPath, css);
for (const name of fs.readdirSync(path.join(assets, 'fonts'))) {
  if (!name.endsWith('.woff2')) fs.rmSync(path.join(assets, 'fonts', name));
}
