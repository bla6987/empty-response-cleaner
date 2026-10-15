const extensionName = 'empty-response-cleaner';

// Default settings
const defaultSettings = {
    enabled: true,
    autoDelete: true,
    retryOnApiError: true,
    maxRetries: 3,
    retryDelayMs: 2000,
};

let isProcessing = false;
let lastScheduledCleanup = {
    messageIndex: null,
    at: 0,
};

// Module-level timer ID so we can clear any pending timer before scheduling a new one
let autoCleanupTimerId = null;

// Module-level event listener references so they can be removed later
let boundOnCharacterMessageRendered = null;
let boundOnMessageReceived = null;
let boundOnGenerationStarted = null;
let boundOnGenerateAfterData = null;
let boundOnGenerationStopped = null;
let boundOnChatChanged = null;
let boundOnMessageSwiped = null;
let usingCharacterMessageRenderedEvent = false;
let usingGenerateAfterDataEvent = false;

/**
 * Get extension settings from context
 * @returns {object} Extension settings object
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[extensionName];
}

/**
 * Initialize extension settings
 */
function loadSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

    if (!extensionSettings[extensionName]) {
        extensionSettings[extensionName] = {};
    }

    // Apply defaults for any missing settings
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extensionSettings[extensionName][key] === undefined) {
            extensionSettings[extensionName][key] = value;
        }
    }

    saveSettingsDebounced();
}

/**
 * Check if a swipe is empty (empty string or whitespace only)
 * @param {string} swipe - The swipe text to check
 * @returns {boolean} - True if the swipe is empty
 */
function isSwipeEmpty(swipe) {
    return !swipe || swipe.trim() === '';
}

const DEBUG = false;

function log(...args) {
    if (DEBUG) {
        console.debug(`[${extensionName}]`, ...args);
    }
}


const GENERATION_ENDPOINTS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const FETCH_PATCH_KEY = '__empty_response_cleaner_fetch_patch__';
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const RETRY_IDLE_POLL_MS = 500;
const RETRY_IDLE_MAX_WAIT_MS = 5 * 60_000;
const MAX_HTML_PAGE_CHARS = 256 * 1024;

let generationSequence = 0;
let foregroundGenerationId = 0;
let generationEpoch = 0;
let generationStack = [];
// Fetch success is not swipe success: wait for ST's final rendered text.
let pendingSwipeGeneration = null;
let swipeCompletionTimerId = null;
let emptySwipeCompletion = null;
let retryState = {
    attempts: 0,
    timerId: null,
    scheduledForGenerationId: null,
    chatKey: null,
    launching: false,
    launchedGenerationId: null,
    snapshot: null,
};

function clampNumber(value, min, max, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, numericValue));
}

function getMaxRetries() {
    return Math.round(clampNumber(getSettings()?.maxRetries, 0, 10, defaultSettings.maxRetries));
}

function getRetryDelayMs() {
    return Math.round(clampNumber(getSettings()?.retryDelayMs, 250, 60_000, defaultSettings.retryDelayMs));
}

function getCurrentChatKey() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId ?? '';

    if (context.groupId !== undefined && context.groupId !== null) {
        return 'group:' + String(context.groupId) + ':' + String(chatId);
    }

    return 'character:' + String(context.characterId ?? '') + ':' + String(chatId);
}

function copyRetryOptions(options) {
    if (!options || typeof options !== 'object') {
        return {};
    }

    const retryOptions = { ...options };
    // Never reuse an AbortSignal from the failed request.
    delete retryOptions.signal;
    return retryOptions;
}

function isRetryableGenerationType(type) {
    return [undefined, null, 'normal', 'regenerate', 'swipe', 'continue', 'impersonate'].includes(type);
}

function cancelPendingRetry(resetAttempts = false) {
    if (resetAttempts) {
        // Invalidate results from requests that have already left the stack.
        generationEpoch++;
        pendingSwipeGeneration = null;
        emptySwipeCompletion = null;
        if (swipeCompletionTimerId !== null) {
            clearTimeout(swipeCompletionTimerId);
            swipeCompletionTimerId = null;
        }
    }
    if (retryState.timerId !== null) {
        clearTimeout(retryState.timerId);
        retryState.timerId = null;
    }

    retryState.scheduledForGenerationId = null;
    retryState.snapshot = null;

    if (resetAttempts) {
        retryState.attempts = 0;
        retryState.chatKey = null;
    }
}

function onGenerationStarted(type, options = {}, dryRun = false) {
    if (dryRun) {
        return;
    }

    const normalizedType = type ?? 'normal';
    const generation = {
        id: ++generationSequence,
        type: normalizedType,
        options: copyRetryOptions(options),
        chatKey: getCurrentChatKey(),
        retryable: isRetryableGenerationType(type) && normalizedType !== 'quiet',
        // Prompt building may run helper requests before the foreground payload
        // exists. Later requests must also match that payload before claiming it.
        armed: !usingGenerateAfterDataEvent,
        requestData: null,
        swipeMessage: normalizedType === 'swipe' ? SillyTavern.getContext().chat?.at(-1) : null,
    };

    // A new foreground generation supersedes stale generation contexts.
    // If the user started it manually, it also starts a fresh retry budget.
    if (normalizedType !== 'quiet') {
        foregroundGenerationId = generation.id;
        pendingSwipeGeneration = null;
        emptySwipeCompletion = null;
        if (swipeCompletionTimerId !== null) {
            clearTimeout(swipeCompletionTimerId);
            swipeCompletionTimerId = null;
        }
        generationEpoch++;
        if (!retryState.launching || retryState.launchedGenerationId !== null) {
            cancelPendingRetry(true);
            retryState.chatKey = generation.chatKey;
        } else {
            retryState.launchedGenerationId = generation.id;
        }
        generationStack = [];
    }

    generation.epoch = generationEpoch;
    generationStack.push(generation);
    log('Generation started', {
        id: generation.id,
        type: generation.type,
        retryable: generation.retryable,
        autoRetry: retryState.launching,
    });
}

function onGenerateAfterData(generateData, dryRun = false) {
    if (dryRun) {
        return;
    }

    const generation = getActiveGeneration();
    if (generation) {
        generation.armed = true;
        // Keep the reference so later listeners' edits are included at fetch time.
        generation.requestData = generateData;
        log('Generation armed for API request', { id: generation.id, type: generation.type });
    }
}

function onGenerationStopped() {
    generationStack = [];
    cancelPendingRetry(true);
    log('Generation stopped; pending API retry cancelled');
}

function onChatChangedForExtension() {
    if (autoCleanupTimerId !== null) {
        clearTimeout(autoCleanupTimerId);
        autoCleanupTimerId = null;
    }

    lastScheduledCleanup = { messageIndex: null, at: 0 };
    generationStack = [];
    cancelPendingRetry(true);
}

function onMessageSwiped(messageIndex) {
    const { chat } = SillyTavern.getContext();
    if (retryState.snapshot && chat?.[messageIndex] === retryState.snapshot.lastMessage) {
        // Explicit navigation emits MESSAGE_SWIPED; endSwipe's automatic
        // rollback only reloads the stored swipe and does not emit this event.
        cancelPendingRetry(true);
    }
}

