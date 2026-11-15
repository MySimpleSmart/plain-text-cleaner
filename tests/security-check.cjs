// Production-like CSP and privacy smoke test. Run after: node scripts/build.cjs
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
const html = fs.readFileSync(path.join(root, 'plain-text-cleaner.html'));
const landing = fs.readFileSync(path.join(root, 'index.html'));
const logo = fs.readFileSync(path.join(root, 'text-cleaner-logo.svg'));
const fonts = new Map([
  ['/fonts/Ubuntu-Regular-latin.woff2', fs.readFileSync(path.join(root, 'fonts/Ubuntu-Regular-latin.woff2'))],
  ['/fonts/Ubuntu-Bold-latin.woff2', fs.readFileSync(path.join(root, 'fonts/Ubuntu-Bold-latin.woff2'))]
]);
let blockedRequests = 0;
const server = http.createServer((request, response) => {
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  if (request.url === '/blocked') blockedRequests++;
  response.setHeader('Content-Type', fonts.has(request.url) ? 'font/woff2' : request.url === '/text-cleaner-logo.svg' ? 'image/svg+xml' : 'text/html; charset=utf-8');
  response.end(fonts.get(request.url) || (request.url === '/text-cleaner-logo.svg' ? logo : request.url === '/' || request.url === '/index.html' ? landing : html));
});

async function main() {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'text-cleaner-security-'));
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${temporary}`], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let nextId = 0, buffer = '', stderr = '';
  const pending = new Map(), events = new Map();
  browser.stderr.on('data', chunk => { stderr += chunk; });
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
        if (message.error) reject(Error(message.error.message)); else resolve(message.result);
      } else if (events.has(message.method)) { events.get(message.method)(message.params); events.delete(message.method); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.cspViolations=[]; document.addEventListener('securitypolicyviolation', event => window.cspViolations.push({ directive: event.violatedDirective, sample: event.sample, target: event.target?.outerHTML?.slice(0, 200) }));` }, sessionId);
    const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.navigate', { url: siteUrl || `http://127.0.0.1:${server.address().port}/` }, sessionId);
    await loaded;
    if (process.env.LANDING_SCREENSHOT) {
      await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);
      const metrics = await send('Page.getLayoutMetrics', {}, sessionId);
      const { width, height } = metrics.cssContentSize;
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
      fs.writeFileSync(process.env.LANDING_SCREENSHOT, Buffer.from(data, 'base64'));
    }
    const editorLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    const landingResult = await send('Runtime.evaluate', {
      expression: `(async () => {
        await document.fonts.ready;
        const button = document.getElementById('open-editor');
        const logo = document.querySelector('.brand img');
        const privacy = document.querySelector('.privacy');
        const credit = document.querySelector('.credit a');
        if (!button || button.textContent.trim() !== 'OPEN EDITOR' || !button.href.endsWith('/plain-text-cleaner.html')) throw Error('Landing CTA is missing');
        if (document.querySelector('h1')?.textContent !== 'Text, without the mess.') throw Error('Landing introduction is missing');
        if (!logo || Math.abs(logo.getBoundingClientRect().left + logo.getBoundingClientRect().width / 2 - document.documentElement.clientWidth / 2) > 1) throw Error('Landing logo is not centered');
        if (!getComputedStyle(document.documentElement).fontFamily.includes('Ubuntu') || Array.from(document.fonts).filter(face => face.family === 'Ubuntu' && face.status === 'loaded').length < 2) throw Error('Ubuntu font was not loaded locally');
        if (!privacy || getComputedStyle(privacy).backgroundColor !== 'rgb(242, 245, 244)' || !privacy.textContent.includes('Draft saving is off by default')) throw Error('Privacy note is not visible');
        if (!credit || credit.href !== 'https://simplesmart.com.au/' || !credit.rel.includes('noopener') || !credit.rel.includes('noreferrer')) throw Error('Developer link is missing');
        if (getComputedStyle(button).backgroundColor !== 'rgb(11, 32, 39)') throw Error('Landing stylesheet was blocked');
        if (document.documentElement.scrollWidth > window.innerWidth) throw Error('Landing overflows on mobile');
        if (window.cspViolations.length) throw Error('Landing violated CSP: ' + JSON.stringify(window.cspViolations));
        button.click();
        return true;
      })()`, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (landingResult.exceptionDetails) throw Error(landingResult.exceptionDetails.exception?.description || JSON.stringify(landingResult.exceptionDetails));
    await editorLoaded;
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {
        const editor = document.getElementById('text');
        const choice = document.getElementById('save-drafts');
        if (!editor || !choice || choice.checked || editor.value || document.getElementById('save-status').textContent !== 'Not saved in this browser') throw Error('Private default did not load');
        editor.value = 'Private draft'; editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 350));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== null) throw Error('Draft saved without opt in');
        choice.checked = true; choice.dispatchEvent(new Event('change'));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== 'Private draft') throw Error('Opt in did not save');
        choice.checked = false; choice.dispatchEvent(new Event('change'));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== null) throw Error('Opt out retained draft');
        await new Promise(resolve => setTimeout(resolve, 50));
        if (window.cspViolations.length) throw Error('Normal operation violated CSP: ' + JSON.stringify(window.cspViolations));
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'A\\tB');
        clipboardData.setData('text/html', '<table onclick="window.evil=true"><tr><td>A</td><td><img src="/blocked?clipboard" onerror="window.evil=true">B<script>window.evil=true;<\\/script></td></tr></table>');
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true }));
        const payload = clipboardPayload();
        if (window.evil || !payload.html || /onerror|onclick|script|blocked/i.test(payload.html)) throw Error('Unsafe HTML escaped into output');
        preparePrint();
        document.getElementById('clear-private').click();
        if (editor.value || localStorage.getItem('plain-text-cleaner.document.v1') !== null) throw Error('Privacy clear failed');
        await new Promise(resolve => setTimeout(resolve, 50));
        if (window.cspViolations.some(item => item.directive === 'style-src-attr')) throw Error('Printed tables used blocked inline styles: ' + JSON.stringify(window.cspViolations));
        const script = document.createElement('script'); script.textContent = 'window.injected=true'; document.body.append(script);
        try { await fetch('/blocked'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
        if (window.injected || !window.cspViolations.some(item => item.directive === 'script-src-elem') || !window.cspViolations.some(item => item.directive === 'connect-src')) throw Error('CSP did not block injected script or network request');
        return { status: 'PASS', violations: window.cspViolations };
      })()`, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
    if (blockedRequests) throw Error('CSP allowed a network request');
    process.stdout.write(JSON.stringify(result.result.value) + '\n');
  } finally {
    const exited = new Promise(resolve => browser.once('close', resolve)); browser.kill(); await exited;
    if (server.listening) server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; if (server.listening) server.close(); });
