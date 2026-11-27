const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = 'https://cleaner.example/api/organize';
const request = (text, options = {}) => new Request(url, {
  method: 'POST',
  headers: { Origin: 'https://cleaner.example', 'Content-Type': 'application/json', ...options.headers },
  body: options.body ?? JSON.stringify({ text })
});
const output = text => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ text }) }] }]
}), { status: 200 });

(async () => {
  const { default: handler } = await import(pathToFileURL(path.join(__dirname, '..', 'api', 'organize.mjs')).href);
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  const status = async response => response.status;
  try {
    delete process.env.OPENAI_API_KEY;
    assert.deepEqual(await (await handler.fetch(new Request(url))).json(), { available: false });
    assert.equal(await status(await handler.fetch(request('One  sentence.'))), 503, 'Missing key must not call an AI service');
    process.env.OPENAI_API_KEY = 'test-key';
    assert.deepEqual(await (await handler.fetch(new Request(url))).json(), { available: true });
    assert.equal(await status(await handler.fetch(new Request(url, { method: 'DELETE' }))), 405);
    assert.equal(await status(await handler.fetch(request('Text', { headers: { Origin: 'https://other.example' } }))), 403);
    assert.equal(await status(await handler.fetch(request('Text', { headers: { 'Content-Type': 'text/plain' } }))), 415);
    assert.equal(await status(await handler.fetch(request('Text', { headers: { 'Content-Length': '60001' } }))), 413);
    assert.equal(await status(await handler.fetch(request('x'.repeat(60001)))), 413);
    assert.equal(await status(await handler.fetch(request('Text', { body: '{bad' }))), 400);
    assert.equal(await status(await handler.fetch(request('x'.repeat(12001)))), 400);
    assert.equal(await status(await handler.fetch(request('Value\tAmount'))), 422);
    assert.equal(await status(await handler.fetch(request('PC2=\\sum_{i=1}^{7}x_i'))), 422);

    let calls = 0;
    global.fetch = async (target, options) => {
      calls++;
      assert.equal(target, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      const sent = JSON.parse(options.body);
      assert.equal(sent.store, false);
      assert.equal(sent.tools, undefined);
      assert.equal(sent.text.format.type, 'json_schema');
      assert.equal(sent.input[1].content, 'MODUN works in metropolitanSydney,partnering with TQM in 2026.');
      return output('MODUN works in metropolitan Sydney, partnering with TQM in 2026.');
    };
    const good = await handler.fetch(request('MODUN works in metropolitanSydney,partnering with TQM in 2026.'));
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { text: 'MODUN works in metropolitan Sydney, partnering with TQM in 2026.' });
    assert.equal(good.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls, 1);

    global.fetch = async () => output('MODUN works in metropolitan Sydney, partnering with TQM in 2027.');
    assert.equal(await status(await handler.fetch(request('MODUN works in metropolitanSydney,partnering with TQM in 2026.'))), 422);
    global.fetch = async () => new Response('', { status: 429 });
    assert.equal(await status(await handler.fetch(request('One  sentence.'))), 429);
    global.fetch = async () => new Response('invalid', { status: 200 });
    assert.equal(await status(await handler.fetch(request('One  sentence.'))), 502);
    process.stdout.write('AI backend checks passed\n');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