function getActiveGeneration() {
    return generationStack.length ? generationStack[generationStack.length - 1] : null;
}

function consumeGeneration(generationId) {
    const index = generationStack.findIndex((item) => item.id === generationId);
    if (index !== -1) {
        generationStack.splice(index, 1);
    }
}

function getRequestPath(input) {
    try {
        let rawUrl = '';

        if (typeof input === 'string') {
            rawUrl = input;
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
            rawUrl = input.href;
        } else if (input && typeof input.url === 'string') {
            rawUrl = input.url;
        }

        if (!rawUrl) {
            return '';
        }

        return new URL(rawUrl, window.location.href).pathname;
    } catch {
        return '';
    }
}

function parseRequestBody(init) {
    if (typeof init?.body !== 'string') {
        return null;
    }

    try {
        return JSON.parse(init.body);
    } catch {
        return null;
    }
}

function getGenerationRequestInfo(input, init) {
    const path = getRequestPath(input);
    if (!GENERATION_ENDPOINTS.has(path)) {
        return null;
    }

    const body = parseRequestBody(init);
    return {
        path,
        body,
        streaming: body?.stream === true || body?.streaming === true,
    };
}

function isCurrentGeneration(generation) {
    return generation.epoch === generationEpoch && generation.chatKey === getCurrentChatKey();
}

function matchesGenerationRequest(generation, requestInfo) {
    const body = requestInfo.body;
    if (body?.type !== undefined && (body.type ?? 'normal') !== generation.type) {
        return false;
    }

    const data = generation.requestData;
    if (!data) {
        return true; // Older ST without GENERATE_AFTER_DATA.
    }

    // generateRaw uses the same endpoints, including from hooks after arming.
    // Match the actual prompt as well as the request type before claiming it.
    if (requestInfo.path === '/api/backends/chat-completions/generate') {
        if (!Array.isArray(data.prompt) || !Array.isArray(body?.messages)) return false;
        const messages = data.prompt.filter(message => message && typeof message === 'object');
        return JSON.stringify(messages) === JSON.stringify(body.messages);
    }
    const field = Object.hasOwn(data, 'input') ? 'input' : 'prompt';
    return data[field] !== undefined && JSON.stringify(data[field]) === JSON.stringify(body?.[field]);
}

function isAbortError(error) {
    const name = String(error?.name ?? '');
    const message = String(error?.message ?? error ?? '');
    return name === 'AbortError' || /\babort(?:ed|ing)?\b/i.test(message);
}

function isRetryableHttpStatus(status) {
    const code = Number(status);
    return RETRYABLE_HTTP_STATUSES.has(code) || (code >= 500 && code <= 599);
}

function extractStatusCode(payload) {
    const candidates = [
        payload?.status,
        payload?.status_code,
        payload?.statusCode,
        payload?.code,
        payload?.error?.status,
        payload?.error?.status_code,
        payload?.error?.statusCode,
        payload?.error?.code,
        payload?.detail?.status,
        payload?.detail?.status_code,
        payload?.detail?.error?.status,
        payload?.detail?.error?.code,
    ];

    for (const value of candidates) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
            return value;
        }

        if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
            const parsed = Number(value.trim());
            if (parsed >= 100 && parsed <= 599) {
                return parsed;
            }
        }
    }

    return null;
}

function stringifyErrorValue(value) {
    if (value === undefined || value === null || value === false) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

const HTML_PAGE_PATTERN = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body|title|meta|h1|center)\b/i;
const EMBEDDED_HTML_PATTERN = /<(?:!doctype\s+html|html|head|body|title)\b/i;

function decodeHtmlEntities(text) {
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '\u2026', middot: '\u00B7',
        ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
    };
    return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
        if (name) {
            return named[name.toLowerCase()] ?? entity;
        }
        const codePoint = decimal ? Number(decimal) : parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
    });
}

function getHtmlText(html) {
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Reduce an HTML error page (proxy, CDN, or gateway) to readable text.
 * Markup, scripts, and styles would otherwise trip the error-wording patterns.
 * @param {string} html
 * @returns {string}
 */
function summarizeHtml(html) {
    const visible = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    const headings = [
        visible.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1],
        visible.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1],
    ].map(piece => getHtmlText(piece ?? '')).filter(Boolean);

    const unique = headings.filter((piece, index) => !headings.slice(0, index).some(other => other.includes(piece)));
    if (unique.length) {
        return unique.join(' - ').slice(0, 300);
    }

    const body = visible.match(/<body\b[^>]*>([\s\S]*)/i)?.[1] ?? visible;
    return getHtmlText(body).slice(0, 300);
}

/**
 * Describe a response body that is an HTML page rather than an API reply.
 * @param {string} rawText
 * @returns {{summary: string, status: number|null}|null}
 */
function describeHtmlPage(rawText) {
    if (typeof rawText !== 'string' || !HTML_PAGE_PATTERN.test(rawText.replace(/^﻿/, ''))) {
        return null;
    }

    const summary = summarizeHtml(rawText);
    const status = summary.match(/\b([45]\d\d)\b/);
    return { summary, status: status ? Number(status[1]) : null };
}

function getErrorText(payload, rawText = '') {
    const pieces = [
        stringifyErrorValue(payload?.error),
        stringifyErrorValue(payload?.detail?.error),
        stringifyErrorValue(payload?.detail),
        stringifyErrorValue(payload?.message),
        stringifyErrorValue(payload?.response),
    ].filter(Boolean).map(piece => EMBEDDED_HTML_PATTERN.test(piece) ? summarizeHtml(piece) : piece);

    const combined = pieces.join(' ');
    return (combined || rawText || '').slice(0, 4000);
}

function payloadContainsError(payload) {
    return Boolean(
        payload
        && (
            payload.error
            || payload?.detail?.error
            || payload.quota_error === true
        )
    );
}

const NON_RETRYABLE_ERROR_PATTERN = /insufficient[_\s-]?quota|quota\s+(?:exceeded|exhausted)|billing|invalid[_\s-]?(?:api[_\s-]?)?key|authentication|unauthori[sz]ed|forbidden|permission\s+denied|invalid[_\s-]?request|bad\s+request|context\s+(?:length|window)|maximum\s+context|content\s+(?:policy|moderation)|moderation|model\s+.*not\s+found/i;
const TRANSIENT_ERROR_PATTERN = /\b429\b|rate[\s_-]*limit|too\s+many\s+requests|temporar(?:y|ily)|overload(?:ed)?|capacity|server\s+busy|try\s+again|timeout|timed\s+out|connection\s+(?:reset|refused|closed)|econnreset|econnrefused|socket\s+hang\s+up|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+timeout|\b5\d\d\b/i;

function isUnspecifiedPayloadError(payload) {
    const error = payload?.error ?? payload?.detail?.error;
    const description = typeof error === 'object' && error !== null
        ? error.message ?? error.code ?? error.type
        : error;
    return description === true || description == null
        || /^(?:\s*|<none>|unknown error(?: occurred)?)$/i.test(String(description).trim());
}

