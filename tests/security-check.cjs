// Production-like CSP and privacy smoke test. Run after: node scripts/build.cjs
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
const html = fs.readFileSync(path.join(root, 'plain-text-cleaner.html'));
const landing = fs.readFileSync(path.join(root, 'index.html'));
const documentPage = fs.readFileSync(path.join(root, 'document.html'));
const logo = fs.readFileSync(path.join(root, 'text-cleaner-logo.svg'));
const fonts = new Map([
  ['/fonts/Ubuntu-Regular-latin.woff2', fs.readFileSync(path.join(root, 'fonts/Ubuntu-Regular-latin.woff2'))],
  ['/fonts/Ubuntu-Bold-latin.woff2', fs.readFileSync(path.join(root, 'fonts/Ubuntu-Bold-latin.woff2'))]
]);
const katexAssets = new Map();
for (const name of fs.readdirSync(path.join(root, 'vendor/katex/fonts'))) katexAssets.set(`/vendor/katex/fonts/${name}`, fs.readFileSync(path.join(root, 'vendor/katex/fonts', name)));
for (const name of ['katex.min.css', 'katex.min.js']) katexAssets.set(`/vendor/katex/${name}`, fs.readFileSync(path.join(root, 'vendor/katex', name)));
let blockedRequests = 0;
const server = http.createServer((request, response) => {
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  if (request.url === '/blocked') blockedRequests++;
  if (request.url === '/plain-text-cleaner.html' || request.url === '/document.html') {
    response.writeHead(308, { Location: request.url === '/document.html' ? '/document' : '/editor' });
    response.end();
    return;
  }
  response.setHeader('Content-Type', /\.woff2$/u.test(request.url) ? 'font/woff2' : /\.css$/u.test(request.url) ? 'text/css' : /\.js$/u.test(request.url) ? 'text/javascript' : request.url === '/text-cleaner-logo.svg' ? 'image/svg+xml' : 'text/html; charset=utf-8');
  response.end(fonts.get(request.url) || katexAssets.get(request.url) || (request.url === '/text-cleaner-logo.svg' ? logo : request.url === '/' || request.url === '/index.html' ? landing : request.url === '/editor' ? html : request.url === '/document' ? documentPage : ''));
});

async function verifyRoutes(base) {
  const request = (pathname, options = {}) => fetch(new URL(pathname, base), options);
  const old = await request('/plain-text-cleaner.html', { redirect: 'manual' });
  assert.equal(old.status, 308, 'Legacy URL must redirect permanently');
  assert.equal(new URL(old.headers.get('location'), base).pathname, '/editor');
  const editor = await request('/editor', { redirect: 'manual' });
  assert.equal(editor.status, 200, '/editor must load without another redirect');
  assert.equal(editor.headers.get('content-security-policy'), headers['Content-Security-Policy']);
  assert.match(await editor.text(), /id="cleaner-app"/);
  const followed = await request('/plain-text-cleaner.html');
  assert.equal(followed.status, 200, 'Legacy redirect must resolve without a loop');
  assert.equal(followed.url, new URL('/editor', base).href);
  const documentRoute = await request('/document', { redirect: 'manual' });
  assert.equal(documentRoute.status, 200, '/document must load without another redirect');
  assert.match(await documentRoute.text(), /id="document-app"/);
  const documentRedirect = await request('/document.html', { redirect: 'manual' });
  assert.equal(documentRedirect.status, 308);
  assert.equal(new URL(documentRedirect.headers.get('location'), base).pathname, '/document');
  for (const pathname of ['/text-cleaner-logo.svg', ...fonts.keys(), ...katexAssets.keys()]) {
    const asset = await request(pathname, { redirect: 'manual' });
    assert.equal(asset.status, 200, `Asset failed: ${pathname}`);
    assert.ok((await asset.arrayBuffer()).byteLength > 0, `Asset is empty: ${pathname}`);
  }
}

