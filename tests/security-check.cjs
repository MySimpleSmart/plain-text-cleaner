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
const editorAssets = new Map();
const addAssets = directory => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) addAssets(file);
    else editorAssets.set(`/${file}`, fs.readFileSync(path.join(root, file)));
  }
};
addAssets('assets');
let blockedRequests = 0;
const server = http.createServer((request, response) => {
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  if (request.url === '/blocked') blockedRequests++;
  if (request.url === '/plain-text-cleaner.html' || request.url === '/document.html') {
    response.writeHead(308, { Location: request.url === '/document.html' ? '/document' : '/editor' });
    response.end();
    return;
  }
  response.setHeader('Content-Type', /\.woff2$/u.test(request.url) ? 'font/woff2' : /\.woff$/u.test(request.url) ? 'font/woff' : /\.ttf$/u.test(request.url) ? 'font/ttf' : /\.css$/u.test(request.url) ? 'text/css' : /\.js$/u.test(request.url) ? 'text/javascript' : request.url === '/text-cleaner-logo.svg' ? 'image/svg+xml' : 'text/html; charset=utf-8');
  response.end(fonts.get(request.url) || katexAssets.get(request.url) || editorAssets.get(request.url) || (request.url === '/text-cleaner-logo.svg' ? logo : request.url === '/' || request.url === '/index.html' ? landing : request.url === '/editor' ? html : request.url === '/document' ? documentPage : ''));
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
  const publicEditorAssets = [...editorAssets.keys()].filter(pathname => !process.env.SITE_URL || pathname !== '/assets/document-engine.css');
  for (const pathname of ['/text-cleaner-logo.svg', ...fonts.keys(), ...katexAssets.keys(), ...publicEditorAssets]) {
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.cspViolations=[]; document.addEventListener('securitypolicyviolation', event => window.cspViolations.push({ directive: event.violatedDirective, sample: event.sample, target: event.target?.outerHTML?.slice(0, 200), blocked: event.blockedURI, source: event.sourceFile, line: event.lineNumber }));` }, sessionId);
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
        if (!privacy || getComputedStyle(privacy).backgroundColor !== 'rgb(242, 245, 244)' || !privacy.textContent.includes('browser by default') || !privacy.textContent.includes('text stays in your browser') || /AI organization/u.test(privacy.textContent)) throw Error('Privacy note is not visible');
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
        if (document.getElementById('organize') || document.getElementById('ai-organize') || document.getElementById('organize-panel')) throw Error('Organize tools remain in Clean Text');
        if (!editor || !choice || !choice.checked || editor.value || document.getElementById('save-status').textContent !== 'Saved in this browser only') throw Error('Draft saving default did not load');
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
        if (!document.getElementById('clear-editor-dialog').open || !editor.value) throw Error('Editor clear confirmation missing');
        document.getElementById('clear-editor-cancel').click();
        if (!editor.value) throw Error('Cancel cleared the editor');
        document.getElementById('clear-private').click();
        document.getElementById('clear-editor-confirm').click();
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
        clipboardData.setData('text/plain', '  Hello   world  \\n\\n# Variance summary\\n\\n| Variable | CV |\\n| --- | --- |\\n| x1 | 0.0742 |\\n| x2 | 0.0950 |');
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true }));
        if (!editor.value.includes('Hello world') || editor.value.includes('Hello   world') || !editor.value.includes('| Variable | CV |')) throw Error('Clean Text did not clean the paste: ' + JSON.stringify(editor.value));
        document.getElementById('document-link').click();
        return editor.value;
      })()`, returnByValue: true
    }, sessionId);
    if (transfer.exceptionDetails) throw Error(transfer.exceptionDetails.exception?.description || JSON.stringify(transfer.exceptionDetails));
    const transferredText = transfer.result.value;
    await documentLoaded;
    const blankDocument = await send('Runtime.evaluate', { expression: `(async () => {
      const source = document.getElementById('source');
      const content = document.querySelector('#content .ProseMirror');
      if (source.value || sessionStorage.getItem('plain-text-cleaner.document-transfer.v1') !== null) return false;
      content.focus();
      const inserted = document.execCommand('insertText', false, 'New document');
      await new Promise(resolve => setTimeout(resolve, 30));
      if (!inserted || source.value !== 'New document' || !content.textContent.includes('New document')) throw Error('Empty Document is not directly editable: ' + JSON.stringify({ inserted, source: source.value, content: content.textContent, ready: window.documentAppReady, editable: content.getAttribute('contenteditable'), violations: window.cspViolations }));
      document.getElementById('clear').click(); document.getElementById('clear-confirm').click();
      return !source.value && !content.textContent && sessionStorage.getItem('plain-text-cleaner.document-edits.v1') === null;
    })()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (blankDocument.exceptionDetails) throw Error(blankDocument.exceptionDetails.exception?.description || JSON.stringify(blankDocument.exceptionDetails));
    if (!blankDocument.result.value) throw Error('Header navigation converted Clean Text without permission');
    const editorReturnLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Runtime.evaluate', { expression: "document.getElementById('editor-link').click()", returnByValue: true }, sessionId);
    await editorReturnLoaded;
    const conversion = await send('Runtime.evaluate', { expression: `(() => {
      const editor = document.getElementById('text');
      if (editor.value !== ${JSON.stringify(transferredText)}) throw Error('Header navigation lost Clean Text');
      if (!document.querySelector('.toolbar #convert-document') || document.getElementById('convert-document').disabled) throw Error('Bottom Convert button missing or disabled for Clean Text');
      if (!document.getElementById('convert-selection').disabled) throw Error('Selection Convert enabled without a selection');
      if (document.getElementById('convert-preview')) throw Error('Convert modal still contains a preview');
      editor.focus(); editor.setSelectionRange(0, 5); editor.dispatchEvent(new Event('select'));
      if (document.getElementById('convert-document').disabled || document.getElementById('convert-selection').disabled) throw Error('Convert buttons are disabled for a valid selection');
      document.getElementById('convert-document').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.getElementById('convert-document').focus();
      if (document.getElementById('convert-document').disabled) throw Error('Bottom Convert disabled when focused after selecting text');
      document.getElementById('convert-document').click();
      if (!document.getElementById('convert-dialog').open || !document.getElementById('convert-description').textContent.includes('All Clean Text') || sessionStorage.getItem('plain-text-cleaner.document-transfer.v1') !== null) throw Error('Whole-document Convert confirmation missing');
      document.getElementById('convert-cancel').click();
      if (document.getElementById('convert-dialog').open || editor.value !== ${JSON.stringify(transferredText)}) throw Error('Cancel changed Clean Text');
      document.getElementById('convert-document').click();
      return true;
    })()`, returnByValue: true }, sessionId);
    if (conversion.exceptionDetails) throw Error(conversion.exceptionDetails.exception?.description || JSON.stringify(conversion.exceptionDetails));
    const convertedLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Runtime.evaluate', { expression: "document.getElementById('convert-confirm').click()", returnByValue: true }, sessionId);
    await convertedLoaded;
    if (process.env.DOCUMENT_SCREENSHOT) {
      await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      fs.writeFileSync(process.env.DOCUMENT_SCREENSHOT, Buffer.from(data, 'base64'));
    }
    if (process.env.SELECTION_SCREENSHOT) {
      await send('Runtime.evaluate', { expression: "editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run(); refreshTools()", returnByValue: true }, sessionId);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      fs.writeFileSync(process.env.SELECTION_SCREENSHOT, Buffer.from(data, 'base64'));
    }
    const documentResult = await send('Runtime.evaluate', {
      expression: `(async () => {
        if (location.pathname !== '/document' || !window.documentAppReady || !window.createDocumentEditor) throw Error('Document engine did not load');
        if (window.cspViolations.length) throw Error('Document violated CSP on load: ' + JSON.stringify(window.cspViolations));
        const source = document.getElementById('source');
        const content = document.getElementById('content');
        const sourceToggle = document.getElementById('source-toggle');
        if (source.value !== ${JSON.stringify(transferredText)} || content.querySelectorAll('table tr').length !== 3 || !content.textContent.includes('Hello world')) throw Error('Clean Text transfer or table parsing failed');
        if (!documentText().includes('Variable' + String.fromCharCode(9) + 'CV' + String.fromCharCode(10) + 'x1' + String.fromCharCode(9) + '0.0742')) throw Error('Plain text table copy lost row boundaries: ' + JSON.stringify(documentText()));
        if (!source.hidden || content.hidden || !content.querySelector('.ProseMirror')) throw Error('Document did not open as an editable page');
        editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
        await new Promise(resolve => setTimeout(resolve, 30)); refreshTools();
        if (document.getElementById('format-actions').hidden || !document.querySelector('#format-actions #list-bullet') || document.querySelector('.toolbar #format-bold, .toolbar #list-bullet')) throw Error('Selection toolbar did not contain all formatting actions');
        const selectedBox = getSelection().getRangeAt(0).getBoundingClientRect();
        const floatingBox = document.getElementById('format-actions').getBoundingClientRect();
        if (floatingBox.top < selectedBox.bottom || floatingBox.left < 0 || floatingBox.right > innerWidth) throw Error('Selection toolbar is not aligned below selected text');
        document.getElementById('format-bold').click();
        if (content.querySelector('strong')?.textContent !== 'Hello') throw Error('Bold command failed');
        document.getElementById('copy').focus(); refreshTools();
        if (!document.getElementById('format-actions').hidden) throw Error('Selection toolbar remained open after editor lost focus');
        sourceToggle.click();
        if (!content.hidden || source.hidden || source.value !== ${JSON.stringify(transferredText)}) throw Error('Original source did not open separately');
        sourceToggle.click();
        if (!content.querySelector('strong')) throw Error('Viewing source removed formatting');
        document.getElementById('regenerate').click();
        if (!document.getElementById('regenerate-dialog').open) throw Error('Regenerate did not warn about edits');
        document.getElementById('regenerate-cancel').click();
        if (!content.querySelector('strong')) throw Error('Cancel lost formatting');
        document.getElementById('regenerate').click(); document.getElementById('regenerate-confirm').click();
        if (content.querySelector('strong')) throw Error('Regenerate did not reset formatting');
        editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First item' }] }] });
        editor.commands.setTextSelection({ from: 1, to: 6 });
        await new Promise(resolve => setTimeout(resolve, 30)); refreshTools();
        if (document.getElementById('format-actions').hidden) throw Error('List tools were not shown for selected text');
        document.getElementById('list-bullet').click();
        if (editor.getJSON().content[0].type !== 'bulletList') throw Error('Bullet list tool failed');
        document.getElementById('list-ordered').click();
        if (editor.getJSON().content[0].type !== 'orderedList') throw Error('Numbered list tool failed');
        document.getElementById('list-task').click();
        if (editor.getJSON().content[0].type !== 'taskList' || !content.querySelector('input[type="checkbox"]')) throw Error('Checklist tool failed');
        content.querySelector('input[type="checkbox"]').click();
        if (editor.getJSON().content[0].content[0].attrs.checked !== true) throw Error('Checklist checkbox did not toggle');
        if (!exportHTML().includes('☑') || exportHTML().includes('<input')) throw Error('Checklist copy did not preserve its checked state as safe text');
        editor.commands.setTextSelection({ from: 3, to: 8 });
        document.getElementById('format-underline').click();
        if (!content.querySelector('u')) throw Error('Underline tool failed');
        const directPaste = new DataTransfer(); directPaste.setData('text/plain', 'Second item');
        content.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: directPaste, cancelable: true, bubbles: true }));
        if (!content.textContent.includes('Second item')) throw Error('Document paste failed');
        sourceToggle.click(); source.value = 'Name\\tValue\\nA\\t42\\n\\n1. First\\n2. Second\\n\\n\\\\[\\nPC2=\\\\sum_{i=1}^{7}b_i(x_i-\\\\bar{x}_i)\\n\\\\]';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 120));
        sourceToggle.click();
        if (content.querySelectorAll('table tr').length !== 2 || content.querySelectorAll('ol li').length !== 2 || !content.querySelector('.katex-html')) throw Error('Table, numbered list or formula parsing failed');
        sourceToggle.click(); source.value = 'Placeholder\\nPossible options\\n[Variable]\\nSales / Population\\n[unit]\\n% / kg\\nX, Y, Z\\nActual values';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 120)); sourceToggle.click();
        if (content.querySelectorAll('table tr').length !== 4) throw Error('Flattened table parsing failed');
        const malicious = new DataTransfer();
        malicious.setData('text/plain', 'X');
        malicious.setData('text/html', '<table onclick="window.evil=true"><tr><th>Safe</th><td><img src="/blocked?clipboard" onerror="window.evil=true">Cell</td></tr></table>');
        sourceToggle.click(); source.select(); source.dispatchEvent(new ClipboardEvent('paste', { clipboardData: malicious, cancelable: true })); sourceToggle.click();
        if (window.evil || content.querySelector('img,script') || content.querySelectorAll('table tr').length !== 1) throw Error('Rich paste sanitization failed');
        let safePos = -1;
        editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Safe') safePos = pos; });
        if (safePos < 0) throw Error('Table cell text position missing');
        editor.commands.insertContentAt({ from: safePos, to: safePos + 4 }, 'Clean');
        editor.commands.setTextSelection({ from: safePos, to: safePos + 5 });
        document.getElementById('format-italic').click();
        if (content.querySelector('th em')?.textContent !== 'Clean') throw Error('Direct table edit or italic formatting failed');
        let clipboardItems;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => { clipboardItems = items; } } });
        document.getElementById('copy').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        const copiedHTML = await (await clipboardItems[0].getType('text/html')).text();
        const copiedText = await (await clipboardItems[0].getType('text/plain')).text();
        if (!copiedHTML.includes('<table') || !copiedHTML.includes('<em>Clean</em>') || !copiedText.includes('Clean') || /onerror|onclick|blocked/.test(copiedHTML)) throw Error('Edited table was not copied safely');
        if (!sessionStorage.getItem('plain-text-cleaner.document-state.v2')) throw Error('Document state was not saved');
        if (document.documentElement.scrollWidth > innerWidth || window.cspViolations.some(item => item.directive !== 'script-src-attr') || window.cspViolations.filter(item => item.directive === 'script-src-attr').length !== 2) throw Error('Document overflow or unexpected CSP violation: ' + JSON.stringify(window.cspViolations));
        return { status: 'PASS', violations: window.cspViolations, documentText: source.value };
      })()`, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (documentResult.exceptionDetails) throw Error(documentResult.exceptionDetails.exception?.description || JSON.stringify(documentResult.exceptionDetails));
    const documentText = documentResult.result.value.documentText;
    const documentReloaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.reload', {}, sessionId);
    await documentReloaded;
    const restored = await send('Runtime.evaluate', { expression: `(() => {
      if (document.getElementById('source').value !== ${JSON.stringify(documentText)} || sessionStorage.getItem('plain-text-cleaner.document-transfer.v1') !== null) throw Error('Document was not restored on reload');
      if (document.querySelector('#content th em')?.textContent !== 'Clean') throw Error('Direct table edit and formatting were not restored on reload');
      document.getElementById('editor-link').click();
      if (!document.getElementById('return-dialog').open) throw Error('Return confirmation did not open');
      document.getElementById('return-cancel').click();
      if (document.getElementById('return-dialog').open || location.pathname !== '/document') throw Error('Return cancel lost the Document');
      document.getElementById('editor-link').click();
      return true;
    })()`, returnByValue: true }, sessionId);
    if (restored.exceptionDetails) throw Error(restored.exceptionDetails.exception?.description || JSON.stringify(restored.exceptionDetails));
    const backLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Runtime.evaluate', { expression: "document.getElementById('return-confirm').click()", returnByValue: true }, sessionId);
    await backLoaded;
    const existingLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    const headerSwitch = await send('Runtime.evaluate', { expression: `(() => {
      const editor = document.getElementById('text');
      if (editor.value !== ${JSON.stringify(transferredText)} || localStorage.getItem('plain-text-cleaner.save-drafts.v1') !== 'false') throw Error('Clean Text was lost when returning');
      editor.value = 'Replacement draft'; editor.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('document-link').click();
      return true;
    })()`, returnByValue: true }, sessionId);
    if (headerSwitch.exceptionDetails) throw Error(headerSwitch.exceptionDetails.exception?.description || JSON.stringify(headerSwitch.exceptionDetails));
    await existingLoaded;
    const existing = await send('Runtime.evaluate', { expression: `document.getElementById('source').value === ${JSON.stringify(documentText)} && document.querySelector('#content th em')?.textContent === 'Clean'`, returnByValue: true }, sessionId);
    if (!existing.result.value) throw Error('Header navigation replaced existing Document');
    const returnAgainLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Runtime.evaluate', { expression: "document.getElementById('editor-link').click(); document.getElementById('return-confirm').click()", returnByValue: true }, sessionId);
    await returnAgainLoaded;
    const replaceChoice = await send('Runtime.evaluate', { expression: `(() => {
      const editor = document.getElementById('text');
      if (editor.value !== 'Replacement draft') throw Error('Clean Text changed while opening existing Document');
      editor.focus(); editor.setSelectionRange(12, 17); editor.dispatchEvent(new Event('select'));
      document.getElementById('convert-selection').click();
      if (!document.getElementById('convert-dialog').open || !document.getElementById('convert-description').textContent.includes('replace')) throw Error('Replacement warning missing');
      if (document.getElementById('convert-preview') || document.getElementById('convert-title').textContent !== 'Convert selection?') throw Error('Selection modal still contains a preview or the wrong title');
      document.getElementById('convert-cancel').click();
      if (document.getElementById('convert-dialog').open || sessionStorage.getItem('plain-text-cleaner.document-transfer.v1') !== null) throw Error('Cancel triggered conversion');
      document.getElementById('convert-selection').click();
      return true;
    })()`, returnByValue: true }, sessionId);
    if (replaceChoice.exceptionDetails) throw Error(replaceChoice.exceptionDetails.exception?.description || JSON.stringify(replaceChoice.exceptionDetails));
    const replacedLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Runtime.evaluate', { expression: "document.getElementById('convert-confirm').click()", returnByValue: true }, sessionId);
    await replacedLoaded;
    const clearCheck = await send('Runtime.evaluate', { expression: `(() => {
      if (document.getElementById('source').value !== 'draft') throw Error('Confirmed selected text did not arrive');
      document.getElementById('clear').click();
      if (!document.getElementById('clear-dialog').open) throw Error('Clear confirmation missing');
      document.getElementById('clear-cancel').click();
      if (document.getElementById('source').value !== 'draft') throw Error('Clear cancel lost content');
      document.getElementById('clear').click(); document.getElementById('clear-confirm').click();
      if (document.getElementById('source').value || sessionStorage.getItem('plain-text-cleaner.document-session.v1') !== null) throw Error('Confirmed clear did not remove Document');
      return true;
    })()`, returnByValue: true }, sessionId);
    if (clearCheck.exceptionDetails) throw Error(clearCheck.exceptionDetails.exception?.description || JSON.stringify(clearCheck.exceptionDetails));
    const clearedReloaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.reload', {}, sessionId);
    await clearedReloaded;
    const cleared = await send('Runtime.evaluate', { expression: "document.getElementById('source').value === '' && sessionStorage.getItem('plain-text-cleaner.document-session.v1') === null", returnByValue: true }, sessionId);
    if (!cleared.result.value) throw Error('Cleared Document came back after reload');
    const legacySource = 'Hello world\n\nA\tB\nx\t1';
    await send('Runtime.evaluate', { expression: `(() => {
      window.removeEventListener('pagehide', saveDocument);
      sessionStorage.removeItem('plain-text-cleaner.document-state.v2');
      sessionStorage.removeItem('plain-text-cleaner.document-edits.v1');
      sessionStorage.setItem('plain-text-cleaner.document-session.v1', ${JSON.stringify(legacySource)});
      sessionStorage.setItem('plain-text-cleaner.document-formats.v1', JSON.stringify({ source: ${JSON.stringify(legacySource)}, formats: [{ start: 0, end: 5, tag: 'strong' }] }));
    })()`, returnByValue: true }, sessionId);
    const legacyLoaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    await send('Page.reload', {}, sessionId); await legacyLoaded;
    const legacy = await send('Runtime.evaluate', { expression: `(() => {
      if (document.querySelector('#content strong')?.textContent !== 'Hello' || document.querySelectorAll('#content table tr').length !== 2) throw Error('Legacy formatting migration lost text or table: ' + JSON.stringify({ html: document.querySelector('#content').innerHTML.slice(0, 500), source: document.getElementById('source').value, state: sessionStorage.getItem('plain-text-cleaner.document-state.v2')?.slice(0, 500) }));
      return true;
    })()`, returnByValue: true }, sessionId);
    if (legacy.exceptionDetails) throw Error(legacy.exceptionDetails.exception?.description || JSON.stringify(legacy.exceptionDetails));
    process.stdout.write(JSON.stringify(documentResult.result.value) + '\n');
    process.stdout.write(JSON.stringify(result.result.value) + '\n');
  } finally {
    const exited = new Promise(resolve => browser.once('close', resolve)); browser.kill(); await exited;
    if (server.listening) server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; if (server.listening) server.close(); });