function classifyGenerationResponse(response, payload, rawText) {
    const hasPayloadError = payloadContainsError(payload);
    // Proxies, CDNs, and gateways can answer with a web page, even with HTTP 200.
    const htmlPage = payload ? null : describeHtmlPage(rawText);
    const isError = !response.ok || hasPayloadError || htmlPage !== null;

    if (!isError) {
        return { isError: false, retryable: false };
    }

    const errorText = htmlPage
        ? ('HTML page instead of an API response' + (htmlPage.summary ? ': ' + htmlPage.summary : ''))
        : getErrorText(payload, rawText);
    // A status read from the page's title only stands in for a masked HTTP 200.
    const explicitStatus = extractStatusCode(payload) ?? (response.ok ? htmlPage?.status : null) ?? null;
    const status = explicitStatus ?? response.status;
    const result = (retryable) => ({
        isError: true,
        retryable,
        status,
        label: errorText || ('HTTP ' + String(status)),
        htmlPage,
    });

    // A concrete permanent status takes precedence over vague provider wording.
    const isPermanentStatus = (code) => code >= 400 && code < 500 && !isRetryableHttpStatus(code);
    if (payload?.quota_error === true || NON_RETRYABLE_ERROR_PATTERN.test(errorText)
        || isPermanentStatus(explicitStatus) || isPermanentStatus(response.status)) {
        return result(false);
    }

    // ST can replace an upstream failure with HTTP 200 and an error envelope,
    // losing the original status. Retry unspecified failures within the budget.
    if (isRetryableHttpStatus(explicitStatus) || isRetryableHttpStatus(response.status) || TRANSIENT_ERROR_PATTERN.test(errorText)
        || (response.ok && hasPayloadError && isUnspecifiedPayloadError(payload))
        || (response.ok && htmlPage !== null)) {
        return result(true);
    }

    return result(false);
}

function parseRetryAfterMs(response) {
    const value = response?.headers?.get?.('Retry-After');
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
    }

    const date = Date.parse(value);
    if (Number.isFinite(date)) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
    }

    return null;
}

function computeRetryDelayMs(attempt, retryAfterMs = null) {
    const exponentialDelay = Math.min(
        MAX_BACKOFF_MS,
        getRetryDelayMs() * Math.pow(2, Math.max(0, attempt - 1)),
    );

    if (Number.isFinite(retryAfterMs)) {
        return Math.max(exponentialDelay, retryAfterMs);
    }

    return exponentialDelay;
}

