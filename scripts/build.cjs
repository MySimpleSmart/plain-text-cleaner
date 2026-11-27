// Regenerate the static CSP hashes after editing an HTML page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'plain-text-cleaner.html'), 'utf8');
const landing = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const documentPath = path.join(root, 'document.html');
let documentPage = fs.readFileSync(documentPath, 'utf8');
const bundledScript = fs.readFileSync(path.join(root, 'assets/document-engine.js'));
const bundledStyles = fs.readFileSync(path.join(root, 'assets/document-engine.css'));
const hash = value => `'sha256-${crypto.createHash('sha256').update(value).digest('base64')}'`;
for (const [asset, expected] of [['document-engine.js', hash(bundledScript)]]) {
  const pattern = new RegExp(`((?:src|href)="/assets/${asset}" integrity=")[^"]+(" crossorigin="anonymous")`, 'u');
  if (!pattern.test(documentPage)) throw Error(`Missing integrity attribute for ${asset}`);
  documentPage = documentPage.replace(pattern, `$1${expected.slice(1, -1)}$2`);
}
const inlineBundleStyles = bundledStyles.toString('utf8').replaceAll('url("./fonts/', 'url("/assets/fonts/');
const stylePattern = /(<style id="document-engine-style">)[\s\S]*?(<\/style>)/u;
if (!stylePattern.test(documentPage)) throw Error('Missing inline Document engine stylesheet');
documentPage = documentPage.replace(stylePattern, (_, start, end) => start + inlineBundleStyles + end);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(documentPath, 'utf8') !== documentPage) throw Error('Document bundle integrity hashes are out of date: run node scripts/build.cjs');
} else fs.writeFileSync(documentPath, documentPage);
const style = html.match(/<style>([\s\S]*?)<\/style>/);
const landingStyle = landing.match(/<style>([\s\S]*?)<\/style>/);
const documentStyle = documentPage.match(/<style>([\s\S]*?)<\/style>/);
const app = html.match(/<script id="cleaner-app">([\s\S]*?)<\/script>/);
const documentApp = documentPage.match(/<script id="document-app">([\s\S]*?)<\/script>/);
if (!style || !landingStyle || !documentStyle || !app || !documentApp) throw Error('Expected inline stylesheets and app scripts');
const styleSources = `${hash(style[1])} ${hash(landingStyle[1])} ${hash(documentStyle[1])} ${hash(inlineBundleStyles)}`;
const policy = [
  "default-src 'none'",
  `script-src ${hash(app[1])} ${hash(documentApp[1])} ${hash(bundledScript)}`,
  "script-src-attr 'none'",
  `style-src ${styleSources}`,
  `style-src-elem ${styleSources}`,
  "style-src-attr 'none'",
  "img-src 'self'",
  "connect-src 'none'",
  "font-src 'self'",
  "media-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');
const config = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  redirects: [
    { source: '/plain-text-cleaner.html', destination: '/editor', permanent: true },
    { source: '/document.html', destination: '/document', permanent: true }
  ],
  rewrites: [
    { source: '/', destination: '/index.html' },
    { source: '/editor', destination: '/plain-text-cleaner.html' },
    { source: '/document', destination: '/document.html' }
  ],
  headers: [{
    source: '/(.*)',
    headers: [
      { key: 'Content-Security-Policy', value: policy },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
    ]
  }]
};
const output = JSON.stringify(config, null, 2) + '\n';
const target = path.join(root, 'vercel.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw Error('CSP hashes are out of date: run node scripts/build.cjs');
  process.stdout.write('CSP hashes are current\n');
} else {
  fs.writeFileSync(target, output);
  process.stdout.write('Built vercel.json with current CSP hashes\n');
}
