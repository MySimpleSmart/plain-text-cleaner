// Regenerate the static CSP hashes after editing either HTML page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'plain-text-cleaner.html'), 'utf8');
const landing = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/);
const landingStyle = landing.match(/<style>([\s\S]*?)<\/style>/);
const app = html.match(/<script id="cleaner-app">([\s\S]*?)<\/script>/);
if (!style || !landingStyle || !app) throw Error('Expected inline stylesheets and the app script');
const hash = text => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
const policy = [
  "default-src 'none'",
  `script-src ${hash(app[1])}`,
  "script-src-attr 'none'",
  `style-src ${hash(style[1])} ${hash(landingStyle[1])}`,
  "style-src-attr 'none'",
  "img-src 'self'",
  "connect-src 'none'",
  "font-src 'none'",
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
  rewrites: [{ source: '/', destination: '/index.html' }],
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