function formatRetryDelay(ms) {
    if (ms < 1000) {
        return String(Math.round(ms)) + ' ms';
    }

    const seconds = ms / 1000;
    return (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + ' s';
}

function getRetryGenerationType(generation) {
    const context = SillyTavern.getContext();
    const originalType = generation.type ?? 'normal';

    // A failed normal generation has usually already saved the user's message.
    // "regenerate" safely retries from that user turn without sending an empty
    // or send_if_empty user message.
    if (originalType === 'normal') {
        const lastMessage = context.chat?.[context.chat.length - 1];
        if (lastMessage?.is_user === true) {
            return 'regenerate';
        }
    }

    return originalType;
}

function markSuccessfulGenerationRequest(generation, rendered = false) {
    if (!isCurrentGeneration(generation)) return;
    if (generation.type === 'swipe' && !rendered) {
        pendingSwipeGeneration = generation;
        return;
    }
    if (retryState.attempts > 0 && retryState.chatKey === generation.chatKey) {
        log('API retry succeeded', { attempts: retryState.attempts });
        cancelPendingRetry(true);
    }
}

function markNonRetryableGenerationFailure(generation) {
    if (!isCurrentGeneration(generation)) return;
    if (retryState.chatKey === generation.chatKey) {
        cancelPendingRetry(true);
    }
}

function isSwipeInProgress() {
    // The native state covers the opening animation, before dataset.swiping
    // is set while endSwipe waits for Generate().
    return SillyTavern.getContext().swipe?.state?.() === 'swiping'
        || (typeof document !== 'undefined' && Boolean(document.body?.dataset?.swiping));
}

/**
 * Wait for both Generate() and the enclosing swipe animation to finish.
 * ST has no generation busy guard of its own.
 * @returns {boolean}
 */
function isGenerationInProgress() {
    return isSwipeInProgress()
        || (typeof document !== 'undefined' && Boolean(document.body?.dataset?.generating));
}

/**
 * Record the end of the chat at the moment a request failed.
 * @returns {{chatLength: number, lastMessage: object|null, lastMes: string, swipeId: number|undefined, swipeCount: number, swipes: Array|null}}
 */
function takeChatSnapshot() {
    const { chat } = SillyTavern.getContext();
    const lastMessage = chat?.[chat.length - 1] ?? null;

    return {
        chatLength: chat?.length ?? 0,
        lastMessage,
        lastMes: lastMessage?.mes ?? '',
        swipeId: lastMessage?.swipe_id,
        swipeCount: Array.isArray(lastMessage?.swipes) ? lastMessage.swipes.length : 0,
        swipes: Array.isArray(lastMessage?.swipes) ? [...lastMessage.swipes] : null,
    };
}

function isChatSnapshotUnchanged(snapshot) {
    const current = takeChatSnapshot();
    return current.chatLength === snapshot.chatLength
        && current.lastMessage === snapshot.lastMessage
        && current.lastMes === snapshot.lastMes
        && current.swipeId === snapshot.swipeId
        && current.swipeCount === snapshot.swipeCount
        && JSON.stringify(current.swipes) === JSON.stringify(snapshot.swipes);
}

function getFailedSwipeRollbackSnapshot(generation, snapshot) {
    if (generation.type !== 'swipe' || !isSwipeInProgress()
        || snapshot.lastMessage !== generation.swipeMessage
        || !snapshot.swipeCount || snapshot.swipeId !== snapshot.swipeCount) {
        return null;
    }

    // ST's endSwipe clamps an unsaved slot back to the last stored swipe.
    // Accept only that exact rollback, with the same message and swipe texts.
    return {
        ...snapshot,
        swipeId: snapshot.swipeCount - 1,
        lastMes: snapshot.swipes[snapshot.swipeCount - 1],
    };
}

/**
 * Handle only the completed swipe associated with a successful foreground fetch.
 * Cleanup runs after saveReply/streaming and the swipe animation have settled.
 */
function handleCompletedSwipe(messageIndex, type) {
    const generation = pendingSwipeGeneration;
    const { chat } = SillyTavern.getContext();
    if (emptySwipeCompletion && isCurrentGeneration(emptySwipeCompletion.generation)
        && chat?.[messageIndex] === emptySwipeCompletion.message) {
        return true; // Duplicate render events must not run a second cleanup.
    }
    if (!generation || !isCurrentGeneration(generation)
        || (type !== undefined && type !== 'swipe')
        || chat?.[messageIndex] !== generation.swipeMessage
        || messageIndex !== chat.length - 1) {
        return false;
    }

    pendingSwipeGeneration = null;
    if (!isSwipeEmpty(generation.swipeMessage.mes)) {
        markSuccessfulGenerationRequest(generation, true);
        return false;
    }

    if (!getSettings()?.retryOnApiError || getMaxRetries() <= 0) {
        return false;
    }

    const snapshot = takeChatSnapshot();
    // Non-streaming saveReply stores the active swipe after the render event.
    if (snapshot.swipes && snapshot.swipeId < snapshot.swipeCount) {
        snapshot.swipes[snapshot.swipeId] = snapshot.lastMes;
    }
    emptySwipeCompletion = { generation, message: generation.swipeMessage };
    const startedAt = Date.now();
    const finishEmptySwipe = async () => {
        swipeCompletionTimerId = null;
        if (!isCurrentGeneration(generation)) return;
        if (!getSettings()?.enabled || !getSettings()?.retryOnApiError
            || !isChatSnapshotUnchanged(snapshot)) {
            cancelPendingRetry(true);
            return;
        }
        if (isGenerationInProgress() || isProcessing) {
            if (Date.now() - startedAt >= RETRY_IDLE_MAX_WAIT_MS) {
                cancelPendingRetry(true);
                return;
            }
            swipeCompletionTimerId = setTimeout(runCompletion, RETRY_IDLE_POLL_MS);
            return;
        }

        const message = generation.swipeMessage;
        // Predict the official deletion API's resulting selection, so a user
        // changing swipes while asynchronous cleanup runs still cancels retry.
        const expectedSwipes = Array.isArray(message.swipes) ? [...message.swipes] : null;
        let expectedId = message.swipe_id;
        let expectedMes = message.mes;
        if (getSettings()?.autoDelete && expectedSwipes) {
            for (let i = expectedSwipes.length - 1; i >= 0; i--) {
                if (!isSwipeEmpty(expectedSwipes[i])) continue;
                expectedSwipes.splice(i, 1);
                if (i < expectedId) expectedId--;
                else if (i === expectedId) expectedId = Math.min(i, expectedSwipes.length - 1);
            }
            expectedMes = expectedSwipes[expectedId];
            await processLastMessageLocked(false, message);
        }
        if (!isCurrentGeneration(generation)) return;

        const current = takeChatSnapshot();
        if (current.chatLength !== snapshot.chatLength || current.lastMessage !== message
            || !expectedSwipes?.length || current.swipeId !== expectedId
            || current.lastMes !== expectedMes
            || JSON.stringify(current.swipes) !== JSON.stringify(expectedSwipes)) {
            cancelPendingRetry(true);
            return;
        }

        emptySwipeCompletion = null;
        scheduleGenerationRetry(generation, { label: 'Empty swipe response', emptySwipe: true });
    };
    const runCompletion = () => finishEmptySwipe().catch(error => {
        if (isCurrentGeneration(generation)) cancelPendingRetry(true);
        console.warn(`[${extensionName}] Empty swipe retry failed`, error);
    });
    swipeCompletionTimerId = setTimeout(runCompletion, 50);
    return true;
}

/**
 * Decide whether launching the retry now could destroy or duplicate a real reply.
 * @param {object} snapshot - Chat state from takeChatSnapshot() at failure time
 * @param {string} retryType - Generation type the retry would use
 * @returns {'reply-arrived'|'would-delete'|null}
 */
function getRetryBlocker(snapshot, retryType) {
    const { chat } = SillyTavern.getContext();
    const lastMessage = chat?.[chat.length - 1];

    // Only a non-empty AI message at the end of the chat is at risk.
    if (!lastMessage || lastMessage.is_user === true || isSwipeEmpty(lastMessage.mes)) {
        return null;
    }

    if (!isChatSnapshotUnchanged(snapshot)) {
        return 'reply-arrived';
    }

    // ST's regenerate deletes the last message when it isn't the user's.
    if (retryType === 'regenerate') {
        return 'would-delete';
    }

    return null;
}

function scheduleGenerationRetry(generation, failure) {
    if (!isCurrentGeneration(generation)) return;
    const settings = getSettings();

    if (!settings?.enabled || !settings?.retryOnApiError || !generation?.retryable) {
        return;
    }

    if (getCurrentChatKey() !== generation.chatKey) {
        cancelPendingRetry(true);
        return;
    }

    if (retryState.scheduledForGenerationId === generation.id) {
        return;
    }

    if (retryState.chatKey && retryState.chatKey !== generation.chatKey) {
        cancelPendingRetry(true);
    }
    retryState.chatKey = generation.chatKey;

    const maxRetries = getMaxRetries();
    if (maxRetries <= 0) {
        return;
    }

    if (retryState.attempts >= maxRetries) {
        retryState.scheduledForGenerationId = generation.id;
        toastr.warning(
            'Automatic retry limit reached (' + String(maxRetries) + ').',
            'Empty Response Cleaner',
            { timeOut: 8000 },
        );
        return;
    }

    retryState.attempts += 1;
    const attempt = retryState.attempts;
    const delayMs = computeRetryDelayMs(attempt, failure.retryAfterMs);
    retryState.scheduledForGenerationId = generation.id;

    const reason = String(failure.label || failure.reason || 'Transient API error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

    toastr.info(
        (reason ? reason + '. ' : '') +
        'Retrying in ' + formatRetryDelay(delayMs) +
        ' (' + String(attempt) + '/' + String(maxRetries) + ').',
        'Empty Response Cleaner',
        { timeOut: Math.min(10_000, Math.max(4000, delayMs)) },
    );

    log('Scheduled API retry', {
        generationId: generation.id,
        type: generation.type,
        attempt,
        maxRetries,
        delayMs,
        reason,
    });

    retryState.snapshot = takeChatSnapshot();
    const rollbackSnapshot = failure.emptySwipe
        ? null : getFailedSwipeRollbackSnapshot(generation, retryState.snapshot);
    let idleWaitStartedAt = null;

    const launchRetry = async () => {
        if (!isCurrentGeneration(generation)) return;
        retryState.timerId = null;

        const currentSettings = getSettings();
        if (!currentSettings?.enabled || !currentSettings?.retryOnApiError) {
            cancelPendingRetry(true);
            return;
        }

        if (getCurrentChatKey() !== generation.chatKey) {
            cancelPendingRetry(true);
            return;
        }

        if (isGenerationInProgress()) {
            idleWaitStartedAt ??= Date.now();
            if (Date.now() - idleWaitStartedAt >= RETRY_IDLE_MAX_WAIT_MS) {
                log('API retry cancelled; generation still running', { generationId: generation.id });
                cancelPendingRetry(true);
                return;
            }

            retryState.timerId = setTimeout(launchRetry, RETRY_IDLE_POLL_MS);
            return;
        }

        retryState.scheduledForGenerationId = null;

        const context = SillyTavern.getContext();
        const retryType = getRetryGenerationType(generation);

        if (rollbackSnapshot && isChatSnapshotUnchanged(rollbackSnapshot)) {
            retryState.snapshot = rollbackSnapshot;
        }
        const snapshot = retryState.snapshot;
        const blocker = failure.emptySwipe && !isChatSnapshotUnchanged(snapshot)
            ? 'reply-arrived' : getRetryBlocker(snapshot, retryType);
        if (blocker) {
            log('API retry skipped', { generationId: generation.id, retryType, blocker });
            cancelPendingRetry(true);

            if (blocker === 'would-delete') {
                toastr.warning(
                    'Automatic retry skipped so an existing message is not deleted.',
                    'Empty Response Cleaner',
                );
            }
            return;
        }

        retryState.launching = true;
        retryState.launchedGenerationId = null;
        let swipeBeforeRetry = null;
        try {
            log('Starting API retry', {
                originalType: generation.type,
                retryType,
                attempt,
            });

            if (retryType === 'swipe') {
                const message = context.chat?.at(-1);
                if (message && Array.isArray(message.swipes) && message.swipes.length) {
                    swipeBeforeRetry = takeChatSnapshot();
                    // saveReply writes at swipe_id. Always append, even after
                    // cleanup restored the visible selection to a valid reply.
                    message.swipe_id = message.swipes.length;
                }
            }
            await context.generate(retryType, copyRetryOptions(generation.options));
        } catch (error) {
            // Retryable request failures are detected by the fetch wrapper and
            // schedule the next attempt there. Avoid double-scheduling here.
            if (!isAbortError(error)) {
                console.warn('[' + extensionName + '] Retry generation failed', error);
            }
        } finally {
            retryState.launching = false;
            const message = context.chat?.at(-1);
            if (foregroundGenerationId === (retryState.launchedGenerationId ?? generation.id)
                && getCurrentChatKey() === generation.chatKey && swipeBeforeRetry
                && message === swipeBeforeRetry.lastMessage
                && message.swipe_id === swipeBeforeRetry.swipeCount
                && Array.isArray(message.swipes)
                && message.swipes.length === swipeBeforeRetry.swipeCount) {
                // A failed request never saved the new slot. Restore the prior
                // selection, keeping any scheduled API retry's snapshot in sync
                // with this deliberate rollback only.
                const canRefreshSnapshot = retryState.snapshot
                    && isChatSnapshotUnchanged(retryState.snapshot);
                message.swipe_id = Math.min(swipeBeforeRetry.swipeId ?? 0, message.swipes.length - 1);
                message.mes = message.swipes[message.swipe_id];
                if (canRefreshSnapshot) retryState.snapshot = takeChatSnapshot();
                await repairAndRerenderMessage(context.chat.length - 1);
            }
        }
    };

    retryState.timerId = setTimeout(launchRetry, delayMs);
}

/**
 * Read a streaming body only if it turns out to be an HTML page.
 * ST forwards streams without a Content-Type, so check the first bytes:
 * SSE and JSON never start with '<'. A real stream is left alone after that.
 * @param {Response} response
 * @returns {Promise<string>} The page, or '' for anything else
 */
async function readStreamingHtmlPage(response) {
    const reader = response.clone().body?.getReader?.();
    if (!reader) {
        return '';
    }

    const decoder = new TextDecoder();
    let text = '';
    try {
        while (text.length < MAX_HTML_PAGE_CHARS) {
            const { done, value } = await reader.read();
            if (done) {
                text += decoder.decode();
                break;
            }
            text += decoder.decode(value, { stream: true });
            const start = text.replace(/^﻿/, '').trimStart();
            if (start && !start.startsWith('<')) {
                return '';
            }
        }
        return text;
    } catch (error) {
        log('Could not inspect streaming response body', error);
        return '';
    } finally {
        // Cancelling the clone leaves the original body intact for ST.
        reader.cancel().catch(() => {});
    }
}

async function inspectGenerationResponse(response, requestInfo) {
    let rawText = '';
    let payload = null;

    // A streaming request may receive a finite JSON error envelope or HTML page
    // with HTTP 200. Inspect those bodies, but never wait for a real SSE stream.
    const contentType = response.headers?.get?.('Content-Type') ?? '';
    const isJsonResponse = /\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType);
    const isHtmlResponse = /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
    const isStreamResponse = /\b(?:text\/event-stream|application\/(?:x-)?ndjson)\b/i.test(contentType);
    if (!response.ok || !requestInfo.streaming || isJsonResponse || isHtmlResponse) {
        try {
            rawText = await response.clone().text();
            if (rawText) {
                try {
                    payload = JSON.parse(rawText);
                } catch {
                    payload = null;
                }
            }
        } catch (error) {
            log('Could not inspect generation response body', error);
        }
    } else if (!isStreamResponse) {
        rawText = await readStreamingHtmlPage(response);
    }

    return {
        ...classifyGenerationResponse(response, payload, rawText),
        retryAfterMs: parseRetryAfterMs(response),
    };
}

/**
 * Build the JSON error ST's API clients already display for failed requests.
 * @param {Response} original - The HTTP 200 HTML response being replaced
 * @param {{status: number, htmlPage: {summary: string}}} classification
 * @returns {Response}
 */
function createHtmlErrorResponse(original, classification) {
    original.body?.cancel?.().catch(() => {});

    const status = classification.status >= 400 && classification.status <= 599 ? classification.status : 502;
    const summary = classification.htmlPage?.summary;
    const message = 'The API returned an HTML page instead of a response.' + (summary ? ' ' + summary : '');
    return new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function installFetchInterceptor() {
    if (globalThis[FETCH_PATCH_KEY]?.installed) {
        return;
    }

    const originalFetch = globalThis.fetch.bind(globalThis);

    const wrappedFetch = async function (input, init) {
        const requestInfo = getGenerationRequestInfo(input, init);
        if (!requestInfo) {
            return originalFetch(input, init);
        }

        const generation = getActiveGeneration();

        // Extensions also call these endpoints (generateRaw, connection profiles)
        // without their own GENERATION_STARTED. Leave any request that isn't
        // the armed generation's own alone.
        if (!generation || !generation.armed || !isCurrentGeneration(generation)
            || !matchesGenerationRequest(generation, requestInfo)) {
            return originalFetch(input, init);
        }

        // Claim the generation before awaiting, so a concurrent helper request
        // can't be counted as this generation's result.
        consumeGeneration(generation.id);

        try {
            const response = await originalFetch(input, init);

            if (!generation.retryable) {
                return response;
            }

            const classification = await inspectGenerationResponse(response, requestInfo);

            if (!classification.isError) {
                markSuccessfulGenerationRequest(generation);
            } else if (classification.retryable) {
                scheduleGenerationRetry(generation, classification);
            } else {
                markNonRetryableGenerationFailure(generation);
            }

            // ST would treat an HTTP 200 page as a reply: an empty or garbled
            // message. Hand it a standard API error so it reports the failure.
            if (classification.htmlPage && response.ok && getSettings()?.enabled) {
                return createHtmlErrorResponse(response, classification);
            }

            return response;
        } catch (error) {
            if (generation.retryable && !isAbortError(error)) {
                scheduleGenerationRetry(generation, {
                    reason: 'Network error',
                    label: String(error?.message || 'Network error'),
                    retryAfterMs: null,
                });
            }

            throw error;
        }
    };

    globalThis.fetch = wrappedFetch;
    globalThis[FETCH_PATCH_KEY] = {
        installed: true,
        originalFetch,
    };

    log('Installed generation API retry interceptor');
}

function onRetryToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const enabled = $('#empty_response_cleaner_retry_api_errors').prop('checked');
    extensionSettings[extensionName].retryOnApiError = enabled;

    if (!enabled) {
        cancelPendingRetry(true);
    }

    saveSettingsDebounced();
}

function onMaxRetriesChange() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const value = Math.round(clampNumber(
        $('#empty_response_cleaner_max_retries').val(),
        0,
        10,
        defaultSettings.maxRetries,
    ));

    extensionSettings[extensionName].maxRetries = value;
    $('#empty_response_cleaner_max_retries').val(value);
    saveSettingsDebounced();
}

