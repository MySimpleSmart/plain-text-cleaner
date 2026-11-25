// Run with: node tests/browser-check.cjs (set CHROME for a different Chrome path).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'text-cleaner-tests-'));
const source = fs.readFileSync(path.join(__dirname, '..', 'plain-text-cleaner.html'), 'utf8');
const checks = async function () {
  const results = [];
  const equal = (actual, expected, detail) => { if (actual !== expected) throw Error(JSON.stringify({ actual, expected, detail })); };
  const test = async (name, fn) => {
    document.body.dataset.currentTest = name;
    try { await fn(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };
  const type = text => {
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }));
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
  };
  const paste = text => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true }));
  };
  await test('restore local draft', () => equal(input.value, 'Saved draft 🇲🇳'));
  await test('Unicode word and grapheme counts', () => {
    type('Сайн байна уу 😀 👨‍👩‍👧‍👦 🇲🇳 e\u0301');
    equal(status.textContent, '4 words · 21 characters');
  });
  await test('empty paste preserves selection', () => {
    input.setSelectionRange(0, 4);
    const original = input.value;
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), cancelable: true }));
    equal(input.value, original); equal(input.selectionStart, 0); equal(input.selectionEnd, 4);
  });
  await test('plain paste replaces selection and is undoable', () => {
    const before = input.value;
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'Hello');
    clipboardData.setData('text/html', '<b>Hello</b>');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true }));
    equal(input.value, 'Hello' + before.slice(4));
    byId('undo').click(); equal(input.value, before); equal(input.selectionEnd, 4);
    byId('redo').click(); equal(input.value, 'Hello' + before.slice(4));
  });
  await test('spaces cleanup retains line breaks', () => equal(cleanText('  a   b\t\tc  \n\t d ', { spaces: true }), 'a b c\nd'));
  await test('Unicode horizontal spaces collapse without changing line breaks or joiners', () => {
    for (const space of ['\t', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u202f', '\u205f', '\u3000']) {
      equal(cleanText(`${space}a${space}${space}b${space}\nc`, { spaces: true }), 'a b\nc');
      equal(cleanText(`a${space}b`, { spaces: false }), `a${space}b`);
      equal(cleanText(`a\n${space}\nb`, { 'blank-lines': true }), 'a\nb');
    }
    equal(cleanText('👨‍👩‍👧‍👦 می\u200cروم', { spaces: true }), '👨‍👩‍👧‍👦 می\u200cروم');
  });
  await test('pasting tab-separated research examples collapses single tabs to spaces', () => {
    const source = '[research action]\tidentify trends in / investigate / examine / compare / assess\n[main topic]\ttrauma admissions / health outcomes / population changes / consumer behaviour\n[research purpose]\timprove prevention strategies / guide resource allocation / understand patterns / support decision-making';
    equal(cleanText(source, { spaces: false }), source);
    type('');
    paste(source);
    equal(input.value, source.replace(/\t/g, ' '));
    equal(input.value.split('\n').length, 3);
    byId('undo').click(); equal(input.value, '');
    byId('redo').click(); equal(input.value, source.replace(/\t/g, ' '));
  });
  await test('blank lines are removed while normal line breaks remain', () => {
    equal(cleanText('a\n \n\t\n\n b', { 'blank-lines': true }), 'a\n b');
    equal(cleanText('a\r\n\r\nb\r\nc', { 'blank-lines': true }), 'a\nb\nc');
    equal(cleanText('a\n\nb', { 'blank-lines': false }), 'a\n\nb');
  });
  await test('sentence templates paste without empty lines between headings and sentences', () => {
    const lines = [
      '**A. Highest & Lowest**',
      '[Category A] accounted for the highest proportion (X%), followed by [Category B] (Y%). In contrast, [Category C] had the lowest proportion (Z%).',
      '**B. Increasing Trend**',
      '[Variable] increased from X [unit] in [Year 1] to Y [unit] in [Year 2].',
      '**C. Decreasing Trend**',
      '[Variable] decreased from X [unit] in [Year 1] to Y [unit] in [Year 2].',
      '**D. Comparing Groups**',
      '[Group A] had a higher [proportion/mean/value] than [Group B], at X and Y, respectively.',
      '**E. Similar Values**',
      '[Category A] and [Category B] had similar [proportions/values], at X and Y, respectively.'
    ];
    type(''); paste(lines.join('\n\n'));
    equal(input.value, lines.join('\n').replace(/\*\*/g, ''));
    byId('undo').click(); equal(input.value, '');
    byId('redo').click(); equal(input.value.split('\n').length, 10);
  });
  await test('invisible cleanup preserves joiners and emoji', () => equal(cleanText('a\u00a0b\u200bc\ufeff\u00ad\u2060 👨‍👩‍👧‍👦 می\u200cروم', { invisible: true }), 'a bc 👨‍👩‍👧‍👦 می\u200cروم'));
  await test('Markdown headings emphasis links images lists', () => {
    equal(stripMarkdown('# Title\n**bold** and *italic* and ~~gone~~\n- [x] Done\n[Link](https://example.com/a_(b))\n![Alt](image.png)'), 'Title\nbold and italic and gone\nDone\nLink\nAlt');
  });
  await test('Markdown preserves code and escaped symbols', () => {
    equal(stripMarkdown('```js\nconst a = "**keep**";\n```\n`a_b` and \\*literal\\*\nsnake_case and 2 * 3'), 'const a = "**keep**";\na_b and *literal*\nsnake_case and 2 * 3');
  });
  await test('Markdown references, quotes, setext and rules', () => {
    equal(stripMarkdown('Title\n=====\n> Quote\n[text][ref]\n\n[ref]: https://example.com\n***'), 'Title\nQuote\ntext\n\n\n');
    equal(stripMarkdown('- - -'), '');
    equal(stripMarkdown('*a* **b** _c_ __d__'), 'a b c d');
  });
  const pcSource = String.raw`[
\boxed{
\begin{aligned}
PC1={}&a_1(x_1-98.836)+a_2(x_2-106.622)\
&+a_3(x_3-102.810)+a_4(x_4-11.220)\
&+a_5(x_5-14.180)+a_6(x_6-10.560)\
&+a_7(x_7-29.760)
\end{aligned}
}
]`;
  const pcText = 'PC1 = a₁(x₁ − 98.836) + a₂(x₂ − 106.622)\n+ a₃(x₃ − 102.810) + a₄(x₄ − 11.220)\n+ a₅(x₅ − 14.180) + a₆(x₆ − 10.560)\n+ a₇(x₇ − 29.760)';
  await test('PC1 LaTeX cleans to the agreed four-line text without changing any values', () => {
    type(''); paste(pcSource); equal(input.value, pcText);
    equal(input.hidden, false); equal(document.querySelectorAll('textarea').length, 1);
    equal(input.value.match(/\d+\.\d+/g).join(','), pcSource.match(/\d+\.\d+/g).join(','));
    byId('undo').click(); equal(input.value, '');
    byId('redo').click(); equal(input.value, pcText);
    const settings = { latex: true, markdown: true, spaces: true, 'blank-lines': true, invisible: true };
    equal(cleanText(pcText, settings), pcText);
    equal(cleanText('+ First item\n+ Second item', settings), 'First item\nSecond item');
  });
  await test('LaTeX text cleanup handles normal delimiters, row breaks and numeric scripts', () => {
    const settings = { latex: true, markdown: true, spaces: true };
    equal(cleanText('\\[\n' + pcSource.slice(2, -2).replace(/\\\n/g, '\\\\\n') + '\n\\]', settings), pcText);
    equal(cleanText(String.raw`Before \(x_{12}^{2}+y_3\) after`, settings), 'Before x₁₂² + y₃ after');
    equal(cleanText(String.raw`\[74.23408475E^{-3}\]`, settings), '74.23408475E⁻³');
    equal(cleanText(String.raw`\[x_1=1.2E-3\]`, settings), 'x₁ = 1.2E-3');
    equal(cleanText(String.raw`\[x_1-(a_2+a_3)\]`, settings), 'x₁ − (a₂ + a₃)');
  });
  await test('cleaned PC1 copies and prints as ordinary text', async () => {
    type(''); paste(pcSource);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard'); let copied;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { copied = value; } } });
      byId('copy').click(); await Promise.resolve(); equal(copied, pcText);
      equal(clipboardPayload().html, null);
      preparePrint(); equal(byId('print-document').textContent, pcText);
      equal(byId('print-document').querySelector('img'), null);
      window.dispatchEvent(new Event('afterprint'));
    } finally { if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else delete navigator.clipboard; }
  });
  await test('mean-bar example cleans and copies as text while preserving the bar and subscript', async () => {
    const source = String.raw`\[
x_1-\bar{x}_1=105-98.836=\boxed{6.164}
\]`;
    const expected = 'x₁ − x\u0304₁ = 105 − 98.836 = 6.164';
    type(''); paste(source); equal(input.value, expected);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard'); let copied;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { copied = value; } } });
      byId('copy').click(); await Promise.resolve(); equal(copied, expected);
      equal(clipboardPayload().html, null);
    } finally { if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else delete navigator.clipboard; }
    byId('undo').click(); equal(input.value, '');
    byId('redo').click(); equal(input.value, expected);
    equal(cleanText(expected, { latex: true, markdown: true, spaces: true }), expected);
    equal(cleanText(String.raw`\[\bar{x}-1\]`, { latex: true }), 'x\u0304 − 1');
    equal(cleanText(String.raw`\[\overline{x}_1+\bar y_2\]`, { latex: true }), 'x\u0304₁ + y\u0304₂');
    equal(cleanText(String.raw`\[\bar{\mu}_1\]`, { latex: true }), 'μ\u0304₁');
    const unsupported = String.raw`\[\overline{x+y}\]`;
    equal(cleanText(unsupported, { latex: true, markdown: true }), unsupported);
  });
  await test('PC2 summation keeps limits, letter indices and the mean bar in plain-text Copy', async () => {
    const source = String.raw`\[
PC2=\sum_{i=1}^{7}b_i(x_i-\bar{x}_i)
\]`;
    const expected = 'PC2 = ∑ᵢ₌₁⁷ bᵢ(xᵢ − x\u0304ᵢ)';
    type(''); paste(source); equal(input.value, expected);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard'); let copied;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { copied = value; } } });
      byId('copy').click(); await Promise.resolve(); equal(copied, expected);
      equal(clipboardPayload().html, null);
      preparePrint(); equal(byId('print-document').textContent, expected);
      window.dispatchEvent(new Event('afterprint'));
    } finally { if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else delete navigator.clipboard; }
    byId('undo').click(); equal(input.value, '');
    byId('redo').click(); equal(input.value, expected);
    equal(cleanText(expected, { latex: true, markdown: true, spaces: true }), expected);
    equal(cleanText(String.raw`\[\sum_{j=1}^{12}b_j(x_j-\bar{x}_j)\]`, { latex: true }), '∑ⱼ₌₁¹² bⱼ(xⱼ − x\u0304ⱼ)');
    equal(cleanText(String.raw`\[\sum_{i=1}^{n}x_i\]`, { latex: true }), '∑ᵢ₌₁ⁿ xᵢ');
    equal(cleanText(String.raw`\[\sum_{i=1}^{7}\]`, { latex: true }), '∑ᵢ₌₁⁷');
  });
  await test('LaTeX cleanup preserves unknown commands, malformed groups, prose and code', () => {
    const settings = { latex: true, markdown: true, spaces: true };
    for (const value of [String.raw`\[\boxed{\frac{a}{b}}\]`, String.raw`\[\boxed{x_1\]`, String.raw`\[\begin{matrix}a&b\\c&d\end{matrix}\]`, String.raw`\[a_{unknown}\]`]) equal(cleanText(value, settings), value);
    const prose = 'Costs $10 and $20. snake_case [Category A/B/C] C:\\Users\\Name';
    equal(cleanText(prose, settings), prose);
    equal(cleanText('`\\boxed{x_1}`\n```tex\n\\[x_1+x_2\\]\n```', settings), '\\boxed{x_1}\n\\[x_1+x_2\\]');
    equal(cleanText(pcSource, { latex: false }), pcSource);
  });
  await test('paste cleans automatically and undo/redo restores the whole operation', () => {
    type('Keep  **this**: replace');
    input.setSelectionRange(16, input.value.length);
    equal(options.every(option => option.checked), true);
    equal(byId('settings').open, false);
    equal(byId('clean'), null);
    const before = input.value;
    paste('  **Hello**\u00a0  world\u200b\n\n\n');
    equal(input.value, 'Keep  **this**: Hello world\n');
    byId('undo').click(); equal(input.value, before);
    byId('redo').click(); equal(input.value, 'Keep  **this**: Hello world\n');
  });
  await test('paste respects disabled cleanup options', () => {
    for (const option of options) option.checked = false;
    type('');
    const raw = '  **Hello**\u00a0  world\u200b\n\n\n';
    paste(raw); equal(input.value, raw);
    for (const option of options) option.checked = true;
  });
  await test('cleanup resulting in empty text preserves the selection', () => {
    type('Keep this text'); input.setSelectionRange(0, 4);
    paste(' \u200b ');
    equal(input.value, 'Keep this text'); equal(input.selectionStart, 0); equal(input.selectionEnd, 4);
  });
  await test('clear is reversible and removes persisted draft', () => {
    save(); const before = input.value;
    byId('clear').click(); equal(input.value, ''); equal(localStorage.getItem(storageKey), null);
    byId('undo').click(); equal(input.value, before);
    byId('redo').click(); equal(input.value, '');
    equal(byId('copy').disabled, true); equal(byId('download').disabled, true);
  });
  await test('keyboard undo/redo and edits discard redo branch', () => {
    type('first'); type('second');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true })); equal(input.value, 'first');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, cancelable: true })); equal(input.value, 'second');
    byId('undo').click(); type('new branch'); equal(byId('redo').disabled, true);
  });
  await test('IME composition is a single undo step', () => {
    const before = input.value;
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = 'に'; input.dispatchEvent(new InputEvent('input', { isComposing: true }));
    input.value = '日本'; input.dispatchEvent(new InputEvent('input', { isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend'));
    byId('undo').click(); equal(input.value, before);
    byId('redo').click(); equal(input.value, '日本');
  });
  await test('debounced autosave persists latest edit', async () => {
    type('Latest saved text');
    await new Promise(resolve => setTimeout(resolve, 350));
    equal(localStorage.getItem(storageKey), input.value);
  });
  await test('storage errors do not break editing', () => {
    const original = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = () => { throw Error('Quota exceeded'); };
      type('Still editable'); save();
      equal(saveStatus.textContent, 'Not saved · download TXT to keep a copy');
      byId('undo').click(); equal(input.value, 'Latest saved text');
    } finally { Storage.prototype.setItem = original; }
  });
  const withClipboard = async (clipboard, run) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
      await run();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete navigator.clipboard;
    }
  };
  await test('paste button reads, cleans and inserts clipboard text with undo', async () => {
    type('Keep old text'); input.setSelectionRange(5, 8);
    await withClipboard({ async readText() { return '  **Монгол**\u00a0  😀\u200b '; } }, async () => {
      byId('paste').click(); equal(byId('paste').disabled, true);
      await Promise.resolve();
      equal(input.value, 'Keep Монгол 😀 text'); equal(message.textContent, 'Pasted!');
      equal(byId('paste').disabled, false); equal(document.activeElement, input);
      byId('undo').click(); equal(input.value, 'Keep old text'); equal(input.selectionStart, 5); equal(input.selectionEnd, 8);
      byId('redo').click(); equal(input.value, 'Keep Монгол 😀 text');
    });
  });
  await test('empty clipboard button paste preserves selected content', async () => {
    type('Keep this'); input.setSelectionRange(0, 4);
    await withClipboard({ async readText() { return ''; } }, async () => {
      byId('paste').click(); await Promise.resolve();
      equal(input.value, 'Keep this'); equal(input.selectionStart, 0); equal(input.selectionEnd, 4);
      equal(message.textContent, 'No text to paste'); equal(byId('paste').disabled, false);
    });
  });
  await test('paste button rejects oversized clipboard blobs before reading them', async () => {
    type('Keep this');
    await withClipboard({ async read() { return [{ types: ['text/plain'], async getType() { return { size: MAX_CLIPBOARD_BYTES + 1, text() { throw Error('Oversized blob must not be read'); } }; } }]; } }, async () => {
      byId('paste').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      equal(input.value, 'Keep this');
      equal(message.textContent, 'Clipboard limit: 4 MB');
      equal(byId('paste').disabled, false);
    });
  });
  await test('denied or unavailable clipboard read provides keyboard fallback', async () => {
    for (const clipboard of [undefined, { async readText() { throw new DOMException('Denied', 'NotAllowedError'); } }]) {
      await withClipboard(clipboard, async () => {
        const before = input.value;
        byId('paste').click(); await Promise.resolve();
        equal(input.value, before); equal(document.activeElement, input); equal(byId('paste').disabled, false);
        equal(message.textContent, 'Clipboard access unavailable · press Ctrl/Cmd+V to paste');
      });
    }
  });
  await test('delayed clipboard read does not overwrite a changed document', async () => {
    let resolveRead;
    await withClipboard({ readText() { return new Promise(resolve => { resolveRead = resolve; }); } }, async () => {
      byId('paste').click(); type('New edit while waiting');
      resolveRead('Old clipboard text'); await Promise.resolve();
      equal(input.value, 'New edit while waiting'); equal(message.textContent, 'Text changed · paste again');
      equal(byId('paste').disabled, false);
    });
  });
  await test('copy writes exact text and preserves counts', async () => {
    type('Copy Монгол 😀');
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let copied;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { copied = value; } } });
      const counts = status.textContent;
      byId('copy').click(); await Promise.resolve();
      equal(copied, input.value); equal(status.textContent, counts); equal(message.textContent, 'Copied!');
      equal(byId('copy').textContent, 'Copied'); equal(byId('copy').classList.contains('copied'), true); equal(byId('copy').disabled, true);
      await new Promise(resolve => setTimeout(resolve, 250));
      equal(getComputedStyle(byId('copy')).backgroundColor, 'rgb(23, 128, 74)');
      await new Promise(resolve => setTimeout(resolve, 2400));
      equal(byId('copy').textContent, 'Copy'); equal(byId('copy').classList.contains('copied'), false); equal(byId('copy').disabled, false);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete navigator.clipboard;
    }
  });
  await test('copy fallback handles failure and leaves manual selection', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const original = document.execCommand;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.execCommand = () => false;
      byId('copy').click(); await Promise.resolve();
      equal(message.textContent, 'Press Ctrl/Cmd+C to copy the selected text');
      equal(byId('copy').textContent, 'Copy'); equal(byId('copy').classList.contains('copied'), false);
      equal(input.selectionStart, 0); equal(input.selectionEnd, input.value.length);
      document.execCommand = () => true;
      input.setSelectionRange(2, 4);
      byId('copy').click(); await Promise.resolve();
      equal(message.textContent, 'Copied!'); equal(input.selectionStart, 2); equal(input.selectionEnd, 4);
    } finally {
      document.execCommand = original;
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete navigator.clipboard;
    }
  });
  await test('TXT export preserves Unicode and content', async () => {
    type('Монгол 😀\nLine 2');
    const originalURL = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let blob, filename;
    try {
      URL.createObjectURL = value => { blob = value; return originalURL(value); };
      HTMLAnchorElement.prototype.click = function () { filename = this.download; };
      byId('download').click(); equal(filename, 'clean-text.txt'); equal(await blob.text(), input.value);
    } finally { URL.createObjectURL = originalURL; HTMLAnchorElement.prototype.click = originalClick; }
  });
  await test('document grows to fit long text', () => {
    type('line\n'.repeat(150));
    equal(input.scrollHeight <= input.clientHeight + 1, true);
    equal(input.clientHeight > 1120, true);
  });
  const selectText = (start, end) => {
    if (!input.hidden) input.focus();
    input.setSelectionRange(start, end);
    input.dispatchEvent(new Event('select'));
  };
  await test('selected text supports uppercase, lowercase and sentence case', () => {
    const original = 'Сайн MiXeD 😀';
    type(`Before ${original} after`); selectText(7, 7 + original.length);
    equal(byId('case-actions').hidden, false); equal(byId('case-default').disabled, false);
    byId('case-upper').click(); equal(input.value, `Before ${original.toUpperCase()} after`);
    equal(input.selectionStart, 7); equal(input.selectionEnd, 7 + original.length);
    save(); equal(localStorage.getItem(storageKey), input.value);
    byId('case-lower').click(); equal(input.value, `Before ${original.toLowerCase()} after`);
    byId('case-default').click(); equal(input.value, 'Before Сайн mixed 😀 after');
    equal(byId('case-default').disabled, true);
    byId('undo').click(); equal(input.value, `Before ${original.toLowerCase()} after`);
    byId('redo').click(); equal(input.value, 'Before Сайн mixed 😀 after');
  });
  await test('pasted uppercase text converts directly to readable sentence case', () => {
    type('');
    paste('HELLO WORLD. HOW ARE YOU?\n"THIS IS ANOTHER LINE."\nСАЙН БАЙНА УУ?');
    selectText(0, input.value.length);
    equal(byId('case-default').disabled, false);
    byId('case-default').click();
    equal(input.value, 'Hello world. How are you?\n"This is another line."\nСайн байна уу?');
    byId('undo').click(); equal(input.value, 'HELLO WORLD. HOW ARE YOU?\n"THIS IS ANOTHER LINE."\nСАЙН БАЙНА УУ?');
    byId('redo').click(); equal(input.value, 'Hello world. How are you?\n"This is another line."\nСайн байна уу?');
  });
  await test('case controls appear below selected text and keep the selection on click', () => {
    type('Selected words\nMore text'); selectText(0, 8);
    const actions = byId('case-actions');
    equal(actions.parentElement, input.parentElement);
    const panel = actions.getBoundingClientRect(), editor = input.getBoundingClientRect();
    equal(panel.top > editor.top && panel.top < editor.bottom, true);
    equal(getComputedStyle(actions).borderTopColor, getComputedStyle(splitPanel).borderTopColor);
    byId('case-upper').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    equal(input.selectionStart, 0); equal(input.selectionEnd, 8);
    byId('case-upper').click(); equal(input.value.startsWith('SELECTED'), true);
  });
  await test('case conversion handles Unicode expansion without touching adjacent text', () => {
    type('x Straße y'); selectText(2, 8);
    byId('case-upper').click(); equal(input.value, 'x STRASSE y'); equal(input.selectionEnd, 9);
    byId('case-lower').click(); equal(input.value, 'x straße y'); equal(input.selectionEnd, 8);
    byId('case-default').click(); equal(input.value, 'x Straße y'); equal(input.selectionEnd, 8);
  });
  await test('changing or clearing selection keeps case changes scoped', () => {
    type('One Two'); selectText(0, 3); byId('case-upper').click(); equal(input.value, 'ONE Two');
    selectText(4, 7); equal(byId('case-default').disabled, true);
    byId('case-default').click(); equal(input.value, 'ONE Two');
    byId('case-lower').click(); equal(input.value, 'ONE two');
    byId('case-default').click(); equal(input.value, 'ONE Two');
    selectText(0, 0); equal(byId('case-actions').hidden, true);
    byId('case-upper').click(); equal(input.value, 'ONE Two');
  });
  await test('case controls do not overlap find and refresh after document edits', () => {
    type('Some text'); selectText(0, 4); openFind();
    equal(byId('case-actions').hidden, true);
    closeFind(); equal(byId('case-actions').hidden, true);
    type('New content'); equal(byId('case-actions').hidden, true); equal(byId('case-default').disabled, true);
    findQuery.value = '';
  });
  await test('find panel stays above the floating toolbar while matches change', () => {
    type('cat\nnext line\ncat'); input.setSelectionRange(0, 3);
    openFind();
    const toolbar = document.querySelector('.toolbar');
    equal(findPanel.parentElement, toolbar);
    const first = findPanel.getBoundingClientRect(), controls = toolbar.getBoundingClientRect();
    equal(first.bottom <= controls.top - 10, true);
    equal(getComputedStyle(findPanel).borderTopColor, getComputedStyle(splitPanel).borderTopColor);
    byId('find-next').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    byId('find-next').click();
    equal(input.selectionStart, input.value.lastIndexOf('cat'));
    equal(Math.abs(findPanel.getBoundingClientRect().top - first.top) < 1, true);
    closeFind(false); findQuery.value = '';
  });
  const search = query => {
    findQuery.value = query;
    findQuery.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await test('Cmd+F opens find, seeds selection and supports wrapped navigation', () => {
    type('cat Cat cat'); input.setSelectionRange(0, 3);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true }));
    equal(findPanel.hidden, false); equal(document.activeElement, findQuery); equal(findQuery.value, 'cat');
    equal(byId('find-count').textContent, '1 of 3');
    equal(highlights.hidden, false); equal(highlights.children.length, 3);
    equal(highlights.querySelector('.active').textContent, 'cat');
    byId('find-next').click(); equal(input.selectionStart, 4);
    equal(highlights.querySelector('.active').textContent, 'Cat');
    byId('find-prev').click(); equal(input.selectionStart, 0);
    byId('find-prev').click(); equal(input.selectionStart, 8);
    findQuery.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    equal(input.selectionStart, 0);
  });
  await test('case option, literal special characters and empty searches', () => {
    byId('match-case').checked = true; byId('match-case').dispatchEvent(new Event('change'));
    equal(byId('find-count').textContent, '1 of 2');
    type('a.b a*b a[b] a\\b'); search('a[b]'); equal(matches.length, 1); equal(input.selectionStart, 8);
    search('a.b'); equal(matches.length, 1);
    search('a\\b'); equal(matches.length, 1);
    search('missing'); equal(byId('find-count').textContent, 'No matches'); equal(byId('replace-all').disabled, true);
    search(''); equal(byId('find-next').disabled, true);
    byId('match-case').checked = false;
  });
  await test('single replacement advances and is undoable', () => {
    type('cat cat'); search('cat'); replaceValue.value = 'dog';
    byId('replace-one').click(); equal(input.value, 'dog cat'); equal(input.selectionStart, 4); equal(input.selectionEnd, 7);
    byId('undo').click(); equal(input.value, 'cat cat'); equal(matches.length, 2);
    byId('redo').click(); equal(input.value, 'dog cat');
    save(); equal(localStorage.getItem(storageKey), 'dog cat');
    type('cat cat'); search('cat'); byId('find-next').click();
    byId('replace-one').click(); equal(input.value, 'cat dog');
    byId('undo').click(); equal(input.selectionStart, 4); equal(byId('find-count').textContent, '2 of 2');
  });
  await test('replace all uses literal replacement and one undo step', () => {
    type('cat Cat cat'); search('cat'); replaceValue.value = '$& cat';
    byId('replace-all').click(); equal(input.value, '$& cat $& cat $& cat');
    equal(message.textContent, 'Replaced 3 matches');
    byId('undo').click(); equal(input.value, 'cat Cat cat');
    byId('redo').click(); equal(input.value, '$& cat $& cat $& cat');
  });
  await test('empty replacement deletes matches and Unicode offsets stay correct', () => {
    type('😀 Сайн сайн'); search('сайн'); replaceValue.value = '';
    equal(matches.length, 2); equal(input.selectionStart, 3);
    byId('replace-all').click(); equal(input.value, '😀  ');
    equal(byId('find-count').textContent, 'No matches');
    byId('undo').click(); equal(input.value, '😀 Сайн сайн');
    type('İ x x'); search('x'); equal(input.selectionStart, 2);
    replaceValue.value = 'y'; byId('replace-one').click(); equal(input.value, 'İ y x');
  });
  await test('editing search fields does not undo the document', () => {
    const before = input.value;
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    findQuery.dispatchEvent(event); equal(event.defaultPrevented, false); equal(input.value, before);
    type('gone'); equal(matches.length, 0);
  });
  await test('offscreen matches scroll into view and panel fits the viewport', () => {
    type('line\n'.repeat(150) + 'needle'); search('needle');
    equal(window.scrollY > 1000, true);
    const rect = findPanel.getBoundingClientRect();
    equal(rect.left >= 0 && rect.right <= window.innerWidth, true);
    equal(rect.top > 0 && rect.bottom < window.innerHeight, true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    equal(findPanel.hidden, true); equal(document.activeElement, byId('find-toggle'));
    equal(highlights.hidden, true);
  });
  const tableFixture = '<table style="color:red;font-family:serif"><tr><th>Category</th><th>Percentage (%)</th></tr><tr><td>  **Highest**   category </td><td>X</td></tr><tr><td>Second category</td><td>Y</td></tr><tr><td>Lowest category</td><td>Z</td></tr><tr><td>Total</td><td>100a</td></tr></table>';
  const pasteHTML = (html, plain = '') => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', plain); clipboardData.setData('text/html', html);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true }));
  };
  await test('oversized HTML table spans and row counts are rejected before expansion', () => {
    type('Keep');
    pasteHTML('<table><tr><td colspan="101">x</td></tr></table>', 'Fallback');
    equal(input.value, 'Keep'); equal(message.textContent, 'Table limit: 10,000 cells');
    pasteHTML('<table>' + '<tr><td>x</td></tr>'.repeat(MAX_TABLE_ROWS + 1) + '</table>', 'Fallback');
    equal(input.value, 'Keep'); equal(message.textContent, 'Table limit: 10,000 cells');
  });
  const exportedDocument = () => new DOMParser().parseFromString(clipboardPayload().html, 'text/html');
  await test('file picker accepts TXT, CSV and TSV and TXT import cleans at the selection', async () => {
    equal(byId('open-file').getAttribute('aria-label'), 'Open TXT, CSV or TSV file');
    equal(byId('file-input').accept.includes('.csv'), true);
    type('Start end');
    input.setSelectionRange(6, 9);
    const selection = snapshot();
    equal(await importFile(new File(['\uFEFF  hello  \n\n world '], 'notes.txt'), selection), true);
    equal(input.value, 'Start hello\nworld');
    equal(message.textContent, 'TXT file opened');
    byId('undo').click(); equal(input.value, 'Start end');
    byId('redo').click(); equal(input.value, 'Start hello\nworld');
  });
  await test('CSV import keeps quoted commas and line breaks in a copyable table', async () => {
    type('');
    const csv = 'Name,Detail\r\none,"two, ""quoted"""\r\n"line\nbreak",3\r\n';
    equal(await importFile(new File([csv], 'data.csv'), snapshot()), true);
    equal(tables.length, 1);
    equal(parseGrid(input.value)[1][1], 'two, "quoted"');
    equal(parseGrid(input.value)[2][0], 'line\nbreak');
    const table = exportedDocument().querySelector('table');
    equal(table.rows.length, 3);
    equal(table.rows[1].cells[1].textContent, 'two, "quoted"');
    equal(table.rows[2].cells[0].textContent, 'linebreak');
    byId('undo').click(); equal(input.value, ''); equal(tables.length, 0);
    byId('redo').click(); equal(tables.length, 1);
  });
  await test('TSV import keeps columns while cleaning quoted cell tabs and rejects malformed CSV', async () => {
    type('');
    equal(await importFile(new File(['A\tB\nfirst\t"two\tparts"'], 'table.tsv'), snapshot()), true);
    equal(parseGrid(input.value)[1][1], 'two parts');
    equal(exportedDocument().querySelector('table').rows[1].cells[1].textContent, 'two parts');
    const before = input.value;
    equal(await importFile(new File(['a,"unterminated'], 'broken.csv'), snapshot()), false);
    equal(input.value, before);
    equal(message.textContent, 'Could not read the table format');
  });
  await test('file import does not overwrite edits made while the file was loading', async () => {
    type('before');
    const selection = snapshot();
    let finish;
    const file = { name: 'slow.txt', text: () => new Promise(resolve => { finish = resolve; }) };
    const pending = importFile(file, selection);
    type('after');
    finish('new text');
    equal(await pending, false);
    equal(input.value, 'after');
  });
  await test('oversized paste, document, lines, files and tables are rejected before insertion', async () => {
    type('Keep');
    paste('x'.repeat(MAX_SOURCE_CHARS + 1));
    equal(input.value, 'Keep'); equal(message.textContent, 'Paste limit: 1,000,000 characters');
    paste('x'.repeat(MAX_DOCUMENT_CHARS + 1));
    equal(input.value, 'Keep'); equal(message.textContent, 'Document limit: 500,000 characters');
    paste('x\n'.repeat(MAX_DOCUMENT_LINES));
    equal(input.value, 'Keep'); equal(message.textContent, 'Document limit: 10,000 lines');
    const selection = snapshot();
    const tooLarge = { name: 'large.txt', size: MAX_FILE_BYTES + 1, text() { throw Error('Should not read an oversized file'); } };
    equal(await importFile(tooLarge, selection), false);
    equal(message.textContent, 'File limit: 1 MB'); equal(input.value, 'Keep');
    const wide = new File([Array(MAX_TABLE_COLUMNS + 1).fill('a').join(',')], 'wide.csv');
    equal(await importFile(wide, selection), false);
    equal(message.textContent, 'Table limit: 10,000 cells'); equal(input.value, 'Keep');
    paste('<table><tr><td>safe</td></tr></table>'.repeat(30000));
    equal(input.value, 'Keep');
  });
  await test('pasting joined words automatically asks to separate only the new text', () => {
    const joined = 'Accordingtothistablewhichtypeofstudentisleastlikelytoenrolinandgraduatefromuniversity?';
    const separated = 'According to this table which type of student is least likely to enrol in and graduate from university?';
    type('Existing text: ');
    paste(joined);
    equal(input.value, 'Existing text: ' + joined);
    equal(splitPanel.hidden, false);
    equal(byId('split-scope').textContent, 'Separate pasted words?');
    equal(byId('split-preview').textContent, separated);
    equal(splitPanel.parentElement, input.parentElement);
    const editorRect = input.getBoundingClientRect(), panelRect = splitPanel.getBoundingClientRect();
    equal(panelRect.top > editorRect.top && panelRect.top < editorRect.bottom, true);
    equal(getComputedStyle(byId('split-preview')).outlineStyle, 'none');
    equal(document.activeElement, byId('split-preview'));
    byId('split-cancel').click();
    equal(input.value, 'Existing text: ' + joined);
    equal(document.activeElement, input);
    byId('undo').click(); equal(input.value, 'Existing text: ');
  });
  await test('joined-word review remains visible below long pasted text and above the toolbar', () => {
    const prior = 'Existing line\n'.repeat(75);
    type(prior);
    paste('Accordingtothistablewhichtypeofstudentisleastlikelytoenrolinandgraduatefromuniversity?');
    equal(splitPanel.hidden, false);
    const panel = splitPanel.getBoundingClientRect(), toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    equal(panel.top >= 0 && panel.bottom <= toolbar.top - 8, true, JSON.stringify({ panelTop: panel.top, panelBottom: panel.bottom, toolbarTop: toolbar.top, scrollY, scrollHeight: document.documentElement.scrollHeight }));
    byId('split-cancel').click();
  });
  await test('automatic word prompt can be disabled and ignores earlier text', () => {
    const toggle = byId('suggest-split');
    type('helloworld ');
    paste('ordinary text');
    equal(splitPanel.hidden, true);
    type('');
    toggle.checked = false;
    try {
      paste('helloworld');
      equal(input.value, 'helloworld');
      equal(splitPanel.hidden, true);
    } finally { toggle.checked = true; }
  });
  await test('ordinary pasted paragraphs do not trigger joined-word review', () => {
    const paragraph = 'The recent motion overhaul significantly improved Kanban dragging, but most of NoteApp still feels static.\nStop expanding the Motion System. Instead, audit the actual interactions of every existing component and block.\nPreserve performance and existing functionality. Do not introduce unnecessary dependencies.';
    type('');
    paste(paragraph);
    equal(input.value, paragraph);
    equal(splitPanel.hidden, true);
    paste('The system has helloworld in it.');
    equal(splitPanel.hidden, true);
  });
  await test('Paste button also shows the joined-word review', async () => {
    type('');
    await withClipboard({ async readText() { return 'helloworld'; } }, async () => {
      byId('paste').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      equal(input.value, 'helloworld');
      equal(splitPanel.hidden, false);
      equal(byId('split-preview').textContent, 'hello world');
      byId('split-apply').click();
      equal(input.value, 'hello world');
      byId('undo').click(); equal(input.value, 'helloworld');
    });
  });
  await test('joined English sentence is proposed before any edit and applied in one undo step', () => {
    const joined = 'Accordingtothistablewhichtypeofstudentisleastlikelytoenrolinandgraduatefromuniversity?';
    const separated = 'According to this table which type of student is least likely to enrol in and graduate from university?';
    type(joined);
    settings.open = true;
    byId('split-joined').click();
    equal(splitPanel.hidden, false);
    const panel = splitPanel.getBoundingClientRect();
    equal(panel.left >= 8 && panel.right <= window.innerWidth - 8 && panel.top >= 8, true);
    equal(byId('split-preview').textContent, separated);
    equal(input.value, joined);
    byId('split-apply').click();
    equal(input.value, separated);
    equal(splitPanel.hidden, true);
    byId('undo').click(); equal(input.value, joined);
    byId('redo').click(); equal(input.value, separated);
  });
  await test('joined-word tool limits edits to selection and leaves known words and URLs alone', () => {
    const value = 'already spaced · helloworld · https://example.com/helloworld · joinedwords.txt';
    type(value);
    input.setSelectionRange(value.indexOf('helloworld'), value.indexOf('helloworld') + 'helloworld'.length);
    byId('split-joined').click();
    equal(byId('split-preview').textContent, 'hello world');
    byId('split-cancel').click(); equal(input.value, value);
    byId('split-joined').click();
    byId('split-apply').click();
    equal(input.value, value.replace(' · helloworld ·', ' · hello world ·'));
    input.setSelectionRange(0, 0);
    equal(proposedWordSplits(snapshot()).edits.length, 0);
  });
  await test('joined words inside a pasted table keep table copy and undo intact', () => {
    type('');
    byId('suggest-split').checked = false;
    pasteHTML('<table><tr><td>Type</td><td>Detail</td></tr><tr><td>joinedwords</td><td>two</td></tr></table>');
    byId('suggest-split').checked = true;
    equal(tables.length, 1);
    byId('split-joined').click();
    equal(byId('split-preview').textContent.includes('joined words'), true);
    byId('split-apply').click();
    equal(exportedDocument().querySelector('table').rows[1].cells[0].textContent, 'joined words');
    byId('undo').click();
    equal(exportedDocument().querySelector('table').rows[1].cells[0].textContent, 'joinedwords');
  });
  await test('CV example uses one text editor and keeps its complete table on clipboard roundtrip', () => {
    const rows = [['Variable', 'CV'], ['x1', '0.0742'], ['x2', '0.0950'], ['x3', '0.0458 (Min)'], ['x4', '0.3521'], ['x5', '0.2387'], ['x6', '0.2026'], ['x7', '0.3541 (Max)']];
    type('');
    pasteHTML('<p>R output-оос хэрхэн мэдэх вэ?</p><p>stat.desc()-ийн coef.var мөрийг харна.</p><table>' + rows.map((row, index) => '<tr>' + row.map(cell => `<${index ? 'td' : 'th'}>${cell}</${index ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>');
    equal(input.hidden, false);
    equal(document.querySelectorAll('textarea').length, 1);
    equal(input.value.includes('Variable\tCV'), true);
    input.focus(); input.select();
    const clipboardData = new DataTransfer();
    input.dispatchEvent(new ClipboardEvent('copy', { clipboardData, cancelable: true }));
    const html = clipboardData.getData('text/html'), plain = clipboardData.getData('text/plain');
    const output = new DOMParser().parseFromString(html, 'text/html');
    const table = output.querySelector('table');
    equal(table.rows.length, rows.length);
    rows.forEach((row, r) => row.forEach((cell, c) => equal(table.rows[r].cells[c].textContent, cell)));
    equal(table.querySelector('th').style.fontWeight, 'normal');
    equal(table.style.width, ''); equal(table.style.tableLayout, '');
    type(''); pasteHTML(html, plain);
    equal(input.value, plain);
    rows.forEach((row, r) => row.forEach((cell, c) => equal(exportedDocument().querySelector('table').rows[r].cells[c].textContent, cell)));
  });
  await test('flattened placeholder table is recovered with two columns and all rows', () => {
    const rows = [
      ['Placeholder', 'Possible options'],
      ['[Category A/B/C]', 'Category names from the table'],
      ['[Variable]', 'Sales / Population / Temperature / Income'],
      ['[proportion/mean/value]', 'Proportion / Mean / Value / Frequency'],
      ['[unit]', '% / °C / kg / cm / AUD'],
      ['[Year 1/2]', 'Years or time periods'],
      ['X, Y, Z', 'Actual values from the table']
    ];
    for (const source of [rows.flat().join('\n'), rows.flat().join('\r\n\r\n'), rows.map(row => row.join('\t')).join('\n')]) {
      type(''); paste(source);
      equal(tables.length, 1); equal(input.value, rows.map(row => row.join('\t')).join('\n'));
      const table = exportedDocument().querySelector('table');
      equal(table.rows.length, 7); equal(table.querySelectorAll('th').length, 2);
      rows.forEach((row, r) => row.forEach((cell, c) => equal(table.rows[r].cells[c].textContent, cell)));
      byId('undo').click(); equal(input.value, ''); equal(tables.length, 0);
      byId('redo').click(); equal(exportedDocument().querySelector('table').rows.length, 7);
    }
  });
  await test('table inference leaves incomplete reference tables and ordinary prose alone', () => {
    const selected = { spaces: true, markdown: true, 'blank-lines': true, invisible: true };
    equal(extractPlainTable('Placeholder\nPossible options\n[Variable]\nSales\n[unit]', selected), null);
    equal(extractPlainTable('Heading\nDescription\nFirst sentence\nSecond sentence\nThird sentence\nFourth sentence', selected), null);
    equal(extractPlainTable('Placeholder\nPossible options\nFirst sentence\nSecond sentence\nThird sentence\nFourth sentence', selected), null);
  });
  await test('placeholder glossary cleans text and table cells while preserving table copy', () => {
    const rows = [
      ['[Category A/B/C]', 'Category names from the table'],
      ['[Variable]', 'Sales / Population / Temperature / Income'],
      ['[proportion/mean/value]', 'Proportion / Mean / Value / Frequency'],
      ['[unit]', '% / °C / kg / cm / AUD'],
      ['[Year 1/2]', 'Years or time periods'],
      ['X, Y, Z', 'Actual values from the table']
    ];
    type(''); paste(rows.map(row => row.join('\t')).join('\n'));
    equal(input.value, rows.map(row => row.join(' ')).join('\n'));
    type('');
    pasteHTML(`<table>${rows.map(row => `<tr>${row.map(cell => `<td>\u2003${escapeHTML(cell).replace(/ /g, '\u2002\u2009')}\u3000</td>`).join('')}</tr>`).join('')}</table>`);
    equal(input.value, rows.map(row => row.join('\t')).join('\n'));
    equal(getComputedStyle(input).tabSize, '1');
    const output = exportedDocument();
    rows.forEach((row, r) => row.forEach((cell, c) => equal(output.querySelector('table').rows[r].cells[c].textContent, cell)));
  });
  await test('HTML table paste cleans cells and preserves tabular structure on copy', () => {
    type(''); pasteHTML(tableFixture, 'Category\n\nPercentage (%)\n\nHighest category\n\nX');
    equal(input.value, 'Category\tPercentage (%)\nHighest category\tX\nSecond category\tY\nLowest category\tZ\nTotal\t100a');
    equal(tables.length, 1);
    const output = exportedDocument();
    equal(output.querySelectorAll('tr').length, 5); equal(output.querySelectorAll('tr')[4].cells[1].textContent, '100a');
    equal(output.querySelector('table').getAttribute('style').includes('red'), false);
    equal(output.querySelectorAll('b,strong,font').length, 0);
    equal(clipboardPayload().plain, input.value);
  });
  await test('table copy button supplies HTML and plain representations together', async () => {
    let copied;
    await withClipboard({ async write(items) { copied = items[0]; } }, async () => {
      byId('copy').click(); await Promise.resolve();
      equal(copied.types.includes('text/html'), true); equal(copied.types.includes('text/plain'), true);
      equal(await (await copied.getType('text/plain')).text(), input.value);
      const html = await (await copied.getType('text/html')).text();
      equal(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('tr').length, 5);
      equal(message.textContent, 'Copied with tables');
    });
  });
  await test('keyboard copy and fallback copy preserve table MIME data', async () => {
    input.select();
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData, cancelable: true }); input.dispatchEvent(event);
    equal(event.defaultPrevented, true); equal(clipboardData.getData('text/plain'), input.value);
    equal(clipboardData.getData('text/html').includes('<table'), true);
    const original = document.execCommand;
    let fallback;
    try {
      equal(byId('copy').disabled, true);
      await new Promise(resolve => setTimeout(resolve, 2650));
      equal(byId('copy').disabled, false);
      document.execCommand = () => {
        fallback = new DataTransfer();
        input.dispatchEvent(new ClipboardEvent('copy', { clipboardData: fallback, cancelable: true }));
        return true;
      };
      await withClipboard(undefined, async () => { byId('copy').click(); await Promise.resolve(); });
      equal(fallback.getData('text/html').includes('<table'), true);
    } finally { document.execCommand = original; }
  });
  await test('merged cells, empty cells, multiline text and quotes survive table roundtrip', () => {
    type('');
    pasteHTML('<table><tr><th colspan="2">Heading</th></tr><tr><td rowspan="2">A<br>B "quoted"</td><td></td></tr><tr><td>End</td></tr></table>');
    const output = exportedDocument();
    equal(output.querySelector('[colspan]').colSpan, 2); equal(output.querySelector('[rowspan]').rowSpan, 2);
    equal(output.querySelector('[rowspan]').innerHTML, 'A<br>B "quoted"');
    equal(output.querySelectorAll('tr')[1].cells[1].textContent, '');
    const payload = clipboardPayload();
    type(''); pasteHTML(payload.html, payload.plain);
    equal(exportedDocument().querySelector('[colspan]').colSpan, 2); equal(exportedDocument().querySelector('[rowspan]').rowSpan, 2);
  });
  await test('mixed paragraphs and multiple tables keep their original order', () => {
    type(''); pasteHTML('<p>Before</p>' + tableFixture + '<p>Between</p><table><tr><td>One column</td></tr><tr><td>Last</td></tr></table><p>After</p>');
    equal(tables.length, 2);
    const output = exportedDocument();
    equal(output.querySelectorAll('table').length, 2);
    equal(output.body.children[0].textContent.trim(), 'Before');
    equal(output.body.children[2].textContent.trim(), 'Between');
    equal(output.body.children[4].textContent.trim(), 'After');
    equal(output.querySelectorAll('table')[1].rows[1].cells[0].textContent, 'Last');
  });
  await test('table insertion, edits, find/replace, case changes and undo keep structure', () => {
    type(''); pasteHTML(tableFixture);
    const original = input.value;
    input.setSelectionRange(0, 0); paste('Intro\n');
    equal(tables[0].start, 6); equal(exportedDocument().querySelectorAll('tr').length, 5);
    openFind(); search('category'); replaceValue.value = 'group'; byId('replace-all').click();
    equal(exportedDocument().querySelectorAll('tr').length, 5);
    equal(exportedDocument().querySelector('th').textContent, 'group');
    closeFind(); selectText(0, input.value.length); byId('case-upper').click();
    equal(exportedDocument().querySelector('th').textContent, 'GROUP');
    byId('case-default').click(); equal(exportedDocument().querySelector('th').textContent, 'Group');
    byId('clear').click(); equal(tables.length, 0);
    byId('undo').click(); equal(exportedDocument().querySelectorAll('tr').length, 5);
    byId('redo').click(); equal(input.value, ''); equal(tables.length, 0);
    pasteHTML(tableFixture); equal(input.value, original);
  });
  await test('native text edits inside a table update exported cells', () => {
    const position = input.value.indexOf('100a');
    input.setSelectionRange(position, position + 4);
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText' }));
    input.setRangeText('95', position, position + 4, 'end');
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    equal(exportedDocument().querySelectorAll('tr')[4].cells[1].textContent, '95');
    byId('undo').click(); equal(exportedDocument().querySelectorAll('tr')[4].cells[1].textContent, '100a');
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText' }));
    input.setRangeText('!', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    equal(exportedDocument().querySelectorAll('tr')[4].cells[1].textContent, '100a!');
    byId('undo').click();
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText' }));
    input.setRangeText('New ', 0, 0, 'end');
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    equal(exportedDocument().querySelector('th').textContent, 'New Category');
  });
  await test('table clipboard read supports the Paste button', async () => {
    type('');
    await withClipboard({ async read() { return [{ types: ['text/plain', 'text/html'], async getType(type) { return new Blob([type === 'text/html' ? tableFixture : 'flattened'], { type }); } }]; } }, async () => {
      byId('paste').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      equal(tables.length, 1); equal(exportedDocument().querySelectorAll('tr').length, 5);
    });
  });
  await test('HTML source attributes and scripts never reach exported content', () => {
    type(''); pasteHTML('<style>body {color:red}</style><table onclick="alert(1)"><tr><td><img src="data:," onerror="alert(1)"><b>&lt;img src=x&gt; &amp; safe</b><script>window.bad = true;<\/script></td></tr></table>');
    const output = exportedDocument();
    equal(output.querySelectorAll('script,style,img,[onclick],[onerror]').length, 0);
    equal(output.querySelector('td').textContent, '<img src=x> & safe'); equal(window.bad, undefined);
  });
  await test('table metadata survives autosave and a fresh editor instance', async () => {
    type(''); pasteHTML(tableFixture); save();
    pageViewToggle.checked = true; pageViewToggle.dispatchEvent(new Event('change'));
    lineNumbersToggle.checked = true;
    lineNumbersToggle.dispatchEvent(new Event('change'));
    equal(JSON.parse(localStorage.getItem(tableStorageKey)).value, input.value);
    const root = document.documentElement.cloneNode(true);
    for (const script of root.querySelectorAll('script')) script.remove();
    const script = document.createElement('script'); script.textContent = byId('cleaner-app').textContent;
    root.querySelector('body').append(script);
    const frame = document.createElement('iframe'); frame.hidden = true;
    frame.srcdoc = root.outerHTML;
    await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
    const restored = frame.contentDocument.getElementById('text');
    equal(restored.hidden, false);
    equal(frame.contentDocument.getElementById('page-view').checked, true);
    equal(frame.contentDocument.body.classList.contains('page-view'), true);
    equal(frame.contentDocument.querySelectorAll('.page-sheet').length > 0, true);
    equal(frame.contentDocument.getElementById('show-line-numbers').checked, true);
    equal(frame.contentDocument.getElementById('line-numbers').hidden, false);
    equal(restored.value, input.value); restored.select();
    const clipboardData = new DataTransfer();
    restored.dispatchEvent(new ClipboardEvent('copy', { clipboardData, cancelable: true }));
    equal(new DOMParser().parseFromString(clipboardData.getData('text/html'), 'text/html').querySelectorAll('tr').length, 5);
    frame.remove();
    pageViewToggle.checked = false; pageViewToggle.dispatchEvent(new Event('change'));
    lineNumbersToggle.checked = false;
    lineNumbersToggle.dispatchEvent(new Event('change'));
  });

  await test('line numbers toggle without changing text, selection, counts or undo history', () => {
    type('First\n\nThird\n'); input.setSelectionRange(2, 9);
    const before = { value: input.value, status: status.textContent, historyIndex, width: input.clientWidth };
    lineNumbersToggle.click();
    equal(lineNumbers.hidden, false);
    equal(lineNumbers.childElementCount, 4);
    equal([...lineNumbers.children].map(row => row.dataset.line).join(','), '1,2,3,4');
    equal(input.value, before.value); equal(status.textContent, before.status);
    equal(input.selectionStart, 2); equal(input.selectionEnd, 9); equal(historyIndex, before.historyIndex);
    equal(clipboardPayload().plain, before.value);
    equal(input.clientWidth < before.width, true);
    type('One\nTwo'); equal(lineNumbers.childElementCount, 2);
    byId('undo').click(); equal(lineNumbers.childElementCount, 4);
    byId('redo').click(); equal(lineNumbers.childElementCount, 2);
    byId('clear').click(); equal(lineNumbers.childElementCount, 1);
    lineNumbersToggle.click(); equal(lineNumbers.hidden, true);
    equal(input.clientWidth, before.width);
  });
  await test('line numbers align with wrapped text and search highlights after resizing', () => {
    const value = 'Long wrapped text 😀\t'.repeat(30) + '\nTarget\n\n';
    type(value); lineNumbersToggle.click();
    openFind(); findQuery.value = 'Target'; updateFind(0);
    const paper = input.parentElement;
    for (const width of ['', '240px']) {
      paper.style.width = width; window.dispatchEvent(new Event('resize'));
      const mark = highlights.querySelector('mark').getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
      equal(lineNumbers.childElementCount > 4, true);
      const targetRow = lineNumbers.children[lineNumbers.childElementCount - 3].getBoundingClientRect();
      equal(Math.abs(targetRow.top + (lineHeight - mark.height) / 2 - mark.top) < 3, true);
      equal(Math.abs(targetRow.left - mark.left) < 1, true);
      equal(lineNumbers.textContent, '');
      for (let index = 0; index < lineNumbers.childElementCount; index++) {
        const row = lineNumbers.children[index];
        equal(row.dataset.line, String(index + 1));
        equal(row.getBoundingClientRect().height, lineHeight);
        if (index) equal(row.getBoundingClientRect().top - lineNumbers.children[index - 1].getBoundingClientRect().top, lineHeight);
      }
      equal(lineNumbers.getBoundingClientRect().bottom <= input.getBoundingClientRect().bottom + 1, true, { width, gutter: lineNumbers.getBoundingClientRect().toJSON(), editor: input.getBoundingClientRect().toJSON() });
    }
    paper.style.width = ''; closeFind(false); lineNumbersToggle.click();
    equal(document.documentElement.scrollWidth <= window.innerWidth, true);
  });
  await test('line numbers stay on a fixed row grid for the variance example, blank rows and Unicode text', () => {
    closeFind(false);
    const value = 'Proportion of Variance: PC тус бүр нийт variance-ийн хэдэн хувийг тайлбарлаж байнав\nCumulative Proportion: Эхний PC-ууд нийлээд хэдэн хувийг тайлбарлаж байна\n\n';
    type(value); input.setSelectionRange(5, 12);
    const count = status.textContent, index = historyIndex;
    lineNumbersToggle.click();
    const wideRows = lineNumbers.childElementCount;
    input.parentElement.style.width = '200px'; window.dispatchEvent(new Event('resize'));
    equal(lineNumbers.childElementCount > wideRows, true);
    equal(input.value, value); equal(input.selectionStart, 5); equal(input.selectionEnd, 12);
    equal(status.textContent, count); equal(historyIndex, index); equal(clipboardPayload().plain, value);
    const height = parseFloat(getComputedStyle(input).lineHeight);
    equal(lineNumbers.children[1].getBoundingClientRect().top - lineNumbers.children[0].getBoundingClientRect().top, height);
    input.parentElement.style.width = ''; window.dispatchEvent(new Event('resize'));
    type('One\u2028Two\u2029Three\n');
    equal(lineNumbers.childElementCount, 2);
    type('One\n\nThree\n'); equal(lineNumbers.childElementCount, 4);
    lineNumbersToggle.click();
  });

  await test('Print opens the native dialog with the full document and preserves editing state', () => {
    type(''); equal(byId('print').disabled, true);
    const value = 'Сайн байна уу <b>literal</b> & 😀\n\n' + 'A long document line\n'.repeat(150) + 'Last line';
    type(value); input.setSelectionRange(3, 8);
    const index = historyIndex;
    const nativePrint = window.print;
    let calls = 0;
    window.print = () => { calls++; equal(byId('print-document').textContent, value); };
    try { byId('print').click(); } finally { window.print = nativePrint; }
    equal(calls, 1); equal(byId('print-document').querySelector('b'), null);
    equal(input.value, value); equal(input.selectionStart, 3); equal(input.selectionEnd, 8); equal(historyIndex, index);
    window.dispatchEvent(new Event('afterprint')); equal(byId('print-document').childElementCount, 0);
    type('Updated document'); window.dispatchEvent(new Event('beforeprint'));
    equal(byId('print-document').textContent, 'Updated document');
    window.dispatchEvent(new Event('afterprint'));
  });
  await test('printing preserves cleaned tables and surrounding text', () => {
    type(''); pasteHTML('<p>Before</p>' + tableFixture + '<p>After</p>');
    window.dispatchEvent(new Event('beforeprint'));
    const output = byId('print-document');
    equal(output.querySelectorAll('tr').length, 5);
    equal(output.textContent.startsWith('Before'), true);
    equal(output.textContent.endsWith('After'), true);
    equal(output.querySelectorAll('textarea,button,script,img').length, 0);
    lineNumbersToggle.checked = true;
    window.dispatchEvent(new Event('beforeprint'));
    equal(output.querySelector('.print-content').classList.contains('numbered'), true);
    equal(output.querySelector('tr').dataset.line, '3');
    equal([...output.querySelectorAll('.print-line')].at(-1).dataset.line, '9');
    const printRule = [...document.styleSheets[0].cssRules].find(rule => rule.media?.mediaText === 'print');
    printRule.media.mediaText = 'all';
    try {
      const table = output.querySelector('table');
      equal(Math.abs(table.getBoundingClientRect().left - table.rows[0].cells[0].getBoundingClientRect().left) < 2, true);
      equal(getComputedStyle(table.rows[0].cells[0], '::before').content.includes('#3'), true);
    } finally { printRule.media.mediaText = 'print'; }
    lineNumbersToggle.checked = false;
    window.dispatchEvent(new Event('afterprint'));
  });
  await test('print styles hide editor controls and let long documents flow across pages', () => {
    type('Line\n'.repeat(150));
    lineNumbersToggle.checked = true; lineNumbersToggle.dispatchEvent(new Event('change'));
    window.dispatchEvent(new Event('beforeprint'));
    const rule = [...document.styleSheets[0].cssRules].find(rule => rule.media?.mediaText === 'print');
    equal(getComputedStyle(byId('print-document')).display, 'none');
    rule.media.mediaText = 'all';
    try {
      for (const element of document.querySelectorAll('body > :not(.print-document)')) equal(getComputedStyle(element).display, 'none');
      const output = byId('print-document');
      equal(getComputedStyle(output).display, 'block');
      equal(getComputedStyle(output).overflow, 'visible');
      equal(output.getBoundingClientRect().height > 2000, true);
      equal(output.textContent, input.value);
      equal(output.querySelector('.print-content').classList.contains('numbered'), true);
      equal(output.querySelectorAll('.print-line').length, 151);
      equal(output.querySelector('.print-line').dataset.line, '1');
      equal([...output.querySelectorAll('.print-line')].at(-1).dataset.line, '151');
      equal(getComputedStyle(output.querySelector('.print-line'), '::before').content.includes('#1'), true);
      equal(getComputedStyle(output).padding, '0px');
      equal(getComputedStyle(output).margin, '0px');
      lineNumbersToggle.checked = false; preparePrint();
      equal(output.querySelector('.numbered'), null);
    } finally {
      rule.media.mediaText = 'print';
      window.dispatchEvent(new Event('afterprint'));
      lineNumbersToggle.checked = false; lineNumbersToggle.dispatchEvent(new Event('change'));
    }
  });

  await test('page view adds separate sheets while preserving text, selection, Copy, history and print', () => {
    type('Page text\n'.repeat(85)); input.setSelectionRange(3, 19);
    const original = input.value, count = status.textContent, index = historyIndex;
    equal(pageViewToggle.checked, false);
    pageViewToggle.click();
    equal(document.body.classList.contains('page-view'), true); equal(pageSheets.hidden, false);
    equal(pageSheets.childElementCount > 1, true);
    equal(localStorage.getItem(pageViewKey), 'true');
    equal(input.value, original); equal(status.textContent, count); equal(historyIndex, index);
    equal(input.selectionStart, 3); equal(input.selectionEnd, 19); equal(clipboardPayload().plain, original);
    equal(document.querySelectorAll('textarea').length, 1);
    const sheets = [...pageSheets.children];
    for (let i = 0; i < sheets.length; i++) {
      equal(sheets[i].dataset.page, String(i + 1));
      if (i) equal(Math.abs(sheets[i].getBoundingClientRect().top - sheets[i - 1].getBoundingClientRect().bottom - 4) < 1, true);
    }
    equal(parseFloat(getComputedStyle(input.parentElement).paddingTop) > 0, true);
    equal(input.getBoundingClientRect().right < input.parentElement.getBoundingClientRect().right, true);
    openFind(); findQuery.value = 'Page'; updateFind(0);
    equal(Math.abs(highlights.getBoundingClientRect().left - input.getBoundingClientRect().left) < 1, true);
    equal(Math.abs(highlights.getBoundingClientRect().width - input.getBoundingClientRect().width) < 1, true);
    closeFind(false);
    preparePrint(); equal(byId('print-document').textContent, original);
    equal(byId('print-document').querySelector('.page-sheet'), null); window.dispatchEvent(new Event('afterprint'));
    equal(document.documentElement.scrollWidth <= window.innerWidth, true);
    pageViewToggle.click();
    equal(document.body.classList.contains('page-view'), false); equal(pageSheets.hidden, true);
    equal(input.style.minHeight, ''); equal(input.value, original); equal(historyIndex, index);
  });
  await test('notifications stay at the top right outside the desktop text column', async () => {
    closeFind(false); input.focus(); showMessage('Copied!');
    await new Promise(resolve => setTimeout(resolve, 260));
    equal(message.closest('.statusbar'), null);
    equal(message.classList.contains('visible'), true); equal(document.activeElement, input);
    const rect = message.getBoundingClientRect();
    equal(rect.left >= 0 && rect.right <= window.innerWidth, true);
    equal(rect.top, 16);
    equal(Math.abs(document.documentElement.clientWidth - rect.right - 20) < 1, true);
    if (window.innerWidth >= 1100) equal(rect.left > input.getBoundingClientRect().right, true);
    openFind(); showMessage('Replaced 1 match');
    equal(message.getBoundingClientRect().top, rect.top);
    showMessage('Clipboard access unavailable · press Ctrl/Cmd+V to paste');
    if (window.innerWidth >= 1100) equal(message.getBoundingClientRect().left > input.getBoundingClientRect().right, true);
    closeFind(false); clearMessage();
  });
  await test('notifications fade out with their text intact and new messages cancel old dismissal', async () => {
    showMessage('First message', 80);
    await new Promise(resolve => setTimeout(resolve, 40));
    showMessage('Second message', 120);
    await new Promise(resolve => setTimeout(resolve, 70));
    equal(message.textContent, 'Second message'); equal(message.classList.contains('visible'), true);
    await new Promise(resolve => setTimeout(resolve, 70));
    equal(message.classList.contains('visible'), false);
    if (!reducedMotion.matches) equal(message.textContent, 'Second message');
    showMessage('Third message', 1000);
    await new Promise(resolve => setTimeout(resolve, 260));
    equal(message.textContent, 'Third message'); equal(message.classList.contains('visible'), true);
    clearMessage(); equal(message.classList.contains('visible'), false);
    if (!reducedMotion.matches) equal(message.textContent, 'Third message');
    await new Promise(resolve => setTimeout(resolve, 260)); equal(message.textContent, '');
  });
  await test('toolbar position changes in Page settings without covering the document', () => {
    const toolbar = document.querySelector('.toolbar');
    const panel = settings.querySelector('.settings-panel');
    const top = document.querySelector('input[name="toolbar-position"][value="top"]');
    const bottom = document.querySelector('input[name="toolbar-position"][value="bottom"]');
    const original = input.value, count = status.textContent, index = historyIndex;
    equal(bottom.checked, true); equal(getComputedStyle(toolbar).position, 'fixed');
    settings.open = true; top.click(); window.scrollTo(0, 0);
    equal(top.checked, true); equal(document.body.classList.contains('toolbar-top'), true);
    equal(localStorage.getItem(toolbarPositionKey), 'top');
    equal(getComputedStyle(toolbar).position, 'sticky');
    let controls = toolbar.getBoundingClientRect();
    equal(controls.left >= 0 && controls.right <= window.innerWidth, true);
    equal(document.documentElement.scrollWidth <= window.innerWidth, true);
    equal(input.getBoundingClientRect().top >= controls.bottom + 16, true);
    equal(panel.getBoundingClientRect().top >= controls.bottom + 10, true);
    if (window.innerWidth <= 600) equal(controls.top >= document.querySelector('.brand-logo').getBoundingClientRect().bottom + 12, true);
    settings.open = false; openFind();
    controls = toolbar.getBoundingClientRect();
    equal(findPanel.getBoundingClientRect().top >= controls.bottom + 10, true);
    closeFind(false); settings.open = true; bottom.click();
    equal(bottom.checked, true); equal(document.body.classList.contains('toolbar-top'), false);
    equal(localStorage.getItem(toolbarPositionKey), 'bottom');
    equal(getComputedStyle(toolbar).position, 'fixed');
    equal(panel.getBoundingClientRect().bottom <= toolbar.getBoundingClientRect().top - 10, true);
    settings.open = false;
    equal(input.value, original); equal(status.textContent, count); equal(historyIndex, index);
  });
  await test('native empty placeholder and whitespace hint sit beside the caret', () => {
    const original = input.value;
    const hint = byId('empty-hint');
    const top = document.querySelector('input[name="toolbar-position"][value="top"]');
    const bottom = document.querySelector('input[name="toolbar-position"][value="bottom"]');
    window.scrollTo(0, 0); type('');
    equal(input.matches(':placeholder-shown'), true);
    equal(input.placeholder, 'Paste or type text here…');
    equal(hint.hidden, true);
    equal(getComputedStyle(input, '::placeholder').color, 'rgb(163, 162, 158)');
    type(' ');
    equal(hint.hidden, false); equal(hint.textContent, input.placeholder);
    const aligned = () => {
      const rect = hint.getBoundingClientRect(), editor = input.getBoundingClientRect(), style = getComputedStyle(input);
      equal(Math.abs(rect.top - editor.top - parseFloat(style.paddingTop)) < 2, true, { placement: 'top', hint: rect.top, editor: editor.top, padding: style.paddingTop });
      equal(rect.left > editor.left + parseFloat(style.paddingLeft) + 3, true, { placement: 'left', hint: rect.left, editor: editor.left, padding: style.paddingLeft });
    };
    aligned();
    top.click(); aligned();
    pageViewToggle.click(); aligned();
    pageViewToggle.click(); bottom.click();
    type(' \n\t\u200B');
    equal(hint.hidden, false); equal(byId('copy').disabled, true); equal(byId('clear').disabled, false);
    type('New text'); equal(input.matches(':placeholder-shown'), false);
    equal(hint.hidden, true); equal(byId('copy').disabled, false);
    type(original);
  });
  await test('draft saving can be disabled and privacy clear wipes content and history', async () => {
    const draftOption = byId('save-drafts');
    draftOption.checked = false; draftOption.dispatchEvent(new Event('change'));
    equal(localStorage.getItem(storageKey), null);
    equal(localStorage.getItem(tableStorageKey), null);
    equal(localStorage.getItem(saveDraftsKey), 'false');
    type('Private text');
    await new Promise(resolve => setTimeout(resolve, 350));
    equal(localStorage.getItem(storageKey), null);
    equal(saveStatus.textContent, 'Not saved in this browser');
    draftOption.checked = true; draftOption.dispatchEvent(new Event('change'));
    equal(localStorage.getItem(saveDraftsKey), 'true');
    equal(localStorage.getItem(storageKey), 'Private text');
    type('Secret');
    byId('clear-private').click();
    equal(input.value, ''); equal(byId('undo').disabled, true);
    equal(draftOption.checked, false);
    equal(localStorage.getItem(storageKey), null);
    equal(localStorage.getItem(saveDraftsKey), 'false');
    equal(message.textContent, 'Editor and saved drafts cleared');
  });
  await test('no horizontal overflow at current viewport', () => equal(document.documentElement.scrollWidth <= window.innerWidth, true));
  const output = document.createElement('pre');
  output.id = 'test-results'; output.textContent = JSON.stringify(results);
  document.body.append(output);
};
const seed = '<script>localStorage.setItem("plain-text-cleaner.save-drafts.v1", "true"); localStorage.setItem("plain-text-cleaner.document.v1", "Saved draft 🇲🇳");</script>';
const base = `<base href="${pathToFileURL(path.join(__dirname, '..') + path.sep).href}">`;
const html = source.replace('<head>', '<head>' + base).replace('  <script id="cleaner-app">', seed + '\n  <script id="cleaner-app">').replace(/\n<\/body>/, () => `<script>window.browserChecks = (${checks.toString()})()</script></body>`);
const file = path.join(temporary, 'test.html');
fs.writeFileSync(file, html);
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function runViewport(viewport) {
  const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${path.join(temporary, viewport)}`], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let nextId = 0, buffer = '', stderr = '';
  const pending = new Map(), events = new Map();
  browser.stderr.on('data', data => { stderr += data; });
  browser.stdio[4].on('data', data => {
    buffer += data;
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
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const [width, height] = viewport.split(',').map(Number);
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await send('Page.enable', {}, sessionId);
        const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
        await send('Page.navigate', { url: pathToFileURL(file).href }, sessionId); await loaded;
        const result = await send('Runtime.evaluate', { expression: '(async () => { await window.browserChecks; return document.getElementById("test-results")?.textContent; })()', awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        if (!result.result.value) {
          const current = await send('Runtime.evaluate', { expression: 'document.body.dataset.currentTest', returnByValue: true }, sessionId);
          throw Error(`Browser tests stopped at ${current.result.value}`);
        }
        return JSON.parse(result.result.value);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Browser tests timed out: ${stderr.slice(-1000)}`)), 30000); })
    ]);
  } finally {
    clearTimeout(timer);
    const exited = new Promise(resolve => browser.once('close', resolve)); browser.kill();
    await exited;
  }
}
(async () => {
  try {
    for (const viewport of ['1280,900', '390,844']) {
      const results = await runViewport(viewport);
      for (const check of results) console.log(`${check.pass ? 'PASS' : 'FAIL'} [${viewport}] ${check.name}${check.error ? ': ' + check.error : ''}`);
      if (results.some(check => !check.pass)) process.exitCode = 1;
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
