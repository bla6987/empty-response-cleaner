const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const endpoint = '/api/backends/chat-completions/generate';
const errorPayload = { error: { message: '<none>' } };
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function setup({ chat, responses = [], document } = {}) {
    const timers = new Map();
    const calls = [];
    const deletions = [];
    const warnings = [];
    const clock = { now: 1_000_000 };
    let timerId = 0;
    const context = {
        chatId: 'chat', characterId: 1,
        chat: chat ?? [{ is_user: true, mes: 'Hello' }],
        extensionSettings: { 'empty-response-cleaner': {
            enabled: true, autoDelete: true, retryOnApiError: true, maxRetries: 3, retryDelayMs: 250,
        } },
        generate: async (type) => { calls.push(type); },
        // Mirrors ST's deleteMessage/deleteSwipe index handling.
        deleteMessage: async (id, swipeIndex) => {
            deletions.push({ id, swipeIndex });
            if (swipeIndex === undefined) {
                context.chat.splice(id, 1);
                return;
            }
            const message = context.chat[id];
            const current = message.swipe_id;
            message.swipes.splice(swipeIndex, 1);
            if (swipeIndex < current) {
                message.swipe_id = current - 1;
            } else if (swipeIndex === current) {
                message.swipe_id = Math.min(swipeIndex, message.swipes.length - 1);
                message.mes = message.swipes[message.swipe_id];
            }
        },
    };
    class FakeDate extends Date {
        static now() { return clock.now; }
    }
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => context },
        jQuery: () => {}, console, URL, Response, Headers, Date: FakeDate,
        window: { location: { href: 'http://localhost:8000/' } },
        document,
        requestAnimationFrame: (callback) => callback(),
        fetch: async () => {
            const next = responses.shift();
            return typeof next === 'function' ? next() : Response.json(next ?? errorPayload);
        },
        toastr: { info() {}, warning: (message) => warnings.push(message) },
        setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id) => timers.delete(id),
    });
    vm.runInContext(source, sandbox);
    vm.runInContext('installFetchInterceptor()', sandbox);
    return {
        context, calls, deletions, warnings, timers, clock,
        run: (code) => vm.runInContext(code, sandbox),
        request: (body = { stream: false }, url = endpoint) => sandbox.fetch(url, { body: JSON.stringify(body) }),
        fire: async () => {
            assert.equal(timers.size, 1);
            const [id, callback] = [...timers][0];
            timers.delete(id);
            await callback();
            await flush();
        },
    };
}

test('a rendered swipe that ST has not stored in swipes[] yet is kept', async () => {
    // saveReply state while CHARACTER_MESSAGE_RENDERED listeners run: swipes.length++
    // and mes are set, swipes[swipe_id] is written only after the event resolves.
    const message = { is_user: false, mes: 'New valid response', swipes: ['Old answer', undefined], swipe_id: 1 };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message] });
    h.run('onCharacterMessageRendered(1)');
    await h.fire();
    message.swipes[message.swipe_id] = message.mes;

    assert.deepEqual(h.deletions, []);
    assert.deepEqual(message.swipes, ['Old answer', 'New valid response']);
    assert.equal(message.mes, 'New valid response');
});

test('other empty swipes are still removed without blanking the new one', async () => {
    const message = { is_user: false, mes: 'New valid response', swipes: ['', 'Old answer', undefined], swipe_id: 2 };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message] });
    h.run('onCharacterMessageRendered(1)');
    await h.fire();

    assert.deepEqual(h.deletions, [{ id: 1, swipeIndex: 0 }]);
    assert.equal(message.swipe_id, 1);
    assert.equal(message.mes, 'New valid response');
    assert.deepEqual(message.swipes, ['Old answer', 'New valid response']);
});

test('an empty visible swipe is still removed', async () => {
    const message = { is_user: false, mes: '', swipes: ['Old answer', ''], swipe_id: 1 };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message] });
    h.run('onCharacterMessageRendered(1)');
    await h.fire();

    assert.deepEqual(h.deletions, [{ id: 1, swipeIndex: 1 }]);
    assert.equal(message.mes, 'Old answer');
    assert.deepEqual(message.swipes, ['Old answer']);
});

test('automatic cleanup only touches the message that was rendered', async () => {
    const h = setup({ chat: [
        { is_user: true, mes: 'Hi' },
        { is_user: false, mes: 'Good reply', swipes: ['Good reply'], swipe_id: 0 },
    ] });
    h.run('onCharacterMessageRendered(1)');
    // A newer AI message (e.g. the next generation's placeholder) appears before the timer fires.
    h.context.chat.push({ is_user: false, mes: '', swipes: [''], swipe_id: 0 });
    await h.fire();

    assert.deepEqual(h.deletions, []);
    assert.equal(h.context.chat.length, 3);
});