async function main() {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = siteUrl || `http://127.0.0.1:${server.address().port}/`;
  await verifyRoutes(base);
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
    await send('Page.navigate', { url: base }, sessionId);
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
        if (!button || button.textContent.trim() !== 'CLEAN TEXT' || new URL(button.href).pathname !== '/editor' || new URL(document.getElementById('open-document')?.href).pathname !== '/document') throw Error('Landing CTAs are missing');
        if (document.querySelector('h1')?.textContent !== 'Text, without the mess.') throw Error('Landing introduction is missing');
        if (!logo || Math.abs(logo.getBoundingClientRect().left + logo.getBoundingClientRect().width / 2 - document.documentElement.clientWidth / 2) > 1) throw Error('Landing logo is not centered');
        if (!getComputedStyle(document.documentElement).fontFamily.includes('Ubuntu') || Array.from(document.fonts).filter(face => face.family === 'Ubuntu' && face.status === 'loaded').length < 2) throw Error('Ubuntu font was not loaded locally');
        if (!privacy || getComputedStyle(privacy).backgroundColor !== 'rgb(242, 245, 244)' || !privacy.textContent.includes('browser by default') || !privacy.textContent.includes('sends selected text only after you confirm')) throw Error('Privacy note is not visible');
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
        if (location.pathname !== '/editor') throw Error('Editor did not keep its clean URL');
        const logoLink = document.querySelector('a.brand-logo');
        const editorLogo = logoLink?.querySelector('img');
        if (!logoLink || new URL(logoLink.href).pathname !== '/' || !editorLogo?.complete || !editorLogo.naturalWidth) throw Error('Editor home link or logo failed to load');
        const editor = document.getElementById('text');
        const choice = document.getElementById('save-drafts');
        if (!editor || !choice || !choice.checked || editor.value || document.getElementById('save-status').textContent !== 'Saved in this browser only') throw Error('Draft saving default did not load');
        const beforeOrganize = 'The firm works in metropolitanSydney,partnering with others.';
        editor.value = beforeOrganize; editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        document.getElementById('organize').click();
        const review = document.getElementById('organize-panel');
        if (review.hidden || document.getElementById('organize-before').textContent !== beforeOrganize || !document.getElementById('organize-after').textContent.includes('metropolitan Sydney, partnering')) throw Error('Live organize preview failed');
        document.getElementById('organize-apply').click();
        if (review.hidden !== true || !editor.value.includes('metropolitan Sydney, partnering')) throw Error('Live organize apply failed');
        document.getElementById('undo').click();
        if (editor.value !== beforeOrganize) throw Error('Live organize undo failed');
        editor.value = 'Private draft'; editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 350));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== 'Private draft') throw Error('Default draft was not saved');
        choice.checked = false; choice.dispatchEvent(new Event('change'));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== null || localStorage.getItem('plain-text-cleaner.save-drafts.v1') !== 'false') throw Error('Opt out retained draft or setting');
        editor.value = 'Unsaved'; editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 350));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== null) throw Error('Draft saved after opt out');
        choice.checked = true; choice.dispatchEvent(new Event('change'));
        if (localStorage.getItem('plain-text-cleaner.document.v1') !== 'Unsaved') throw Error('Re-enabling draft saving failed');
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
        if (editor.value || localStorage.getItem('plain-text-cleaner.document.v1') !== null || localStorage.getItem('plain-text-cleaner.save-drafts.v1') !== 'false') throw Error('Privacy clear failed');
        await new Promise(resolve => setTimeout(resolve, 50));
        if (window.cspViolations.some(item => item.directive === 'style-src-attr')) throw Error('Printed tables used blocked inline styles: ' + JSON.stringify(window.cspViolations));
        const script = document.createElement('script'); script.textContent = 'window.injected=true'; document.body.append(script);
        try { await fetch('https://example.invalid/blocked'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
        if (window.injected || !window.cspViolations.some(item => item.directive === 'script-src-elem') || !window.cspViolations.some(item => item.directive === 'connect-src')) throw Error('CSP did not block injected script or network request');
        return { status: 'PASS', violations: window.cspViolations };
      })()`, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
    if (blockedRequests) throw Error('CSP allowed a network request');
    const reloaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.reload', {}, sessionId);
    await reloaded;
    const persisted = await send('Runtime.evaluate', {
      expression: `(() => {
        const choice = document.getElementById('save-drafts');
        const editor = document.getElementById('text');
        if (choice.checked || editor.value || localStorage.getItem('plain-text-cleaner.save-drafts.v1') !== 'false') throw Error('Draft opt out did not persist after reload');
        return true;
      })()`, returnByValue: true
    }, sessionId);
    if (persisted.exceptionDetails) throw Error(persisted.exceptionDetails.exception?.description || JSON.stringify(persisted.exceptionDetails));
    const homeLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Runtime.evaluate', { expression: "document.querySelector('a.brand-logo').click()", returnByValue: true }, sessionId);
    await homeLoaded;
    const home = await send('Runtime.evaluate', { expression: "location.pathname === '/' && Boolean(document.getElementById('open-editor'))", returnByValue: true }, sessionId);
    if (!home.result.value) throw Error('Clicking the editor logo did not return home');
    const editorAgainLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.navigate', { url: new URL('/editor', base).href }, sessionId);
    await editorAgainLoaded;
    const documentLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    const transfer = await send('Runtime.evaluate', {
      expression: `(() => {
        const editor = document.getElementById('text');
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', '  Hello   world  ');
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true }));
        const tableData = new DataTransfer();
        tableData.setData('text/plain', 'Name\\tValue\\nA\\t42');
        tableData.setData('text/html', '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>42</td></tr></table>');
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: tableData, cancelable: true }));
        if (!editor.value.includes('Hello world') || editor.value.includes('Hello   world') || !editor.value.includes('Name\\tValue')) throw Error('Clean Text did not clean the paste: ' + JSON.stringify(editor.value));
        document.getElementById('document-link').click();
        return editor.value;
      })()`, returnByValue: true
    }, sessionId);
    if (transfer.exceptionDetails) throw Error(transfer.exceptionDetails.exception?.description || JSON.stringify(transfer.exceptionDetails));
    const transferredText = transfer.result.value;
    await documentLoaded;
    const documentResult = await send('Runtime.evaluate', {
      expression: `(async () => {
        if (location.pathname !== '/document' || !window.katex) throw Error('Document page or renderer failed');
        if (window.cspViolations.length) throw Error('Document violated CSP on load: ' + JSON.stringify(window.cspViolations));
        const source = document.getElementById('source');
        const content = document.getElementById('content');
        const sourceToggle = document.getElementById('source-toggle');
        if (source.value !== ${JSON.stringify(transferredText)} || document.querySelectorAll('#content table tr').length !== 2 || sessionStorage.getItem('plain-text-cleaner.document-transfer.v1') !== null) throw Error('Clean Text to Document transfer failed');
        if (!source.hidden || content.hidden || document.querySelector('.source-pane') || getComputedStyle(document.querySelector('.toolbar')).position !== 'fixed') throw Error('Document should open as one page without source beside it');
        const directPaste = new DataTransfer(); directPaste.setData('text/plain', 'Added paragraph');
        content.focus(); content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: directPaste, cancelable: true, bubbles: true }));
        if (!source.value.endsWith('Added paragraph') || !content.textContent.includes('Added paragraph')) throw Error('Pasting into document view failed: ' + JSON.stringify({ source: source.value, content: content.textContent }));
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['Pasted by button'], { type: 'text/plain' }) }] } });
        document.getElementById('paste').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        if (!source.value.endsWith('Pasted by button') || !content.textContent.includes('Pasted by button')) throw Error('Document Paste button failed');
        sourceToggle.click();
        if (source.hidden || !content.hidden || sourceToggle.getAttribute('aria-pressed') !== 'true') throw Error('Source mode did not open separately');
        source.value += '\\nSource edit'; source.dispatchEvent(new Event('input', { bubbles: true }));
        sourceToggle.click();
        if (!source.hidden || content.hidden || !content.textContent.includes('Source edit')) throw Error('Document mode did not return after editing source');
        source.value = 'Name\\tValue\\nA\\t42\\n\\n1. First\\n2. Second\\n\\n\\\\[\\nPC2=\\\\sum_{i=1}^{7}b_i(x_i-\\\\bar{x}_i)\\n\\\\]';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (document.querySelectorAll('#content table tr').length !== 2 || document.querySelectorAll('#content ol li').length !== 2 || !document.querySelector('#content .katex-display')) throw Error('Document structure failed');
        const formula = document.querySelector('#content .formula');
        if (formula.classList.contains('formula-error') || !formula.querySelector('math')) throw Error('LaTeX failed to render');
        source.value = '\\\\[\\nX=\\\\frac{0.3541}{0.0458}\\\\approx\\\\boxed{7.73}\\n\\\\]';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!document.querySelector('#content .katex-html') || window.cspViolations.length) throw Error('Fraction rendering or CSP failed: ' + JSON.stringify(window.cspViolations));
        source.value = 'Placeholder\\nPossible options\\n[Variable]\\nSales / Population\\n[unit]\\n% / kg\\nX, Y, Z\\nActual values';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (document.querySelectorAll('#content table tr').length !== 4) throw Error('Flattened two-column table was not recognized');
        source.value = 'Category\\n\\nPercentage (%)\\n\\n[Highest category]\\n\\nX\\n\\n[Second category]\\n\\nY\\n\\n[Lowest category]\\n\\nZ';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (document.querySelectorAll('#content table tr').length !== 4) throw Error('Blank-separated table was not recognized');
        source.value = '1. One\\n  • Nested\\n2. Two\\n• Separate bullet';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (document.querySelectorAll('#content > ol > li').length !== 2 || document.querySelectorAll('#content > ol ul li').length !== 1 || document.querySelectorAll('#content > ul > li').length !== 1) throw Error('Mixed nested lists failed');
        let clipboardItems;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => { clipboardItems = items; } } });
        document.getElementById('copy').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        if (!clipboardItems?.[0]?.types.includes('text/html') || !(await (await clipboardItems[0].getType('text/html')).text()).includes('<ol')) throw Error('Structured HTML clipboard copy failed');
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'X');
        transfer.setData('text/html', '<table onclick="window.evil=true"><tr><th>Safe</th><td><img src="/blocked?clipboard" onerror="window.evil=true">Cell<script>window.evil=true;<\\/script></td></tr></table>');
        sourceToggle.click(); source.select(); source.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true })); sourceToggle.click();
        if (window.evil || /onclick|onerror|script/i.test(document.getElementById('content').innerHTML) || !document.querySelector('#content table')) throw Error('Rich paste sanitization failed');
        const copied = document.getElementById('content').innerHTML;
        if (!copied.includes('<table>') || !copied.includes('<th>')) throw Error('Table not copyable as HTML');
        if (document.documentElement.scrollWidth > innerWidth) throw Error('Document page overflows on mobile');
        if (window.cspViolations.length) throw Error('Document violated CSP: ' + JSON.stringify(window.cspViolations));
        return { status: 'PASS', violations: window.cspViolations };
      })()`, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (documentResult.exceptionDetails) throw Error(documentResult.exceptionDetails.exception?.description || JSON.stringify(documentResult.exceptionDetails));
    if (process.env.DOCUMENT_SCREENSHOT) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      fs.writeFileSync(process.env.DOCUMENT_SCREENSHOT, Buffer.from(data, 'base64'));
    }
    const documentReloaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.reload', {}, sessionId);
    await documentReloaded;
    const oneShot = await send('Runtime.evaluate', { expression: "document.getElementById('source').value === '' && sessionStorage.getItem('plain-text-cleaner.document-transfer.v1') === null", returnByValue: true }, sessionId);
    if (!oneShot.result.value) throw Error('Transferred text persisted after Document reload');
    process.stdout.write(JSON.stringify(documentResult.result.value) + '\n');
    process.stdout.write(JSON.stringify(result.result.value) + '\n');
  } finally {
    const exited = new Promise(resolve => browser.once('close', resolve)); browser.kill(); await exited;
    if (server.listening) server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; if (server.listening) server.close(); });