function onRetryDelayChange() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const seconds = clampNumber(
        $('#empty_response_cleaner_retry_delay').val(),
        0.25,
        60,
        defaultSettings.retryDelayMs / 1000,
    );

    const milliseconds = Math.round(seconds * 1000);
    extensionSettings[extensionName].retryDelayMs = milliseconds;
    $('#empty_response_cleaner_retry_delay').val(milliseconds / 1000);
    saveSettingsDebounced();
}

/**
 * Wait one UI tick so DOM/state updates from deleteMessage settle first.
 * @returns {Promise<void>}
 */
async function waitForUiTick() {
    await Promise.resolve();

    if (typeof requestAnimationFrame === 'function') {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Clamp swipe_id and force the visible message content to the active swipe,
 * then re-render only that message block.
 * @param {number} messageIndex
 * @returns {Promise<boolean>}
 */
async function repairAndRerenderMessage(messageIndex) {
    const { chat, updateMessageBlock, swipe } = SillyTavern.getContext();
    const canRerender = typeof updateMessageBlock === 'function';

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) {
        return false;
    }

    const message = chat[messageIndex];
    if (!message || message.is_user === true) {
        return false;
    }

    if (Array.isArray(message.swipes) && message.swipes.length > 0) {
        const currentSwipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        const clampedSwipeId = Math.max(0, Math.min(currentSwipeId, message.swipes.length - 1));
        message.swipe_id = clampedSwipeId;

        const activeSwipe = message.swipes[clampedSwipeId];
        if (clampedSwipeId === currentSwipeId && isSwipeEmpty(activeSwipe) && !isSwipeEmpty(message.mes)) {
            // ST's saveReply renders a new swipe before storing it in swipes[];
            // keep the visible text instead of blanking it.
            message.swipes[clampedSwipeId] = message.mes;
        } else {
            message.mes = typeof activeSwipe === 'string' ? activeSwipe : String(activeSwipe ?? '');
        }
    }

    await waitForUiTick();

    if (canRerender) {
        try {
            updateMessageBlock(messageIndex, message, { rerenderMessage: true });
        } catch (error) {
            console.warn(`[${extensionName}] updateMessageBlock failed`, { messageIndex, error });
        }
    }

    if (swipe && typeof swipe.refresh === 'function') {
        try {
            swipe.refresh(true, false);
        } catch {
            try {
                swipe.refresh();
            } catch (error) {
                console.warn(`[${extensionName}] swipe.refresh failed`, { messageIndex, error });
            }
        }
    }

    if (canRerender) {
        log('Repaired and re-rendered message after swipe cleanup', {
            messageIndex,
            swipeId: message.swipe_id,
        });
    }

    return canRerender;
}

/**
 * Get the SillyTavern deleteMessage API from context
 * @returns {Function|null}
 */
function getDeleteMessageApi() {
    const { deleteMessage } = SillyTavern.getContext();
    return typeof deleteMessage === 'function' ? deleteMessage : null;
}

/**
 * Delete a whole message or a single swipe via official ST API.
 * Returns false if API is unavailable or the operation fails.
 * @param {number} messageIndex
 * @param {number|undefined} swipeIndex
 * @returns {Promise<boolean>}
 */
async function deleteViaApi(messageIndex, swipeIndex = undefined) {
    const deleteMessage = getDeleteMessageApi();
    if (!deleteMessage) {
        toastr.warning('Cleanup skipped: compatible delete API not available', 'Empty Response Cleaner');
        console.warn(`[${extensionName}] deleteMessage API unavailable; skipping cleanup`);
        return false;
    }

    try {
        await deleteMessage(messageIndex, swipeIndex, false);
        return true;
    } catch (error) {
        console.warn(`[${extensionName}] delete API call failed`, { messageIndex, swipeIndex, error });
        toastr.warning('Cleanup skipped: delete API failed', 'Empty Response Cleaner');
        return false;
    }
}

/**
 * Analyze empty swipes from a message without mutating it
 * @param {object} message - The message object to clean
 * @returns {object} - Result with information about what was cleaned
 */
function cleanMessageSwipes(message) {
    const result = {
        emptySwipeIndexes: [],
        removedSwipes: 0,
        messageDeleted: false,
        modified: false,
    };

    // Check if message has swipes array
    if (!message.swipes || !Array.isArray(message.swipes)) {
        // If no swipes array, check the main 'mes' property
        if (isSwipeEmpty(message.mes)) {
            result.messageDeleted = true;
            result.modified = true;
        }
        return result;
    }

    // ST's saveReply emits CHARACTER_MESSAGE_RENDERED for a new swipe before it
    // copies mes into swipes[swipe_id]. Visible text means the swipe isn't empty.
    const activeSwipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const hasVisibleText = !isSwipeEmpty(message.mes);

    for (let i = 0; i < message.swipes.length; i++) {
        if (i === activeSwipeId && hasVisibleText) {
            continue;
        }

        if (isSwipeEmpty(message.swipes[i])) {
            result.emptySwipeIndexes.push(i);
        }
    }

    result.removedSwipes = result.emptySwipeIndexes.length;

    // If no empty swipes, no work to do
    if (result.removedSwipes === 0) {
        return result;
    }

    result.modified = true;

    // If all swipes are empty, mark for full message deletion
    if (result.removedSwipes === message.swipes.length) {
        result.messageDeleted = true;
    }

    return result;
}

/**
 * Process the last AI message and clean empty swipes
 * @param {boolean} isManual - Whether this is a manual trigger
 * @param {object|null} targetMessage - Message whose render triggered automatic cleanup;
 *   when omitted, the last AI message is cleaned
 * @returns {Promise<boolean>} - True if any changes were made
 */
async function processLastMessage(isManual = false, targetMessage = null) {
    const { chat } = SillyTavern.getContext();

    // Do nothing if chat is empty
    if (!chat || chat.length === 0) {
        if (isManual) {
            toastr.warning('Chat is empty', 'Empty Response Cleaner');
        }
        return false;
    }

    let messageIndex = -1;
    if (targetMessage) {
        // Clean only the message that triggered this run, wherever it is now.
        const targetIndex = chat.indexOf(targetMessage);
        if (targetIndex !== -1 && targetMessage.is_user === false) {
            messageIndex = targetIndex;
        }
    } else {
        // Find the last AI message
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user === false) {
                messageIndex = i;
                break;
            }
        }
    }

    // Do nothing if no AI message found
    if (messageIndex === -1) {
        if (isManual) {
            toastr.warning('No AI message found', 'Empty Response Cleaner');
        }
        return false;
    }

    // When auto-delete is disabled, skip all automatic cleanup/deletion.
    if (!isManual && !getSettings()?.autoDelete) {
        return false;
    }

    const message = chat[messageIndex];
    const result = cleanMessageSwipes(message);

    if (!result.modified) {
        if (isManual) {
            toastr.info('No empty swipes found', 'Empty Response Cleaner');
        }
        return false;
    }

    if (result.messageDeleted) {
        // Don't delete if this is the only message in the chat
        // SillyTavern UI fails to render this correctly
        if (chat.length <= 1) {
            if (isManual) {
                toastr.warning('Cannot remove the only message in chat', 'Empty Response Cleaner');
            }
            return false;
        }

        const deleted = await deleteViaApi(messageIndex);
        if (!deleted) {
            return false;
        }

        log('Deleted empty AI message via deleteMessage API', { messageIndex });
        toastr.info('Removed empty AI response', 'Empty Response Cleaner');
        return true;
    }

    let removedSwipes = 0;
    const emptyIndexesDescending = [...result.emptySwipeIndexes].sort((a, b) => b - a);

    // Delete each empty swipe through API so ST emits MESSAGE_SWIPE_DELETED.
    for (const swipeIndex of emptyIndexesDescending) {
        const deleted = await deleteViaApi(messageIndex, swipeIndex);
        if (deleted) {
            removedSwipes++;
            log('Deleted empty swipe via deleteMessage API', {
                messageIndex,
                swipeIndex,
            });

            // Keep UI in sync immediately after each deletion.
            await repairAndRerenderMessage(messageIndex);
        }
    }

    if (removedSwipes > 0) {
        toastr.info(`Removed ${removedSwipes} empty swipe${removedSwipes > 1 ? 's' : ''}`, 'Empty Response Cleaner');
        return true;
    }

    if (isManual) {
        toastr.warning('Unable to remove empty swipes', 'Empty Response Cleaner');
    }

    return false;
}