test('helper requests before GENERATE_AFTER_DATA are not counted as the generation', async () => {
    const h = setup();
    h.run('usingGenerateAfterDataEvent = true');
    h.run("onGenerationStarted('regenerate')");
    await h.request();
    assert.equal(h.timers.size, 0, 'unarmed generation ignores helper failure');

    h.run('onGenerateAfterData({}, true)');
    await h.request();
    assert.equal(h.timers.size, 0, 'dry runs do not arm');

    h.run("onGenerateAfterData({ prompt: [{ role: 'user', content: 'Hi' }] }, false)");
    await h.request({ type: 'regenerate', messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(h.timers.size, 1, 'armed generation request is retried');
});

test('a concurrent helper request is not attributed to an in-flight generation', async () => {
    let resolveMain;
    const h = setup({ responses: [
        () => new Promise((resolve) => { resolveMain = resolve; }),
        errorPayload,
    ] });
    h.run("onGenerationStarted('regenerate')");
    const main = h.request();
    await h.request();
    assert.equal(h.timers.size, 0);

    resolveMain(Response.json({ choices: [{ message: { content: 'Real reply' } }] }));
    await main;
    assert.equal(h.timers.size, 0);
});

test('retry is skipped when a real reply arrived during the delay', async () => {
    const h = setup();
    h.run("onGenerationStarted('regenerate')");
    await h.request();
    h.context.chat.push({ is_user: false, mes: 'Real reply' });
    await h.fire();

    assert.deepEqual(h.calls, []);
    assert.equal(h.timers.size, 0);
    assert.equal(h.run('retryState.attempts'), 0);
    assert.equal(h.context.chat.length, 2);
});

test('a regenerate retry never deletes an existing AI message', async () => {
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, { is_user: false, mes: 'Earlier reply' }] });
    h.run("onGenerationStarted('regenerate')");
    await h.request();
    await h.fire();

    assert.deepEqual(h.calls, []);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /not deleted/);
});

test('regenerate retries still run over a user turn or an empty AI message', async () => {
    for (const [type, trailing] of [['regenerate', null], ['normal', null], ['regenerate', { is_user: false, mes: '' }]]) {
        const h = setup();
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        await h.request();
        if (trailing) h.context.chat.push(trailing);
        await h.fire();
        assert.deepEqual(h.calls, ['regenerate'], `${type} ${JSON.stringify(trailing)}`);
    }
});

test('swipe retry is skipped if the user browsed swipes during the delay', async () => {
    // Failed swipe: swipe_id points past the stored swipes. The user then swipes back.
    const message = { is_user: false, mes: 'First', swipes: ['First'], swipe_id: 1 };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message] });
    h.run("onGenerationStarted('swipe')");
    await h.request();
    Object.assign(message, { mes: 'First', swipe_id: 0 });
    await h.fire();

    assert.deepEqual(h.calls, []);
});

test('retry waits for a running generation, then re-checks the chat', async () => {
    const document = { body: { dataset: { generating: 'true' } } };
    const h = setup({ document });
    h.run("onGenerationStarted('regenerate')");
    await h.request();

    await h.fire();
    assert.deepEqual(h.calls, []);
    assert.equal(h.timers.size, 1, 'polls while busy');

    delete document.body.dataset.generating;
    await h.fire();
    assert.deepEqual(h.calls, ['regenerate']);

    // A reply produced by the running generation cancels the retry instead.
    const busy = { body: { dataset: { generating: 'true' } } };
    const h2 = setup({ document: busy });
    h2.run("onGenerationStarted('regenerate')");
    await h2.request();
    await h2.fire();
    h2.context.chat.push({ is_user: false, mes: 'Reply that finished streaming' });
    delete busy.body.dataset.generating;
    await h2.fire();
    assert.deepEqual(h2.calls, []);
    assert.equal(h2.context.chat.length, 2);
});

test('retry gives up if a generation stays busy too long', async () => {
    const h = setup({ document: { body: { dataset: { generating: 'true' } } } });
    h.run("onGenerationStarted('regenerate')");
    await h.request();
    await h.fire();
    h.clock.now += 5 * 60_000;
    await h.fire();

    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.calls, []);
});

for (const action of ['onGenerationStopped()', "onGenerationStarted('swipe')", 'onChatChangedForExtension()', 'cleanupExtension()']) {
    test(`late failures cannot restart a cancelled generation: ${action}`, async () => {
        let resolveMain;
        const h = setup({ responses: [() => new Promise(resolve => { resolveMain = resolve; })] });
        h.context.eventSource = { removeListener() {} };
        h.context.event_types = {};
        h.run("onGenerationStarted('swipe')");
        const pending = h.request();
        h.run(action);
        resolveMain(Response.json(errorPayload));
        await pending;
        assert.equal(h.timers.size, 0);
        assert.deepEqual(h.calls, []);
        assert.equal(h.run('retryState.attempts'), 0);
    });
}

