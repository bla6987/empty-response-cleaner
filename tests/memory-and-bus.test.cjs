const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const endpoint = '/api/backends/chat-completions/generate';

function runtime(mode = 'none') {
    let interceptor;
    let requestParses = 0;
    let sharedParses = 0;
    let clones = 0;
    const settings = { enabled: true, retryOnApiError: true, maxRetries: 3, retryDelayMs: 250 };
    const st = { chatId: 'chat', characterId: 1, chat: [], extensionSettings: { 'empty-response-cleaner': settings } };
    const response = { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        clone() { clones++; throw new Error('stream must not be cloned'); } };
    const window = { location: { href: 'http://localhost:8000/' } };
    if (mode !== 'none') window.STRuntimeBus = { fetch: { registerInterceptor(spec) { interceptor = spec; return () => {}; } } };
    const sandbox = vm.createContext({ window, SillyTavern: { getContext: () => st }, jQuery() {}, console,
        URL, Response, Headers, TextDecoder,
        JSON: { stringify: JSON.stringify, parse(value) { requestParses++; return JSON.parse(value); } },
        fetch: async () => response, setTimeout: () => 1, clearTimeout() {}, toastr: { info() {}, warning() {} },
    });
    vm.runInContext(source, sandbox);
    vm.runInContext('usingGenerateAfterDataEvent = true; installFetchInterceptor()', sandbox);
    return { st, settings, sandbox, response, parses: () => ({ local: requestParses, shared: sharedParses }), clones: () => clones,
        run: code => vm.runInContext(code, sandbox),
        async send(body, path = endpoint) {
            const init = { body: JSON.stringify(body), method: 'POST' };
            if (!interceptor) return sandbox.fetch(path, init);
            const req = { target: path, options: init, meta: {} };
            if (mode === 'new') req.getRequestJson = () => { sharedParses++; return body; };
            interceptor.requestObserve(req);
            const res = { request: req, response: await sandbox.fetch(path, init) };
            return interceptor.responseTransform(res);
        },
    };
}

for (const mode of ['none', 'old', 'new']) {
    test(`${mode} bus: disabled, retry-disabled, unarmed and unrelated requests do not parse`, async () => {
        const h = runtime(mode);
        const body = { stream: true, messages: [{ role: 'user', content: 'large '.repeat(5000) }] };
        await h.send(body);
        h.run("onGenerationStarted('normal')");
        await h.send(body);
        h.settings.enabled = false;
        h.run('onGenerateAfterData({ prompt: [] })');
        await h.send(body);
        h.settings.enabled = true;
        h.settings.retryOnApiError = false;
        await h.send(body);
        h.settings.retryOnApiError = true;
        h.run('onGenerateAfterData({ prompt: [] })');
        await h.send(body, '/api/backends/chat-completions/status');
        assert.deepEqual(h.parses(), { local: 0, shared: 0 });
        assert.equal(h.clones(), 0);
    });

    test(`${mode} bus: exact claim releases prompt refs and leaves streamed responses untouched`, async () => {
        const h = runtime(mode);
        h.run("onGenerationStarted('swipe'); const prompt = [{ role: 'user', content: 'original' }]; onGenerateAfterData({ prompt }); globalThis.claimed = getActiveGeneration();");
        await h.send({ stream: true, messages: [{ role: 'user', content: 'different' }] });
        assert.notEqual(h.sandbox.claimed.requestData, null, 'helper request must not claim this generation');
        // Include edits made by later GENERATE_AFTER_DATA listeners.
        h.run("prompt[0].content = 'edited by later listener'");
        assert.equal(await h.send({ stream: true, messages: [{ role: 'user', content: 'edited by later listener' }] }), h.response);
        assert.equal(h.sandbox.claimed.requestData, null);
        assert.equal(h.run('generationStack.length'), 0);
        assert.equal(h.clones(), 0);
        assert.deepEqual(h.parses(), mode === 'new' ? { local: 0, shared: 2 } : { local: 2, shared: 0 });
    });
}

test('bounded inspection cannot overshoot on a single giant chunk or consume the caller body', async () => {
    const h = runtime();
    const text = '<html><title>502 Bad Gateway</title>' + 'x'.repeat(2 * 1024 * 1024);
    const response = new Response(text);
    const result = await h.sandbox.readInspectionPrefix(response);
    assert.ok(result.text.length <= 256 * 1024);
    assert.equal(result.truncated, true);
    assert.equal(await response.text(), text);
});

test('request matching serializes individual messages, never the whole prompt array', () => {
    const h = runtime();
    const serialized = [];
    h.sandbox.JSON.stringify = value => { serialized.push(value); return JSON.stringify(value); };
    const messages = Array.from({ length: 1000 }, (_, index) => ({ role: 'user', content: 'prompt ' + index }));
    const generation = { type: 'normal', requestData: { prompt: messages } };
    assert.equal(h.sandbox.matchesGenerationRequest(generation, { path: endpoint, body: { messages } }), true);
    assert.ok(serialized.every(value => !Array.isArray(value)));
});