/**
 * Prevent overlapping cleanup runs from rapid event bursts.
 * @param {boolean} isManual
 * @param {object|null} targetMessage
 * @returns {Promise<boolean>}
 */
async function processLastMessageLocked(isManual = false, targetMessage = null) {
    if (isProcessing) {
        return false;
    }

    isProcessing = true;
    try {
        return await processLastMessage(isManual, targetMessage);
    } finally {
        isProcessing = false;
    }
}

/**
 * Cancel any pending auto-cleanup timer and remove registered event listeners.
 * Safe to call multiple times.
 */
function cleanupExtension() {
    if (autoCleanupTimerId !== null) {
        clearTimeout(autoCleanupTimerId);
        autoCleanupTimerId = null;
    }

    generationStack = [];
    cancelPendingRetry(true);

    const { eventSource, event_types } = SillyTavern.getContext();

    if (usingCharacterMessageRenderedEvent && boundOnCharacterMessageRendered && event_types?.CHARACTER_MESSAGE_RENDERED) {
        eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, boundOnCharacterMessageRendered);
    } else if (boundOnMessageReceived && event_types?.MESSAGE_RECEIVED) {
        eventSource.removeListener(event_types.MESSAGE_RECEIVED, boundOnMessageReceived);
    }

    if (boundOnGenerationStarted && event_types?.GENERATION_STARTED) {
        eventSource.removeListener(event_types.GENERATION_STARTED, boundOnGenerationStarted);
    }

    if (boundOnGenerateAfterData && event_types?.GENERATE_AFTER_DATA) {
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, boundOnGenerateAfterData);
    }

    if (boundOnGenerationStopped && event_types?.GENERATION_STOPPED) {
        eventSource.removeListener(event_types.GENERATION_STOPPED, boundOnGenerationStopped);
    }

    if (boundOnChatChanged && event_types?.CHAT_CHANGED) {
        eventSource.removeListener(event_types.CHAT_CHANGED, boundOnChatChanged);
    }

    if (boundOnMessageSwiped && event_types?.MESSAGE_SWIPED) {
        eventSource.removeListener(event_types.MESSAGE_SWIPED, boundOnMessageSwiped);
    }

    boundOnCharacterMessageRendered = null;
    boundOnMessageReceived = null;
    boundOnGenerationStarted = null;
    boundOnGenerateAfterData = null;
    boundOnGenerationStopped = null;
    boundOnChatChanged = null;
    boundOnMessageSwiped = null;
    usingCharacterMessageRenderedEvent = false;
    usingGenerateAfterDataEvent = false;
}