test('an old success cannot cancel the newer generation retry', async () => {
    let resolveOld;
    const h = setup({ responses: [() => new Promise(resolve => { resolveOld = resolve; }), errorPayload] });
    h.run("onGenerationStarted('swipe')");
    const pending = h.request();
    h.run("onGenerationStarted('swipe')");
    await h.request();
    resolveOld(Response.json({ choices: [{ message: { content: 'old result' } }] }));
    await pending;
    assert.equal(h.timers.size, 1);
    await h.fire();
    assert.deepEqual(h.calls, ['swipe']);
});

for (const helperResult of [errorPayload, { choices: [{ message: { content: 'helper' } }] }]) {
    test(`helpers after arming leave the foreground request available (${Boolean(helperResult.error) ? 'error' : 'success'})`, async () => {
        const h = setup({ responses: [helperResult, helperResult, errorPayload] });
        h.run('usingGenerateAfterDataEvent = true');
        h.run("onGenerationStarted('swipe')");
        h.run("onGenerateAfterData({ prompt: [{ role: 'user', content: 'Main prompt' }] })");
        // generateRaw uses quiet, even if given the same prompt.
        await h.request({ type: 'quiet', messages: [{ role: 'user', content: 'Main prompt' }] });
        // Other helpers may use a foreground type with their own prompt.
        await h.request({ type: 'swipe', messages: [{ role: 'user', content: 'Helper prompt' }] });
        assert.equal(h.timers.size, 0);
        await h.request({ type: 'swipe', messages: [{ role: 'user', content: 'Main prompt' }] });
        assert.equal(h.timers.size, 1);
        await h.fire();
        assert.deepEqual(h.calls, ['swipe']);
    });
}

test('an unchanged failed overswipe still retries', async () => {
    const message = { is_user: false, mes: 'First', swipes: ['First'], swipe_id: 1 };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message] });
    h.run("onGenerationStarted('swipe')");
    await h.request();
    await h.fire();
    assert.deepEqual(h.calls, ['swipe']);
});

for (const stream of [false, true]) {
    test(`failed swipe retries after ST restores the previous response (stream: ${stream})`, async () => {
        const message = {
            is_user: false, mes: 'Second', swipes: ['First', 'Second'], swipe_id: 2,
            swipe_info: [{ extra: { model: 'first' } }, { extra: { model: 'second' } }],
        };
        const document = { body: { dataset: { generating: 'true', swiping: 'true' } } };
        const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message], document });
        h.context.generate = async type => {
            h.calls.push(type);
            assert.equal(message.swipe_id, 2, 'retry appends a new swipe');
            message.mes = 'New response';
            message.swipes.push(message.mes);
        };
        h.run("onGenerationStarted('swipe')");
        await h.request({ stream, type: 'swipe' });
        await h.fire();
        assert.deepEqual(h.calls, [], 'wait for the enclosing swipe to finish');

        // ST's endSwipe clamps the unsaved slot and reloads the stored swipe.
        message.swipe_id = message.swipes.length - 1;
        message.mes = message.swipes[message.swipe_id];
        delete document.body.dataset.generating;
        delete document.body.dataset.swiping;
        await h.fire();

        assert.deepEqual(h.calls, ['swipe']);
        assert.deepEqual(message.swipes, ['First', 'Second', 'New response']);
        assert.deepEqual(message.swipe_info, [{ extra: { model: 'first' } }, { extra: { model: 'second' } }]);
    });
}

test('a fast network failure waits for native swipe state before retrying the rollback', async () => {
    const message = { is_user: false, mes: 'First', swipes: ['First'], swipe_id: 1 };
    const h = setup({
        chat: [{ is_user: true, mes: 'Hi' }, message],
        responses: [() => { throw new TypeError('Failed to fetch'); }],
    });
    let state = 'swiping';
    h.context.swipe = { state: () => state };
    h.run("onGenerationStarted('swipe')");
    await assert.rejects(h.request(), /Failed to fetch/);
    // The opening animation has not yet set dataset.swiping.
    message.swipe_id = 0;
    await h.fire();
    assert.deepEqual(h.calls, []);
    state = 'none';
    await h.fire();
    assert.deepEqual(h.calls, ['swipe']);
    assert.deepEqual(message.swipes, ['First']);
});

