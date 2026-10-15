const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const endpoint = '/api/backends/chat-completions/generate';

const NGINX_502 = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n'
    + '<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
const CLOUDFLARE_524 = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n'
    + '<head><title>api.example.com | 524: A timeout occurred</title>'
    + '<style>body{font-family:x} .forbidden-billing-authentication{}</style>'
    + '<script>var authentication = "invalid api key";</script></head>'
    + '<body><h1><span>A timeout occurred</span> <span>Error code 524</span></h1>'
    + '<p>Please try again in a few minutes.</p></body></html>';
const NO_STATUS_PAGE = '<!doctype html><html><head><title>Just a moment&hellip;</title></head><body>Checking</body></html>';

function streamOf(chunks) {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream({
        async pull(controller) {
            if (!chunks.length) return controller.close();
            controller.enqueue(encoder.encode(chunks.shift()));
        },
        cancel() { cancelled = true; },
    });
    return { body, wasCancelled: () => cancelled };
}

function setup(responseFactory) {
    const timers = new Map();
    const toasts = [];
    const calls = [];
    let timerId = 0;
    const context = {
        chatId: 'chat', characterId: 1, chat: [{ is_user: true, mes: 'Hi' }],
        extensionSettings: { 'empty-response-cleaner': {
            enabled: true, retryOnApiError: true, maxRetries: 3, retryDelayMs: 250,
        } },
        generate: async (type, options) => { calls.push({ type, options }); },
    };
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => context },
        jQuery: () => {}, console, URL, Response, TextDecoder,
        window: { location: { href: 'http://localhost:8000/' } },
        fetch: async () => responseFactory(),
        toastr: { info: (m) => toasts.push(m), warning: (m) => toasts.push(m) },
        setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id) => timers.delete(id),
    });
    vm.runInContext(source, sandbox);
    vm.runInContext('installFetchInterceptor()', sandbox);
    return {
        context, calls, timers, toasts,
        run: (code) => vm.runInContext(code, sandbox),
        request: (stream = false) => sandbox.fetch(endpoint, { body: JSON.stringify({ stream }) }),
    };
}

test('HTML page streamed with HTTP 200 and no Content-Type becomes a retried API error', async () => {
    const h = setup(() => new Response(streamOf(['\n', NGINX_502.slice(0, 20), NGINX_502.slice(20)]).body, { status: 200 }));
    h.run("onGenerationStarted('normal')");
    const response = await h.request(true);

    assert.equal(response.ok, false, 'ST must not treat the page as a reply');
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(payload.error.message, /HTML page/);
    assert.match(payload.error.message, /502 Bad Gateway/);
    assert.doesNotMatch(payload.error.message, /<|nginx/);

    assert.equal(h.timers.size, 1);
    assert.match(h.toasts[0], /502 Bad Gateway/);
    const [, launch] = [...h.timers][0];
    await launch();
    assert.equal(h.calls[0].type, 'regenerate');
});

test('HTML page returned with HTTP 200 to a non-streaming request is retried', async () => {
    const h = setup(() => new Response(CLOUDFLARE_524, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }));
    h.run("onGenerationStarted('swipe')");
    const response = await h.request(false);
    assert.equal(response.status, 524);
    assert.equal(h.timers.size, 1);
});

test('HTML error pages are judged by their title, not their scripts and styles', async () => {
    // The page body mentions "authentication", "invalid api key", and "billing".
    const h = setup(() => new Response(CLOUDFLARE_524, { status: 524, headers: { 'Content-Type': 'text/html' } }));
    h.run("onGenerationStarted('swipe')");
    const response = await h.request(true);
    assert.equal(response.status, 524, 'non-200 responses are already errors and pass through unchanged');
    assert.equal(h.timers.size, 1);
    assert.match(h.toasts[0], /524: A timeout occurred - A timeout occurred Error code 524/);
    assert.doesNotMatch(h.toasts[0], /DOCTYPE|<|font-family/);
});

test('HTML page without a status still retries; permanent statuses do not', async () => {
    let h = setup(() => new Response(NO_STATUS_PAGE, { status: 200 }));
    h.run("onGenerationStarted('swipe')");
    const response = await h.request(false);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /Just a moment…/);
    assert.equal(h.timers.size, 1);

    for (const [status, page] of [
        [403, '<html><head><title>403 Forbidden</title></head></html>'],
        [200, '<html><head><title>401 Unauthorized</title></head></html>'],
        [404, NGINX_502.replace(/502 Bad Gateway/g, 'Not Found')],
    ]) {
        h = setup(() => new Response(page, { status, headers: { 'Content-Type': 'text/html' } }));
        h.run("onGenerationStarted('swipe')");
        await h.request(true);
        assert.equal(h.timers.size, 0, page);
    }
});

test('HTML embedded in an error envelope is summarized for classification', async () => {
    const h = setup(() => Response.json({ error: { message: CLOUDFLARE_524 } }));
    h.run("onGenerationStarted('swipe')");
    const response = await h.request(false);
    assert.equal(response.status, 200, 'JSON envelopes are left for ST to report');
    assert.equal(h.timers.size, 1);
    assert.doesNotMatch(h.toasts[0], /<|font-family/);
});

test('real SSE streams without a Content-Type pass through intact', async () => {
    const events = ['data: {"choices":[{"delta":{"content":"<b>Hello"}}]}\n\n', 'data: [DONE]\n\n'];
    const stream = streamOf([...events]);
    const h = setup(() => new Response(stream.body, { status: 200 }));
    h.run("onGenerationStarted('normal')");
    const response = await h.request(true);
    assert.equal(response.ok, true);
    assert.equal(await response.text(), events.join(''));
    assert.equal(h.timers.size, 0);
    assert.equal(stream.wasCancelled(), false, 'the original stream is not cancelled');
});

test('disabling the extension leaves HTTP 200 pages untouched', async () => {
    const h = setup(() => new Response(NGINX_502, { status: 200 }));
    h.context.extensionSettings['empty-response-cleaner'].enabled = false;
    h.run("onGenerationStarted('normal')");
    const response = await h.request(true);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), NGINX_502);
    assert.equal(h.timers.size, 0);
});