/**
 * Schedule automatic cleanup with short dedupe window to avoid
 * duplicate runs from nearby events.
 * Only one timer is ever pending at a time.
 * @param {number} messageIndex
 * @returns {void}
 */
function scheduleAutoCleanup(messageIndex) {
    const now = Date.now();
    const dedupeWindowMs = 500;

    if (lastScheduledCleanup.messageIndex === messageIndex && (now - lastScheduledCleanup.at) < dedupeWindowMs) {
        return;
    }

    lastScheduledCleanup = {
        messageIndex,
        at: now,
    };

    // Tie the run to the rendered message itself; indexes can shift before the timer fires.
    const { chat } = SillyTavern.getContext();
    const targetMessage = messageIndex >= 0 ? (chat?.[messageIndex] ?? null) : null;

    // Cancel any previously pending timer before scheduling a new one
    if (autoCleanupTimerId !== null) {
        clearTimeout(autoCleanupTimerId);
    }

    autoCleanupTimerId = setTimeout(() => {
        autoCleanupTimerId = null;
        processLastMessageLocked(false, targetMessage).catch((error) => {
            console.warn(`[${extensionName}] Auto-clean failed`, error);
        });
    }, 50);
}

/**
 * Handler for message-rendered lifecycle event.
 * This runs after the UI has rendered, preventing stale/blank message text.
 * @param {number} messageIndex - Index of the received message
 * @param {string|undefined} type - ST generation type, when supplied by the event
 */
function onCharacterMessageRendered(messageIndex, type) {
    const settings = getSettings();

    // Check if auto-clean is enabled
    if (!settings || !settings.enabled) {
        return;
    }

    const { chat } = SillyTavern.getContext();

    // Validate message index
    if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= chat.length) {
        // If messageIndex is not valid, just process the last message.
        scheduleAutoCleanup(-1);
        return;
    }

    const message = chat[messageIndex];

    // Only process AI messages
    if (message.is_user === true) {
        return;
    }

    if (!handleCompletedSwipe(messageIndex, type)) {
        scheduleAutoCleanup(messageIndex);
    }
}

/**
 * Register event listeners for message rendering events.
 * Cleans up existing listeners first to avoid duplicates.
 */