test('repeated API failures after native rollback keep the shared retry limit and saved response', async () => {
    const message = {
        is_user: false, mes: 'First', swipes: ['First'], swipe_id: 1,
        swipe_info: [{ extra: { model: 'original' } }],
    };
    const document = { body: { dataset: { swiping: 'true' } } };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message], document });
    h.context.generate = async type => {
        h.calls.push(type);
        assert.equal(message.swipe_id, 1);
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        await h.request();
    };
    h.run("onGenerationStarted('swipe')");
    await h.request();
    message.swipe_id = 0;
    delete document.body.dataset.swiping;
    for (let i = 0; i < 3; i++) await h.fire();
    assert.deepEqual(h.calls, ['swipe', 'swipe', 'swipe']);
    assert.equal(h.timers.size, 0);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /limit reached/);
    assert.equal(message.swipe_id, 0);
    assert.equal(message.mes, 'First');
    assert.deepEqual(message.swipes, ['First']);
    assert.deepEqual(message.swipe_info, [{ extra: { model: 'original' } }]);
});

test('browsing after an automatic swipe rollback still cancels retry', async () => {
    const message = { is_user: false, mes: 'First', swipes: ['First'], swipe_id: 1 };
    const document = { body: { dataset: { swiping: 'true' } } };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message], document });
    h.run("onGenerationStarted('swipe')");
    await h.request();
    message.swipe_id = 0;
    delete document.body.dataset.swiping;
    // Unlike endSwipe's rollback, an explicit swipe emits MESSAGE_SWIPED.
    h.run('onMessageSwiped(1)');
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.calls, []);
});

test('swipe navigation listener cancels retries and is removed on cleanup', async () => {
    const message = { is_user: false, mes: 'First', swipes: ['First'], swipe_id: 1 };
    const document = { body: { dataset: { swiping: 'true' } } };
    const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message], document });
    const listeners = new Map();
    h.context.event_types = { CHARACTER_MESSAGE_RENDERED: 'rendered', MESSAGE_SWIPED: 'swiped' };
    h.context.eventSource = {
        on(event, callback) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(callback);
        },
        removeListener(event, callback) { listeners.get(event)?.delete(callback); },
    };
    h.run('registerEventListeners(); registerEventListeners()');
    assert.equal(listeners.get('swiped').size, 1);
    h.run("onGenerationStarted('swipe')");
    await h.request();
    message.swipe_id = 0;
    delete document.body.dataset.swiping;
    for (const callback of listeners.get('swiped')) callback(1);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.calls, []);
    h.run('cleanupExtension()');
    assert.equal(listeners.get('swiped').size, 0);
    assert.equal(listeners.get('rendered').size, 0);
});

for (const change of ['text', 'swipes', 'selection', 'message']) {
    test(`swipe rollback does not permit a changed ${change}`, async () => {
        const message = { is_user: false, mes: 'Second', swipes: ['First', 'Second'], swipe_id: 2 };
        const document = { body: { dataset: { swiping: 'true' } } };
        const h = setup({ chat: [{ is_user: true, mes: 'Hi' }, message], document });
        h.run("onGenerationStarted('swipe')");
        await h.request();
        message.swipe_id = 1;
        if (change === 'text') message.mes = 'Updated reply';
        if (change === 'swipes') message.swipes[0] = 'Edited first';
        if (change === 'selection') Object.assign(message, { swipe_id: 0, mes: 'First' });
        if (change === 'message') h.context.chat.push({ is_user: false, mes: 'New reply' });
        delete document.body.dataset.swiping;
        await h.fire();
        assert.deepEqual(h.calls, []);
    });
}

for (const [url, field] of [
    ['/api/backends/text-completions/generate', 'prompt'],
    ['/api/backends/kobold/generate', 'prompt'],
    ['/api/novelai/generate', 'input'],
]) {
    test(`post-hook helpers cannot claim the main ${field} request: ${url}`, async () => {
        const h = setup();
        h.run('usingGenerateAfterDataEvent = true');
        h.run("onGenerationStarted('swipe')");
        h.run(`onGenerateAfterData({ ${field}: 'Main prompt' })`);
        await h.request({ [field]: 'Helper prompt' }, url);
        assert.equal(h.timers.size, 0);
        await h.request({ [field]: 'Main prompt' }, url);
        await h.fire();
        assert.deepEqual(h.calls, ['swipe']);
    });
}

test('later listeners and provider role edits remain associated with the main request', async () => {
    const h = setup();
    h.run('usingGenerateAfterDataEvent = true');
    h.run("onGenerationStarted('swipe')");
    h.run(`
        const payload = { prompt: [null, { role: 'system', content: 'Original' }] };
        onGenerateAfterData(payload);
        payload.prompt[1].content = 'Edited';
        payload.prompt[1].role = 'user';
    `);
    await h.request({ type: 'swipe', messages: [{ role: 'user', content: 'Edited' }] });
    await h.fire();
    assert.deepEqual(h.calls, ['swipe']);
});