function registerEventListeners() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Clean up any existing listeners before re-registering
    cleanupExtension();

    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
        boundOnCharacterMessageRendered = onCharacterMessageRendered;
        usingCharacterMessageRenderedEvent = true;
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, boundOnCharacterMessageRendered);
    } else {
        boundOnMessageReceived = onCharacterMessageRendered;
        usingCharacterMessageRenderedEvent = false;
        eventSource.on(event_types.MESSAGE_RECEIVED, boundOnMessageReceived);
    }

    if (event_types?.GENERATION_STARTED) {
        boundOnGenerationStarted = onGenerationStarted;
        eventSource.on(event_types.GENERATION_STARTED, boundOnGenerationStarted);
    }

    // Without this event (older ST), generations are armed as soon as they start.
    if (event_types?.GENERATE_AFTER_DATA) {
        boundOnGenerateAfterData = onGenerateAfterData;
        usingGenerateAfterDataEvent = true;
        eventSource.on(event_types.GENERATE_AFTER_DATA, boundOnGenerateAfterData);
    }

    if (event_types?.GENERATION_STOPPED) {
        boundOnGenerationStopped = onGenerationStopped;
        eventSource.on(event_types.GENERATION_STOPPED, boundOnGenerationStopped);
    }

    if (event_types?.CHAT_CHANGED) {
        boundOnChatChanged = onChatChangedForExtension;
        eventSource.on(event_types.CHAT_CHANGED, boundOnChatChanged);
    }

    if (event_types?.MESSAGE_SWIPED) {
        boundOnMessageSwiped = onMessageSwiped;
        eventSource.on(event_types.MESSAGE_SWIPED, boundOnMessageSwiped);
    }
}

/**
 * Handle settings toggle change
 */
function onEnabledToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const enabled = $('#empty_response_cleaner_enabled').prop('checked');
    extensionSettings[extensionName].enabled = enabled;
    saveSettingsDebounced();

    if (!enabled) {
        // Cancel pending timer and remove listeners when extension is disabled
        cleanupExtension();
    } else {
        // Re-register listeners when extension is re-enabled
        registerEventListeners();
    }
}

/**
 * Handle auto-delete toggle change
 */
function onAutoDeleteToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const autoDelete = $('#empty_response_cleaner_auto_delete').prop('checked');
    extensionSettings[extensionName].autoDelete = autoDelete;
    saveSettingsDebounced();
}

/**
 * Handle manual clean button click
 */
async function onCleanLastMessageClick() {
    await processLastMessageLocked(true);
}

/**
 * Delete the last AI message from the chat regardless of content
 * @returns {Promise<boolean>} - True if a message was deleted
 */
async function deleteLastMessage() {
    const { chat } = SillyTavern.getContext();

    if (!chat || chat.length === 0) {
        toastr.warning('Chat is empty', 'Empty Response Cleaner');
        return false;
    }

    // Find the last AI message
    let lastAiMessageIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user === false) {
            lastAiMessageIndex = i;
            break;
        }
    }

    if (lastAiMessageIndex === -1) {
        toastr.warning('No AI message found', 'Empty Response Cleaner');
        return false;
    }

    if (chat.length <= 1) {
        toastr.warning('Cannot remove the only message in chat', 'Empty Response Cleaner');
        return false;
    }

    const deleted = await deleteViaApi(lastAiMessageIndex);
    if (!deleted) {
        return false;
    }

    log('Deleted last AI message via deleteMessage API', { messageIndex: lastAiMessageIndex });
    toastr.info('Deleted last AI message', 'Empty Response Cleaner');
    return true;
}

/**
 * Handle manual delete button click
 */
async function onDeleteLastMessageClick() {
    await deleteLastMessage();
}

/**
 * Create and inject the settings HTML
 */
function createSettingsUI() {
    const settings = getSettings();

    const settingsHtml = `
    <div id="empty_response_cleaner_settings" class="empty-response-cleaner-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Empty Response Cleaner</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="empty_response_cleaner_block">
                    <label class="checkbox_label" for="empty_response_cleaner_enabled">
                        <input type="checkbox" id="empty_response_cleaner_enabled" />
                        <span>Enable automatic empty response detection</span>
                    </label>
                </div>
                <div class="empty_response_cleaner_block">
                    <label class="checkbox_label" for="empty_response_cleaner_auto_delete">
                        <input type="checkbox" id="empty_response_cleaner_auto_delete" />
                        <span>Automatically clean empty responses (swipes + fully empty messages)</span>
                    </label>
                </div>
                <hr class="sysHR" />
                <div class="empty_response_cleaner_block">
                    <label class="checkbox_label" for="empty_response_cleaner_retry_api_errors">
                        <input type="checkbox" id="empty_response_cleaner_retry_api_errors" />
                        <span>Automatically retry API errors and empty swipes</span>
                    </label>
                    <div class="empty_response_cleaner_hint">
                        Retries empty or whitespace-only generated swipes, rate limits (429), 408/425, 5xx errors, timeouts, network failures, HTML error pages from proxies or gateways, and unspecified API errors using the same limit and delay. Existing responses are kept. Authentication, quota, bad-request, and moderation errors are not retried.
                    </div>
                </div>
                <div class="empty_response_cleaner_block empty_response_cleaner_setting_row">
                    <label for="empty_response_cleaner_max_retries">Max retries</label>
                    <input class="text_pole" type="number" id="empty_response_cleaner_max_retries" min="0" max="10" step="1" />
                </div>
                <div class="empty_response_cleaner_block empty_response_cleaner_setting_row">
                    <label for="empty_response_cleaner_retry_delay">Initial retry delay (seconds)</label>
                    <input class="text_pole" type="number" id="empty_response_cleaner_retry_delay" min="0.25" max="60" step="0.25" />
                </div>
                <div class="empty_response_cleaner_block">
                    <div class="menu_button menu_button_icon" id="empty_response_cleaner_clean_btn">
                        <i class="fa-solid fa-broom"></i>
                        <span>Clean Last Message</span>
                    </div>
                </div>
                <div class="empty_response_cleaner_block">
                    <div class="menu_button menu_button_icon" id="empty_response_cleaner_delete_btn">
                        <i class="fa-solid fa-trash"></i>
                        <span>Delete Last AI Message</span>
                    </div>
                </div>
                <hr class="sysHR" />
            </div>
        </div>
    </div>`;

    // Append to extensions settings
    $('#extensions_settings').append(settingsHtml);

    // Set initial state
    $('#empty_response_cleaner_enabled').prop('checked', settings?.enabled ?? true);
    $('#empty_response_cleaner_auto_delete').prop('checked', settings?.autoDelete ?? true);
    $('#empty_response_cleaner_retry_api_errors').prop('checked', settings?.retryOnApiError ?? true);
    $('#empty_response_cleaner_max_retries').val(getMaxRetries());
    $('#empty_response_cleaner_retry_delay').val(getRetryDelayMs() / 1000);

    // Bind event handlers
    $('#empty_response_cleaner_enabled').on('change', onEnabledToggle);
    $('#empty_response_cleaner_auto_delete').on('change', onAutoDeleteToggle);
    $('#empty_response_cleaner_retry_api_errors').on('change', onRetryToggle);
    $('#empty_response_cleaner_max_retries').on('change', onMaxRetriesChange);
    $('#empty_response_cleaner_retry_delay').on('change', onRetryDelayChange);
    $('#empty_response_cleaner_clean_btn').on('click', onCleanLastMessageClick);
    $('#empty_response_cleaner_delete_btn').on('click', onDeleteLastMessageClick);
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    // Load settings
    loadSettings();

    // Create settings UI
    createSettingsUI();

    // Observe generation API requests so transient failures can be retried.
    installFetchInterceptor();

    // Register message, generation, and chat lifecycle listeners.
    registerEventListeners();

    console.log(`[${extensionName}] Extension loaded`);
});
