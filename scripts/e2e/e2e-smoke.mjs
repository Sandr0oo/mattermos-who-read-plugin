#!/usr/bin/env node
/**
 * E2E smoke test for who-read-plugin.
 *
 * Prerequisites:
 *   - Mattermost 9 running on http://localhost:8065 (docker-compose.mattermost9.yml)
 *   - Plugin installed and enabled
 *   - Users: admin@example.com/AdminPass123!, alice@example.com/Password123!, bob@example.com/Password123!
 *
 * Usage (from host, browser tests use Playwright Docker):
 *   node scripts/e2e/e2e-smoke.mjs
 *
 * Or with custom URL:
 *   MM_URL=http://localhost:8065 node scripts/e2e/e2e-smoke.mjs
 *
 * To run only API tests (no browser):
 *   NO_BROWSER=1 node scripts/e2e/e2e-smoke.mjs
 */

import {execFileSync, execSync} from 'child_process';
import {fileURLToPath} from 'url';

const MM_URL = process.env.MM_URL || 'http://localhost:8065';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'AdminPass123!';
const ALICE_EMAIL = 'alice@example.com';
const ALICE_PASS = 'Password123!';
const BOB_EMAIL = 'bob@example.com';
const BOB_PASS = 'Password123!';
const PLUGIN_ID = 'com.mattermost.who-read-plugin';
const NO_BROWSER = process.env.NO_BROWSER === '1';
const SAVE_TIMEOUT_MS = 15000;
const E2E_DIR = fileURLToPath(new URL('.', import.meta.url));
const KNOWN_CONFIG_KEY_ALIASES = [
    ['readReceiptMode', 'readreceiptmode'],
    ['mirrorEmojiName', 'mirroremojiname'],
    ['mirrorReactionsEnabled', 'mirrorreactionsenabled'],
    ['hideMirrorReactionsInWeb', 'hidemirrorreactionsinweb'],
    ['fallbackToStandardEyes', 'fallbacktostandardeyes'],
    ['showReaderNames', 'showreadernames'],
    ['retentionDays', 'retentiondays'],
    ['maxReadersPerPost', 'maxreadersperpost'],
];
const SERVER_SIDE_READ_RECEIPT_CONFIG = {
    readReceiptMode: 'hybrid_server',
    mirrorEmojiName: 'eyes',
    fallbackToStandardEyes: true,
    mirrorReactionsEnabled: true,
    hideMirrorReactionsInWeb: false,
    showReaderNames: true,
};

const results = [];
let stepNum = 0;

function logStep(name) {
    stepNum++;
    console.log(`\n--- Step ${stepNum}: ${name} ---`);
}

function recordResult(name, passed, details = '') {
    const status = passed ? 'PASS' : 'FAIL';
    const line = `[${status}] ${name}`;
    console.log(line);
    if (details) {
        console.log(`       ${details}`);
    }
    results.push({name, passed, details, step: stepNum});
}

function truncate(value, maxLength = 500) {
    const text = String(value ?? '');
    return text.length > maxLength ? text.substring(0, maxLength) + '…' : text;
}

async function readResponseBody(resp) {
    const text = await resp.text();
    if (!text) {
        return {data: null, text: ''};
    }
    try {
        return {data: JSON.parse(text), text};
    } catch {
        return {data: text, text};
    }
}

function formatHttpDetails(status, bodyText) {
    return `status=${status}, body=${truncate(bodyText || '<empty>')}`;
}

function formatExecError(err) {
    const parts = [err.message];
    const stdout = err.stdout?.toString().trim();
    const stderr = err.stderr?.toString().trim();
    if (stdout) {
        parts.push(`stdout: ${stdout}`);
    }
    if (stderr) {
        parts.push(`stderr: ${stderr}`);
    }
    return truncate(parts.join(' | '), 1000);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {...options, signal: controller.signal});
        clearTimeout(timeout);
        return resp;
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

async function loginViaApi(email, password) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/users/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({login_id: email, password}),
    });
    if (!resp.ok) {
        throw new Error(`Login failed for ${email}: ${resp.status}`);
    }
    const token = resp.headers.get('Token');
    const user = await resp.json();
    if (!token) {
        throw new Error(`No token in login response for ${email}`);
    }
    return {token, userId: user.id, username: user.username};
}

async function getPluginConfigViaApi(token) {
    const resp = await fetchWithTimeout(`${MM_URL}/plugins/${PLUGIN_ID}/api/v1/config`, {
        headers: {Authorization: `Bearer ${token}`},
    });
    if (!resp.ok) {
        throw new Error(`GET /api/v1/config failed: ${resp.status}`);
    }
    return resp.json();
}

async function getSystemPluginConfig(token) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/config`, {
        headers: {Authorization: `Bearer ${token}`},
    });
    if (!resp.ok) {
        throw new Error(`GET /api/v4/config failed: ${resp.status}`);
    }
    const config = await resp.json();
    return config.PluginSettings?.Plugins?.[PLUGIN_ID] || {};
}

function getEffectivePersistedReadReceiptMode(pluginConfig = {}) {
    return pluginConfig.readreceiptmode ?? pluginConfig.readReceiptMode;
}

function getPersistedReadReceiptModeKeys(pluginConfig = {}) {
    return {
        readreceiptmode: pluginConfig.readreceiptmode ?? null,
        readReceiptMode: pluginConfig.readReceiptMode ?? null,
    };
}

function withKnownConfigKeyAliases(pluginConfig = {}) {
    const normalizedConfig = {...pluginConfig};
    // Mattermost System Console may persist lowercase keys; the lowercase key wins at runtime, so keep aliases synchronized.
    for (const [camelCaseKey, lowercaseKey] of KNOWN_CONFIG_KEY_ALIASES) {
        const value = normalizedConfig[lowercaseKey] ?? normalizedConfig[camelCaseKey];
        if (value !== undefined) {
            normalizedConfig[lowercaseKey] = value;
            normalizedConfig[camelCaseKey] = value;
        }
    }

    return normalizedConfig;
}

async function waitForPluginRuntimeMode(token, targetMode, timeoutMs = 10000) {
    const startedAt = Date.now();
    let lastConfig = {};
    let lastError = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            lastConfig = await getPluginConfigViaApi(token);
            lastError = null;
            if (lastConfig.readReceiptMode === targetMode) {
                return {matched: true, config: lastConfig, elapsed: Date.now() - startedAt, error: null};
            }
        } catch (err) {
            lastError = err;
        }

        await new Promise((r) => setTimeout(r, 500));
    }

    return {matched: false, config: lastConfig, elapsed: Date.now() - startedAt, error: lastError};
}

async function waitForSystemPluginMode(token, targetMode, timeoutMs = 10000) {
    const startedAt = Date.now();
    let lastConfig = {};
    let lastError = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            lastConfig = await getSystemPluginConfig(token);
            lastError = null;
            if (getEffectivePersistedReadReceiptMode(lastConfig) === targetMode) {
                return {matched: true, config: lastConfig, elapsed: Date.now() - startedAt, error: null};
            }
        } catch (err) {
            lastError = err;
        }

        await new Promise((r) => setTimeout(r, 500));
    }

    return {matched: false, config: lastConfig, elapsed: Date.now() - startedAt, error: lastError};
}

async function restoreReadReceiptConfig(token, pluginConfig, fallbackMode = 'legacy_reactions') {
    const configToRestore = Object.keys(pluginConfig || {}).length > 0 ? pluginConfig : {readReceiptMode: fallbackMode};
    const targetMode = getEffectivePersistedReadReceiptMode(configToRestore) || fallbackMode;
    await patchPluginConfig(token, configToRestore);
    let runtimeResult = await waitForPluginRuntimeMode(token, targetMode, 10000);
    let systemResult = await waitForSystemPluginMode(token, targetMode, 10000);

    if (!runtimeResult.matched) {
        mmctlPluginDisable();
        await new Promise((r) => setTimeout(r, 2000));
        mmctlPluginEnable();
        await new Promise((r) => setTimeout(r, 2000));
        runtimeResult = await waitForPluginRuntimeMode(token, targetMode, 10000);
        systemResult = await waitForSystemPluginMode(token, targetMode, 10000);
    }

    return {runtimeResult, systemResult, targetMode};
}

async function patchPluginConfig(token, pluginConfig) {
    const normalizedPluginConfig = withKnownConfigKeyAliases(pluginConfig);
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/config/patch`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            PluginSettings: {
                Plugins: {
                    [PLUGIN_ID]: normalizedPluginConfig,
                },
            },
        }),
    }, 60000);
    if (!resp.ok) {
        throw new Error(`PATCH /api/v4/config/patch failed: ${resp.status}`);
    }
    return resp.json();
}

async function getTeamInfo(token) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/teams`, {
        headers: {Authorization: `Bearer ${token}`},
    });
    if (!resp.ok) {
        throw new Error(`GET /api/v4/teams failed: ${resp.status}`);
    }
    const teams = await resp.json();
    return teams[0];
}

async function getChannelInfo(token, teamId, channelName) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/teams/${teamId}/channels/name/${channelName}`, {
        headers: {Authorization: `Bearer ${token}`},
    });
    if (!resp.ok) {
        throw new Error(`GET channel info failed: ${resp.status}`);
    }
    return resp.json();
}

async function createPost(token, channelId, message) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/posts`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({channel_id: channelId, message}),
    });
    if (!resp.ok) {
        throw new Error(`Create post failed: ${resp.status}`);
    }
    return resp.json();
}

async function getPostReactions(token, postId) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/posts/${postId}/reactions`, {
        headers: {Authorization: `Bearer ${token}`},
    });
    const body = await readResponseBody(resp);
    return {ok: resp.ok, status: resp.status, ...body};
}

async function waitForEyesReaction(token, postId, userId, timeoutMs = 15000) {
    const startedAt = Date.now();
    let lastResponse = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastResponse = await getPostReactions(token, postId);
        if (lastResponse.ok && Array.isArray(lastResponse.data)) {
            const reaction = lastResponse.data.find((r) => r.emoji_name === 'eyes' && r.user_id === userId);
            if (reaction) {
                return {found: true, reaction, response: lastResponse, elapsed: Date.now() - startedAt};
            }
        }

        await new Promise((r) => setTimeout(r, 1000));
    }

    return {found: false, reaction: null, response: lastResponse, elapsed: Date.now() - startedAt};
}

async function viewChannel(token, userId, channelId) {
    const resp = await fetchWithTimeout(`${MM_URL}/api/v4/channels/members/${userId}/view`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({channel_id: channelId}),
    });
    const body = await readResponseBody(resp);
    return {ok: resp.ok, status: resp.status, ...body};
}

async function getReadersBatch(token, postIds) {
    const resp = await fetchWithTimeout(`${MM_URL}/plugins/${PLUGIN_ID}/api/v1/readers/batch`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({post_ids: postIds}),
    });
    const body = await readResponseBody(resp);
    return {ok: resp.ok, status: resp.status, ...body};
}

async function waitForReadersBatchIncludes(token, postId, userId, timeoutMs = 20000) {
    const startedAt = Date.now();
    let lastResponse = null;
    let lastPostReaders = null;
    let lastReader = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastResponse = await getReadersBatch(token, [postId]);
        lastPostReaders = lastResponse.data?.posts?.[postId] || null;
        const readers = Array.isArray(lastPostReaders?.readers) ? lastPostReaders.readers : [];
        lastReader = readers.find((reader) => reader.user_id === userId) || null;
        if (lastResponse.ok && Number(lastPostReaders?.count || 0) >= 1 && lastReader) {
            return {found: true, response: lastResponse, postReaders: lastPostReaders, reader: lastReader, elapsed: Date.now() - startedAt};
        }

        await new Promise((r) => setTimeout(r, 1000));
    }

    return {found: false, response: lastResponse, postReaders: lastPostReaders, reader: lastReader, elapsed: Date.now() - startedAt};
}

function mmctlPluginDisable() {
    try {
        execSync('DOCKER_HOST= docker --context rootless exec who-read-mm9 mmctl --local plugin disable ' + PLUGIN_ID, {
            encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
        });
        return true;
    } catch {
        return false;
    }
}

function mmctlPluginEnable() {
    try {
        execSync('DOCKER_HOST= docker --context rootless exec who-read-mm9 mmctl --local plugin enable ' + PLUGIN_ID, {
            encoding: 'utf-8', timeout: 60000, stdio: 'pipe',
        });
        return true;
    } catch {
        return false;
    }
}

async function runBrowserScript(browserScript, timeoutMs = 120000) {
    const fs = await import('fs');
    const tmpDir = fs.mkdtempSync('/tmp/e2e-browser-');
    const scriptPath = tmpDir + '/browser-test.mjs';
    fs.writeFileSync(scriptPath, browserScript);

    const playwrightNodeModulesPath = E2E_DIR + 'node_modules';
    const playwrightPackagePath = playwrightNodeModulesPath + '/playwright/package.json';
    const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
    const canRunBrowserHere = fs.existsSync(browserPath) && fs.existsSync(playwrightPackagePath);

    if (canRunBrowserHere) {
        fs.symlinkSync(playwrightNodeModulesPath, tmpDir + '/node_modules', 'dir');
    } else {
        fs.writeFileSync(tmpDir + '/package.json', JSON.stringify({
            private: true,
            type: 'module',
            dependencies: {
                playwright: '1.61.1',
            },
        }, null, 2));
    }

    try {
        return canRunBrowserHere
            ? execFileSync(process.execPath, [scriptPath], {
                encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe',
                env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath},
            })
            : execFileSync('docker', [
                '--context', 'rootless', 'run', '--rm', '--network=host', '--shm-size=2g',
                '-e', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
                '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
                '-v', `${tmpDir}:/app`, '-w', '/app',
                'mcr.microsoft.com/playwright:v1.61.1-noble',
                'sh', '-c', 'npm install --no-audit --no-fund --package-lock=false && node browser-test.mjs',
            ], {
                encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe',
                env: {...process.env, DOCKER_HOST: ''},
            });
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
}

function getBrowserResultLines(output) {
    return output.split('\n').filter((l) => l.startsWith('RESULT:'));
}

function printBrowserResultLines(lines) {
    for (const line of lines) {
        const [key, ...valueParts] = line.replace('RESULT:', '').split(':');
        const value = valueParts.join(':');
        console.log(`  browser: ${key} = ${value}`);
    }
}

function getBrowserResultValue(lines, key) {
    const prefix = `RESULT:${key}:`;
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.substring(prefix.length) : undefined;
}

async function runTests() {
    console.log(`E2E smoke test for ${PLUGIN_ID}`);
    console.log(`Mattermost URL: ${MM_URL}`);
    console.log(`Browser tests: ${NO_BROWSER ? 'disabled' : 'enabled'}`);

    const adminSession = await loginViaApi(ADMIN_EMAIL, ADMIN_PASS);
    const adminToken = adminSession.token;
    const initialSystemPluginConfig = await getSystemPluginConfig(adminToken);
    const initialRuntimeConfig = await getPluginConfigViaApi(adminToken).catch(() => ({}));
    const initialReadReceiptMode = getEffectivePersistedReadReceiptMode(initialSystemPluginConfig) || initialRuntimeConfig.readReceiptMode || 'legacy_reactions';

    // =====================================================
    // TEST 1: Plugin config API returns valid config
    // =====================================================
    logStep('Plugin config API returns valid config');
    try {
        const config = await getPluginConfigViaApi(adminToken);
        const hasMode = config.readReceiptMode !== undefined;
        recordResult(
            'GET /api/v1/config returns config with readReceiptMode',
            hasMode,
            `mode=${config.readReceiptMode}`,
        );
    } catch (err) {
        recordResult('GET /api/v1/config returns config with readReceiptMode', false, err.message);
    }

    // =====================================================
    // TEST 2: Save plugin settings via API — OnConfigurationChange check
    // =====================================================
    logStep('Save plugin settings via API — OnConfigurationChange check');

    try {
        // First reset to legacy_reactions via mmctl
        await patchPluginConfig(adminToken, {readReceiptMode: 'legacy_reactions'});
        await new Promise((r) => setTimeout(r, 500));
        mmctlPluginDisable();
        await new Promise((r) => setTimeout(r, 2000));
        mmctlPluginEnable();
        await new Promise((r) => setTimeout(r, 2000));

        let pluginConfig = await getPluginConfigViaApi(adminToken);
        recordResult(
            'Initial config: readReceiptMode=legacy_reactions after reset',
            pluginConfig.readReceiptMode === 'legacy_reactions',
            `mode=${pluginConfig.readReceiptMode}`,
        );

        // Now patch to hybrid_server WITHOUT reload
        await patchPluginConfig(adminToken, {readReceiptMode: 'hybrid_server'});
        await new Promise((r) => setTimeout(r, 2000));

        const systemConfig = await getSystemPluginConfig(adminToken);
        const effectiveSystemMode = getEffectivePersistedReadReceiptMode(systemConfig);
        recordResult(
            'System config reflects effective readReceiptMode=hybrid_server',
            effectiveSystemMode === 'hybrid_server',
            `effective=${effectiveSystemMode}, persisted_keys=${JSON.stringify(getPersistedReadReceiptModeKeys(systemConfig))}, ` +
                `system config: ${JSON.stringify(systemConfig)}`,
        );

        pluginConfig = await getPluginConfigViaApi(adminToken);
        const onConfigChangeTriggered = pluginConfig.readReceiptMode === 'hybrid_server';
        recordResult(
            'Plugin /api/v1/config reflects hybrid_server WITHOUT reload (OnConfigurationChange)',
            onConfigChangeTriggered,
            `plugin config: ${pluginConfig.readReceiptMode} (expected: hybrid_server)`,
        );

        if (!onConfigChangeTriggered) {
            // Verify: after disable/enable, config picks up
            mmctlPluginDisable();
            await new Promise((r) => setTimeout(r, 2000));
            mmctlPluginEnable();
            await new Promise((r) => setTimeout(r, 2000));
            pluginConfig = await getPluginConfigViaApi(adminToken);
            recordResult(
                'After disable/enable, plugin config reflects hybrid_server',
                pluginConfig.readReceiptMode === 'hybrid_server',
                `mode=${pluginConfig.readReceiptMode}`,
            );
        }
    } catch (err) {
        recordResult('Save plugin settings via API', false, err.message);
    }

    // =====================================================
    // TEST 3: POST /api/v4/plugins/:id/enable hangs
    // =====================================================
    logStep('POST /api/v4/plugins/:id/enable hang check');
    try {
        // Disable via mmctl first
        mmctlPluginDisable();
        await new Promise((r) => setTimeout(r, 2000));

        // Try to enable via REST API — measure time
        const startTime = Date.now();
        let enableViaApiSucceeded = false;
        try {
            const resp = await fetchWithTimeout(`${MM_URL}/api/v4/plugins/${PLUGIN_ID}/enable`, {
                method: 'POST',
                headers: {Authorization: `Bearer ${adminToken}`},
            }, 15000);
            enableViaApiSucceeded = resp.ok;
        } catch (err) {
            // Expected: timeout
        }
        const elapsed = Date.now() - startTime;

        recordResult(
            'POST /api/v4/plugins/:id/enable via REST API completes within 15s',
            enableViaApiSucceeded && elapsed < 15000,
            `succeeded=${enableViaApiSucceeded}, elapsed=${elapsed}ms`,
        );

        if (!enableViaApiSucceeded) {
            // Re-enable via mmctl
            mmctlPluginEnable();
            await new Promise((r) => setTimeout(r, 2000));
        }
    } catch (err) {
        recordResult('POST /api/v4/plugins/:id/enable hang check', false, err.message);
        // Ensure plugin is enabled
        mmctlPluginEnable();
        await new Promise((r) => setTimeout(r, 2000));
    }

    // =====================================================
    // TEST 4: Legacy reactions — Alice posts, Bob views, :eyes: appears
    // =====================================================
    logStep('Legacy reactions: Alice posts, Bob views, :eyes: appears');

    try {
        // Reset to legacy_reactions
        await patchPluginConfig(adminToken, {readReceiptMode: 'legacy_reactions'});
        mmctlPluginDisable();
        await new Promise((r) => setTimeout(r, 2000));
        mmctlPluginEnable();
        await new Promise((r) => setTimeout(r, 2000));

        const aliceSession = await loginViaApi(ALICE_EMAIL, ALICE_PASS);
        const bobSession = await loginViaApi(BOB_EMAIL, BOB_PASS);
        const team = await getTeamInfo(adminToken);
        const channel = await getChannelInfo(adminToken, team.id, 'town-square');

        const testMessage = `E2E test ${Date.now()}`;
        const post = await createPost(aliceSession.token, channel.id, testMessage);

        recordResult(
            'Alice can post a message in town-square',
            post.id !== undefined,
            `post id: ${post.id}`,
        );

        if (post.id) {
            // Bob views the channel to trigger :eyes: reaction
            const viewed = await viewChannel(bobSession.token, bobSession.userId, channel.id);
            recordResult(
                'Bob views channel via API (diagnostic)',
                NO_BROWSER ? viewed.ok : true,
                formatHttpDetails(viewed.status, viewed.text),
            );

            await new Promise((r) => setTimeout(r, 5000));

            // Check reactions via API
            const reactionsResp = await getPostReactions(aliceSession.token, post.id);
            if (!reactionsResp.ok || !Array.isArray(reactionsResp.data)) {
                const receivedType = reactionsResp.data === null ? 'null' : typeof reactionsResp.data;
                recordResult(
                    ':eyes: API-only diagnostic after Bob channel view',
                    !NO_BROWSER,
                    `GET reactions expected array, got ${receivedType}; ${formatHttpDetails(reactionsResp.status, reactionsResp.text)}` +
                        (NO_BROWSER ? '' : '; non-blocking because browser legacy check follows'),
                );
            } else {
                const reactions = reactionsResp.data;
                const eyesReaction = reactions.find((r) => r.emoji_name === 'eyes' && r.user_id === bobSession.userId);

                recordResult(
                    ':eyes: API-only diagnostic after Bob channel view',
                    Boolean(eyesReaction) || !NO_BROWSER,
                    eyesReaction
                        ? `reaction by user ${eyesReaction.user_id}, emoji: ${eyesReaction.emoji_name}`
                        : `no :eyes: reaction from Bob found among ${reactions.length} reactions; ` +
                            `${formatHttpDetails(reactionsResp.status, reactionsResp.text)}` +
                            (NO_BROWSER ? '' : '; non-blocking because legacy mode requires webapp JS'),
                );

                if (!eyesReaction && NO_BROWSER) {
                    recordResult(
                        'NOTE: :eyes: requires webapp JS — run with browser tests for full check',
                        false,
                        'Legacy mode uses webapp JS to add reactions, not server-side. API-only test cannot verify.',
                    );
                }
            }
        }
    } catch (err) {
        recordResult('Legacy reactions: Alice posts, Bob views', false, err.message);
    }

    // =====================================================
    // TEST 5 (browser): Legacy reactions — Bob browser view adds :eyes:
    // =====================================================
    if (!NO_BROWSER) {
        logStep('Legacy reactions: Bob browser view adds :eyes:');

        try {
            await patchPluginConfig(adminToken, {readReceiptMode: 'legacy_reactions'});
            await new Promise((r) => setTimeout(r, 1000));

            const aliceSession = await loginViaApi(ALICE_EMAIL, ALICE_PASS);
            const bobSession = await loginViaApi(BOB_EMAIL, BOB_PASS);
            const team = await getTeamInfo(adminToken);
            const channel = await getChannelInfo(adminToken, team.id, 'town-square');

            const testMessage = `E2E browser legacy ${Date.now()}`;
            const post = await createPost(aliceSession.token, channel.id, testMessage);

            recordResult(
                'Alice can post a browser legacy test message in town-square',
                post.id !== undefined,
                `post id: ${post.id}`,
            );

            if (post.id) {
                const browserScript = `
import {chromium} from 'playwright';

const MM_URL = ${JSON.stringify(MM_URL)};
const TOKEN = ${JSON.stringify(bobSession.token)};
const USER_ID = ${JSON.stringify(bobSession.userId)};
const TEAM_NAME = ${JSON.stringify(team.name)};
const CHANNEL_NAME = 'town-square';
const TEST_MESSAGE = ${JSON.stringify(testMessage)};

async function bypassLanding(page, label) {
    const viewInBrowser = page.getByText('View in Browser', {exact: true}).first();
    const landingTextCount = await page.getByText('Where would you like to view this?', {exact: false}).count().catch(() => 0);
    const viewButtonCount = await page.getByText('View in Browser', {exact: true}).count().catch(() => 0);
    const isLanding = page.url().includes('/landing') || landingTextCount > 0 || viewButtonCount > 0;

    if (!isLanding) {
        console.log('RESULT:landing_bypass:' + label + ':not_needed:' + page.url());
        return;
    }

    await viewInBrowser.waitFor({timeout: 15000});
    await Promise.all([
        page.waitForURL((url) => !url.pathname.includes('/landing'), {timeout: 15000}).catch(() => null),
        viewInBrowser.click({timeout: 10000}),
    ]);
    await page.waitForLoadState('networkidle', {timeout: 30000}).catch(() => null);
    await page.waitForTimeout(1000);
    console.log('RESULT:landing_bypass:' + label + ':clicked:' + page.url());
}

async function run() {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    await context.addCookies([
        {name: 'MMUSERID', value: USER_ID, url: MM_URL},
        {name: 'MMAUTHTOKEN', value: TOKEN, url: MM_URL},
        {name: 'MMCSRF', value: TOKEN, url: MM_URL},
    ]);
    const page = await context.newPage();

    try {
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                console.log('RESULT:console_error:' + msg.text().substring(0, 200));
            }
        });

        await page.goto(MM_URL + '/' + TEAM_NAME + '/channels/' + CHANNEL_NAME, {
            waitUntil: 'networkidle', timeout: 30000,
        });
        await page.waitForTimeout(1000);
        await bypassLanding(page, 'channel');
        await page.waitForURL((url) => url.pathname.includes('/channels/' + CHANNEL_NAME), {
            timeout: 15000,
        }).catch(() => null);

        let channelReady = false;
        try {
            await page.waitForSelector('#post-list, .post-list-holder-by-time, .post-list__table, [data-testid="postView"], #app-content, .app__body', {
                timeout: 30000,
            });
            channelReady = true;
        } catch (err) {
            console.log('RESULT:channel_ready_error:' + err.message.substring(0, 200));
        }

        let messageVisible = false;
        try {
            await page.getByText(TEST_MESSAGE, {exact: false}).first().waitFor({timeout: 20000});
            messageVisible = true;
        } catch {
            messageVisible = false;
        }

        console.log('RESULT:channel_url:' + page.url());
        console.log('RESULT:channel_ready:' + (channelReady ? 'found' : 'not_found'));
        console.log('RESULT:message_visible:' + (messageVisible ? 'found' : 'not_found'));
        await page.waitForTimeout(8000);
    } finally {
        await page.close();
        await context.close();
        await browser.close();
    }
}

run().catch((err) => {
    console.error('Browser legacy test error:', err.message);
    process.exit(1);
});
`;

                const output = await runBrowserScript(browserScript, 120000);
                const lines = getBrowserResultLines(output);
                printBrowserResultLines(lines);

                const channelResult = lines.find((l) => l.startsWith('RESULT:channel_ready:'));
                const channelUrlResult = lines.find((l) => l.startsWith('RESULT:channel_url:'));
                const messageResult = lines.find((l) => l.startsWith('RESULT:message_visible:'));
                recordResult(
                    'Bob browser opens town-square channel',
                    channelResult?.endsWith(':found') || false,
                    [
                        channelUrlResult?.replace('RESULT:', '') || 'channel_url:no_result',
                        channelResult?.replace('RESULT:', '') || 'channel_ready:no_result',
                        messageResult?.replace('RESULT:', '') || 'message_visible:no_result',
                    ].join('; '),
                );

                const eyesResult = await waitForEyesReaction(aliceSession.token, post.id, bobSession.userId, 15000);
                const lastResponse = eyesResult.response;
                let details;
                if (eyesResult.found) {
                    details = `reaction by user ${eyesResult.reaction.user_id}, emoji: ${eyesResult.reaction.emoji_name}, elapsed=${eyesResult.elapsed}ms`;
                } else if (!lastResponse?.ok || !Array.isArray(lastResponse?.data)) {
                    const receivedType = lastResponse?.data === null ? 'null' : typeof lastResponse?.data;
                    details = `GET reactions expected array, got ${receivedType}; ` +
                        formatHttpDetails(lastResponse?.status || 'n/a', lastResponse?.text || '<no response>');
                } else {
                    details = `no :eyes: reaction from Bob found among ${lastResponse.data.length} reactions after ${eyesResult.elapsed}ms; ` +
                        formatHttpDetails(lastResponse.status, lastResponse.text);
                }

                recordResult(
                    ':eyes: reaction appears on Alice post after Bob browser view',
                    eyesResult.found,
                    details,
                );
            }
        } catch (err) {
            recordResult('Legacy browser :eyes: scenario', false, formatExecError(err));
        }
    }

    // =====================================================
    // TEST 6 (browser): Server-side read receipts — Bob browser view writes read-state and shows indicator
    // =====================================================
    if (!NO_BROWSER) {
        logStep('Server-side read receipts: Bob browser view writes read-state and shows indicator');

        try {
            await patchPluginConfig(adminToken, SERVER_SIDE_READ_RECEIPT_CONFIG);

            const systemResult = await waitForSystemPluginMode(adminToken, 'hybrid_server', 10000);
            const runtimeResult = await waitForPluginRuntimeMode(adminToken, 'hybrid_server', 10000);
            const runtimeConfig = runtimeResult.config || {};
            const runtimeMirrorConfigOk = runtimeConfig.mirrorEmojiName === 'eyes' &&
                runtimeConfig.fallbackToStandardEyes === true &&
                runtimeConfig.mirrorReactionsEnabled === true &&
                runtimeConfig.hideMirrorReactionsInWeb === false &&
                runtimeConfig.showReaderNames === true;
            const serverConfigReady = Boolean(systemResult.matched && runtimeResult.matched && runtimeMirrorConfigOk);

            recordResult(
                'Config patch enables hybrid_server with server-side read receipt options',
                serverConfigReady,
                `system_matched=${systemResult.matched}, runtime_matched=${runtimeResult.matched}, ` +
                    `runtime=${JSON.stringify(runtimeConfig)}, system_keys=${JSON.stringify(getPersistedReadReceiptModeKeys(systemResult.config))}`,
            );

            const aliceSession = await loginViaApi(ALICE_EMAIL, ALICE_PASS);
            const bobSession = await loginViaApi(BOB_EMAIL, BOB_PASS);
            const team = await getTeamInfo(adminToken);
            const channel = await getChannelInfo(adminToken, team.id, 'town-square');

            const testMessage = `E2E server read receipt ${Date.now()}`;
            const post = await createPost(aliceSession.token, channel.id, testMessage);

            recordResult(
                'Alice can post a server read receipt test message in town-square',
                post.id !== undefined,
                `post id: ${post.id}`,
            );

            if (post.id) {
                const browserScript = `
import {chromium} from 'playwright';

const MM_URL = ${JSON.stringify(MM_URL)};
const TOKEN = ${JSON.stringify(bobSession.token)};
const USER_ID = ${JSON.stringify(bobSession.userId)};
const TEAM_NAME = ${JSON.stringify(team.name)};
const CHANNEL_NAME = 'town-square';
const TEST_MESSAGE = ${JSON.stringify(testMessage)};
const POST_ID = ${JSON.stringify(post.id)};
const READ_STATE_PATH = '/plugins/${PLUGIN_ID}/api/v1/read-state';

function safeResult(value, maxLength = 250) {
    return String(value ?? '').replace(/\\s+/g, ' ').substring(0, maxLength);
}

async function bypassLanding(page, label) {
    const viewInBrowser = page.getByText('View in Browser', {exact: true}).first();
    const landingTextCount = await page.getByText('Where would you like to view this?', {exact: false}).count().catch(() => 0);
    const viewButtonCount = await page.getByText('View in Browser', {exact: true}).count().catch(() => 0);
    const isLanding = page.url().includes('/landing') || landingTextCount > 0 || viewButtonCount > 0;

    if (!isLanding) {
        console.log('RESULT:landing_bypass:' + label + ':not_needed:' + page.url());
        return;
    }

    await viewInBrowser.waitFor({timeout: 15000});
    await Promise.all([
        page.waitForURL((url) => !url.pathname.includes('/landing'), {timeout: 15000}).catch(() => null),
        viewInBrowser.click({timeout: 10000}),
    ]);
    await page.waitForLoadState('networkidle', {timeout: 30000}).catch(() => null);
    await page.waitForTimeout(1000);
    console.log('RESULT:landing_bypass:' + label + ':clicked:' + page.url());
}

function parseReadStatePostId(body) {
    try {
        return JSON.parse(body || '{}').last_read_post_id || 'missing';
    } catch {
        return 'invalid_json';
    }
}

function indicatorPass(result) {
    if (!result || !result.found) {
        return false;
    }
    const textOk = /^✓\\s*[1-9]\\d*/.test(result.text || '');
    const label = String(result.title || '') + ' ' + String(result.aria || '');
    return textOk && label.includes('Прочитали');
}

async function findIndicatorOnPage(page) {
    return page.evaluate(({testMessage}) => {
        function clean(value) {
            return String(value || '').replace(/\\s+/g, ' ').trim();
        }

        function info(indicator, scopedBy) {
            return {
                found: true,
                text: clean(indicator.textContent),
                title: clean(indicator.getAttribute('title')),
                aria: clean(indicator.getAttribute('aria-label')),
                scopedBy,
            };
        }

        function infoFromRoot(root, scopedBy) {
            if (!root || !root.querySelector) {
                return null;
            }
            const indicator = root.querySelector('.who-read-readers');
            return indicator ? info(indicator, scopedBy) : null;
        }

        const roots = [];
        const rootSelectors = [
            '[data-testid="postView"]',
            '.post',
            '.post-list__item',
            '[id^="post_"]',
            '[id^="postListContent_"]',
        ];
        for (const selector of rootSelectors) {
            for (const element of Array.from(document.querySelectorAll(selector))) {
                if (String(element.textContent || '').includes(testMessage)) {
                    roots.push(element);
                }
            }
        }
        roots.sort((a, b) => String(a.textContent || '').length - String(b.textContent || '').length);
        for (const root of roots) {
            const result = infoFromRoot(root, 'post_root');
            if (result) {
                return result;
            }
        }

        const messageElements = Array.from(document.querySelectorAll('[id^="postMessageText_"], .post-message__text, .post__body, div, span, p'))
            .filter((element) => String(element.textContent || '').includes(testMessage))
            .sort((a, b) => String(a.textContent || '').length - String(b.textContent || '').length);
        for (const messageElement of messageElements) {
            let node = messageElement;
            for (let depth = 0; node && depth < 6; depth++) {
                const result = infoFromRoot(node, 'message_ancestor_' + depth);
                if (result) {
                    return result;
                }
                node = node.parentElement;
            }
        }

        const allIndicators = Array.from(document.querySelectorAll('.who-read-readers'));
        return {
            found: false,
            text: allIndicators.slice(0, 5).map((indicator) => clean(indicator.textContent)).join('|'),
            title: allIndicators.slice(0, 5).map((indicator) => clean(indicator.getAttribute('title'))).join('|'),
            aria: allIndicators.slice(0, 5).map((indicator) => clean(indicator.getAttribute('aria-label'))).join('|'),
            scopedBy: 'not_scoped',
            allIndicatorCount: allIndicators.length,
        };
    }, {testMessage: TEST_MESSAGE});
}

async function waitForIndicator(page, timeoutMs = 30000) {
    const startedAt = Date.now();
    let lastResult = null;
    while (Date.now() - startedAt < timeoutMs) {
        lastResult = await findIndicatorOnPage(page);
        if (indicatorPass(lastResult)) {
            lastResult.elapsed = Date.now() - startedAt;
            return lastResult;
        }

        await page.waitForTimeout(1000);
    }

    return {...(lastResult || {found: false}), elapsed: Date.now() - startedAt};
}

async function waitForReadStateResponse(readStateResponses, timeoutMs = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (readStateResponses.length > 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

async function run() {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    await context.addCookies([
        {name: 'MMUSERID', value: USER_ID, url: MM_URL},
        {name: 'MMAUTHTOKEN', value: TOKEN, url: MM_URL},
        {name: 'MMCSRF', value: TOKEN, url: MM_URL},
    ]);
    const page = await context.newPage();

    try {
        const errors = [];
        const readStateRequests = [];
        const readStateResponses = [];

        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                errors.push(msg.text());
            }
        });
        page.on('request', (request) => {
            try {
                const url = request.url();
                if (request.method() === 'POST' && url.includes(READ_STATE_PATH)) {
                    readStateRequests.push(request.postData() || '');
                }
            } catch {
                // Best-effort diagnostic only.
            }
        });
        page.on('response', (response) => {
            try {
                const request = response.request();
                const url = response.url();
                if (request.method() === 'POST' && url.includes(READ_STATE_PATH)) {
                    readStateResponses.push(String(response.status()));
                }
            } catch {
                // Best-effort diagnostic only.
            }
        });

        await page.goto(MM_URL + '/' + TEAM_NAME + '/channels/' + CHANNEL_NAME, {
            waitUntil: 'networkidle', timeout: 30000,
        });
        await page.waitForTimeout(1000);
        await bypassLanding(page, 'channel');
        await page.waitForURL((url) => url.pathname.includes('/channels/' + CHANNEL_NAME), {
            timeout: 15000,
        }).catch(() => null);

        let channelReady = false;
        try {
            await page.waitForSelector('#post-list, .post-list-holder-by-time, .post-list__table, [data-testid="postView"], #app-content, .app__body', {
                timeout: 30000,
            });
            channelReady = true;
        } catch (err) {
            console.log('RESULT:channel_ready_error:' + safeResult(err.message));
        }

        let messageVisible = false;
        try {
            const message = page.getByText(TEST_MESSAGE, {exact: false}).first();
            await message.waitFor({timeout: 30000});
            await message.scrollIntoViewIfNeeded({timeout: 5000}).catch(() => null);
            messageVisible = true;
        } catch {
            messageVisible = false;
        }

        await waitForReadStateResponse(readStateResponses, 30000);
        const indicatorResult = await waitForIndicator(page, 30000);

        const readStatePostIds = readStateRequests.map(parseReadStatePostId);
        console.log('RESULT:channel_url:' + page.url());
        console.log('RESULT:channel_ready:' + (channelReady ? 'found' : 'not_found'));
        console.log('RESULT:message_visible:' + (messageVisible ? 'found' : 'not_found'));
        console.log('RESULT:read_state_request_count:' + readStateRequests.length);
        console.log('RESULT:read_state_post_ids:' + (readStatePostIds.length > 0 ? readStatePostIds.join('|') : 'not_observed'));
        console.log('RESULT:read_state_matching_post:' + (readStatePostIds.includes(POST_ID) ? 'found' : 'not_found'));
        console.log('RESULT:read_state_response_statuses:' + (readStateResponses.length > 0 ? readStateResponses.join('|') : 'not_observed'));
        console.log('RESULT:indicator_found:' + (indicatorPass(indicatorResult) ? 'found' : 'not_found'));
        console.log('RESULT:indicator_text:' + safeResult(indicatorResult.text));
        console.log('RESULT:indicator_title:' + safeResult(indicatorResult.title));
        console.log('RESULT:indicator_aria:' + safeResult(indicatorResult.aria));
        console.log('RESULT:indicator_scoped_by:' + safeResult(indicatorResult.scopedBy));
        console.log('RESULT:indicator_elapsed:' + safeResult(indicatorResult.elapsed));
        console.log('RESULT:indicator_all_count:' + safeResult(indicatorResult.allIndicatorCount || 0));
        console.log('RESULT:console_errors:' + errors.length);
        if (errors.length > 0) {
            errors.slice(0, 5).forEach((error) => console.log('RESULT:error:' + safeResult(error, 200)));
        }
    } finally {
        await page.close();
        await context.close();
        await browser.close();
    }
}

run().catch((err) => {
    console.error('Browser server-side read receipt test error:', err.message);
    process.exit(1);
});
`;

                const output = await runBrowserScript(browserScript, 150000);
                const lines = getBrowserResultLines(output);
                printBrowserResultLines(lines);

                const channelResult = getBrowserResultValue(lines, 'channel_ready');
                const channelUrlResult = getBrowserResultValue(lines, 'channel_url');
                const messageResult = getBrowserResultValue(lines, 'message_visible');
                recordResult(
                    'Bob browser opens town-square channel and sees fresh Alice post',
                    Boolean(channelResult === 'found' && messageResult === 'found'),
                    [
                        `channel_url:${channelUrlResult || 'no_result'}`,
                        `channel_ready:${channelResult || 'no_result'}`,
                        `message_visible:${messageResult || 'no_result'}`,
                    ].join('; '),
                );

                const readStateRequestCount = Number(getBrowserResultValue(lines, 'read_state_request_count') || 0);
                const readStatePostIds = getBrowserResultValue(lines, 'read_state_post_ids') || 'not_observed';
                const readStateMatchingPost = getBrowserResultValue(lines, 'read_state_matching_post') === 'found';
                const readStateResponseStatuses = getBrowserResultValue(lines, 'read_state_response_statuses') || 'not_observed';
                const readStateResponseOk = readStateResponseStatuses.split('|').includes('200');
                const readStateServerCallOk = Boolean(readStateRequestCount > 0 && readStateMatchingPost && readStateResponseOk);
                recordResult(
                    'Bob browser calls server POST /api/v1/read-state for Alice post',
                    readStateServerCallOk,
                    `requests=${readStateRequestCount}, post_ids=${readStatePostIds}, responses=${readStateResponseStatuses}`,
                );

                const readersResult = await waitForReadersBatchIncludes(aliceSession.token, post.id, bobSession.userId, 20000);
                const readersResp = readersResult.response;
                const postReaders = readersResult.postReaders;
                const readers = Array.isArray(postReaders?.readers) ? postReaders.readers : [];
                recordResult(
                    '/api/v1/readers/batch returns Bob in readers for Alice post',
                    readersResult.found,
                    readersResult.found
                        ? `count=${postReaders.count}, readers=${readers.map((reader) => reader.username || reader.user_id).join(',')}, elapsed=${readersResult.elapsed}ms`
                        : `count=${postReaders?.count ?? 'missing'}, readers=${JSON.stringify(readers)}, elapsed=${readersResult.elapsed}ms; ` +
                            formatHttpDetails(readersResp?.status || 'n/a', readersResp?.text || '<no response>'),
                );

                const indicatorFound = getBrowserResultValue(lines, 'indicator_found') === 'found';
                const indicatorText = getBrowserResultValue(lines, 'indicator_text') || '';
                const indicatorTitle = getBrowserResultValue(lines, 'indicator_title') || '';
                const indicatorAria = getBrowserResultValue(lines, 'indicator_aria') || '';
                const indicatorScopedBy = getBrowserResultValue(lines, 'indicator_scoped_by') || '';
                const indicatorTextOk = /^✓\s*[1-9]\d*/.test(indicatorText);
                const indicatorLabelOk = `${indicatorTitle} ${indicatorAria}`.includes('Прочитали');
                recordResult(
                    'Read receipt indicator appears on fresh Alice post',
                    Boolean(indicatorFound && indicatorTextOk && indicatorLabelOk),
                    `found=${indicatorFound}, text=${indicatorText || 'missing'}, title=${indicatorTitle || 'missing'}, ` +
                        `aria=${indicatorAria || 'missing'}, scoped_by=${indicatorScopedBy || 'missing'}, ` +
                        `elapsed=${getBrowserResultValue(lines, 'indicator_elapsed') || 'no_result'}ms`,
                );

                const eyesResult = await waitForEyesReaction(aliceSession.token, post.id, bobSession.userId, 15000);
                const lastResponse = eyesResult.response;
                let details;
                if (eyesResult.found) {
                    details = `reaction by user ${eyesResult.reaction.user_id}, emoji: ${eyesResult.reaction.emoji_name}, elapsed=${eyesResult.elapsed}ms`;
                } else if (!lastResponse?.ok || !Array.isArray(lastResponse?.data)) {
                    const receivedType = lastResponse?.data === null ? 'null' : typeof lastResponse?.data;
                    details = `GET reactions expected array, got ${receivedType}; ` +
                        formatHttpDetails(lastResponse?.status || 'n/a', lastResponse?.text || '<no response>');
                } else {
                    details = `no :eyes: reaction from Bob found among ${lastResponse.data.length} reactions after ${eyesResult.elapsed}ms; ` +
                        formatHttpDetails(lastResponse.status, lastResponse.text);
                }

                recordResult(
                    'Hybrid server mirror :eyes: reaction appears via API',
                    Boolean(serverConfigReady && readStateServerCallOk && eyesResult.found),
                    `server_config_ready=${serverConfigReady}, read_state_call_ok=${readStateServerCallOk}; ${details}`,
                );
            }
        } catch (err) {
            recordResult('Server-side read receipt browser scenario', false, formatExecError(err));
        } finally {
            try {
                const restoreResult = await restoreReadReceiptConfig(adminToken, initialSystemPluginConfig, initialReadReceiptMode);
                const runtimeMode = restoreResult.runtimeResult.config?.readReceiptMode;
                const systemMode = getEffectivePersistedReadReceiptMode(restoreResult.systemResult.config);
                recordResult(
                    'Restored initial read receipt config after server-side test',
                    Boolean(runtimeMode === restoreResult.targetMode && systemMode === restoreResult.targetMode),
                    `runtime=${runtimeMode || 'missing'}, system=${systemMode || 'missing'}, ` +
                        `target=${restoreResult.targetMode}, ` +
                        `runtime_wait=${restoreResult.runtimeResult.elapsed}ms, system_wait=${restoreResult.systemResult.elapsed}ms`,
                );
            } catch (err) {
                recordResult('Restored initial read receipt config after server-side test', false, err.message);
            }
        }
    }

    // =====================================================
    // TEST 7: Plugin status via API
    // =====================================================
    logStep('Plugin status via API');
    try {
        const resp = await fetchWithTimeout(`${MM_URL}/api/v4/plugins`, {
            headers: {Authorization: `Bearer ${adminToken}`},
        });
        const data = await resp.json();
        const activePlugins = data.active || [];
        const isActive = activePlugins.some((p) => p.id === PLUGIN_ID);
        recordResult(
            'Plugin is listed as active in API',
            isActive,
            `active plugins: ${activePlugins.map((p) => p.id).join(', ')}`,
        );
    } catch (err) {
        recordResult('Plugin status via API', false, err.message);
    }

    // =====================================================
    // TEST 8 (browser): System Console save settings
    // =====================================================
    if (!NO_BROWSER) {
        logStep('System Console: save plugin settings (browser)');
        const browserScript = `
import {chromium} from 'playwright';

const MM_URL = ${JSON.stringify(MM_URL)};
const TOKEN = ${JSON.stringify(adminToken)};
const USER_ID = ${JSON.stringify(adminSession.userId)};
const PLUGIN_ID = ${JSON.stringify(PLUGIN_ID)};
const SAVE_TIMEOUT_MS = ${JSON.stringify(SAVE_TIMEOUT_MS)};
const READ_RECEIPT_MODE_ID = ${JSON.stringify(`PluginSettings.Plugins.${PLUGIN_ID.replace(/\./g, '+')}.readreceiptmode`)};
const READ_RECEIPT_MODE_SELECTOR = 'select[id="' + READ_RECEIPT_MODE_ID + '"]';
const SAVE_BUTTON_SELECTOR = 'button:has-text("Save"), button:has-text("Сохранить")';
const SUCCESS_SELECTOR = '.alert-success, .banner__success, .BannerSuccess, .Toastify__toast--success, [class*="success" i]:has-text("saved"), [class*="success" i]:has-text("сохран")';
const PENDING_SELECTOR = '.spinner, .LoadingSpinner, .icon-loading, [class*="spinner" i], [class*="loading" i], [aria-busy="true"]';

async function visibleLocatorCount(page, selector) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    let visible = 0;
    for (let i = 0; i < count; i++) {
        if (await locator.nth(i).isVisible().catch(() => false)) {
            visible++;
        }
    }
    return visible;
}

async function getSaveButton(page) {
    const buttons = page.locator(SAVE_BUTTON_SELECTOR);
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        if (await button.isVisible().catch(() => false)) {
            return button;
        }
    }
    return count > 0 ? buttons.first() : null;
}

async function getButtonState(button) {
    if (!button) {
        return 'not_found';
    }

    const visible = await button.isVisible().catch(() => false);
    const enabled = await button.isEnabled().catch(() => false);
    return 'found_' + (visible ? 'visible' : 'hidden') + '_' + (enabled ? 'enabled' : 'disabled');
}

async function hasPendingState(page, saveButton) {
    const visiblePending = await visibleLocatorCount(page, PENDING_SELECTOR);
    const buttonPending = saveButton ? await saveButton.evaluate((button) => {
        const text = String(button.textContent || '').toLowerCase();
        const classes = String(button.className || '').toLowerCase();
        const ariaBusy = button.getAttribute('aria-busy') === 'true';
        const childPending = button.querySelector('.spinner, .LoadingSpinner, .icon-loading, [class*="spinner"], [class*="loading"], [aria-busy="true"]');
        return ariaBusy || Boolean(childPending) || classes.includes('loading') || classes.includes('saving') ||
            text.includes('saving') || text.includes('сохранение');
    }).catch(() => false) : false;

    return visiblePending > 0 || buttonPending;
}

async function waitForSaveOutcome(page, saveButton, startTime) {
    let sawPending = false;

    while (Date.now() - startTime < SAVE_TIMEOUT_MS) {
        const elapsed = Date.now() - startTime;
        const successVisible = await visibleLocatorCount(page, SUCCESS_SELECTOR) > 0;
        const pending = await hasPendingState(page, saveButton);
        const saveButtonDisabled = saveButton ? !(await saveButton.isEnabled().catch(() => false)) : false;
        sawPending = sawPending || pending;

        if (successVisible) {
            return {outcome: 'success_banner', elapsed};
        }

        if (saveButtonDisabled && !pending) {
            return {outcome: 'save_button_disabled', elapsed};
        }

        if (sawPending && !pending) {
            return {outcome: 'spinner_detached', elapsed};
        }

        if (!pending && elapsed >= 1500) {
            return {outcome: 'no_pending_state', elapsed};
        }

        await page.waitForTimeout(250);
    }

    const pending = await hasPendingState(page, saveButton);
    return {outcome: pending ? 'timeout_pending' : 'timeout_no_confirmation', elapsed: Date.now() - startTime};
}

async function bypassLanding(page, label) {
    const viewInBrowser = page.getByText('View in Browser', {exact: true}).first();
    const landingTextCount = await page.getByText('Where would you like to view this?', {exact: false}).count().catch(() => 0);
    const viewButtonCount = await page.getByText('View in Browser', {exact: true}).count().catch(() => 0);
    const isLanding = page.url().includes('/landing') || landingTextCount > 0 || viewButtonCount > 0;

    if (!isLanding) {
        console.log('RESULT:landing_bypass:' + label + ':not_needed:' + page.url());
        return;
    }

    await viewInBrowser.waitFor({timeout: 15000});
    await Promise.all([
        page.waitForURL((url) => !url.pathname.includes('/landing'), {timeout: 15000}).catch(() => null),
        viewInBrowser.click({timeout: 10000}),
    ]);
    await page.waitForLoadState('networkidle', {timeout: 30000}).catch(() => null);
    await page.waitForTimeout(1000);
    console.log('RESULT:landing_bypass:' + label + ':clicked:' + page.url());
}

async function run() {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    await context.addCookies([
        {name: 'MMUSERID', value: USER_ID, url: MM_URL},
        {name: 'MMAUTHTOKEN', value: TOKEN, url: MM_URL},
        {name: 'MMCSRF', value: TOKEN, url: MM_URL},
    ]);
    const page = await context.newPage();

    try {
        const errors = [];
        const saveResponses = [];
        const saveRequestModes = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('request', (request) => {
            try {
                const method = request.method();
                const url = request.url();
                if (method !== 'GET' && url.includes('/api/v4/config')) {
                    const body = request.postData() || '';
                    const matches = Array.from(body.matchAll(/"(readReceiptMode|readreceiptmode)"\s*:\s*"([^"]+)"/g));
                    saveRequestModes.push(matches.length > 0 ? matches.map((match) => match[1] + '=' + match[2]).join(',') : 'missing');
                }
            } catch {
                // Best-effort diagnostic only.
            }
        });
        page.on('response', (response) => {
            try {
                const request = response.request();
                const method = request.method();
                const url = response.url();
                if (method !== 'GET' && url.includes('/api/v4/config')) {
                    saveResponses.push(method + ':' + response.status() + ':' + new URL(url).pathname);
                }
            } catch {
                // Best-effort diagnostic only.
            }
        });

        const settingsUrl = MM_URL + '/admin_console/plugins/plugin_' + PLUGIN_ID;

        await page.goto(settingsUrl, {
            waitUntil: 'networkidle', timeout: 30000,
        });
        await page.waitForTimeout(1000);
        await bypassLanding(page, 'system_console');
        await page.goto(settingsUrl, {
            waitUntil: 'networkidle', timeout: 30000,
        });
        await page.waitForURL((url) => url.pathname.includes('/admin_console/plugins/plugin_' + PLUGIN_ID), {
            timeout: 15000,
        }).catch(() => null);
        await page.waitForSelector(READ_RECEIPT_MODE_SELECTOR, {
            timeout: 30000,
        }).catch(() => null);
        await page.waitForSelector(SAVE_BUTTON_SELECTOR, {
            timeout: 30000,
        }).catch(() => null);

        const modeSelect = page.locator(READ_RECEIPT_MODE_SELECTOR).first();
        const selectFound = await modeSelect.count().catch(() => 0) > 0;
        let saveButton = await getSaveButton(page);
        const saveButtonBeforeState = await getButtonState(saveButton);
        const panelLoaded = selectFound && saveButtonBeforeState !== 'not_found';

        console.log('RESULT:panel:' + (panelLoaded ? 'found' : 'not_found'));
        console.log('RESULT:settings_select:' + (selectFound ? 'found' : 'not_found'));
        console.log('RESULT:save_button_before:' + saveButtonBeforeState);

        if (!selectFound) {
            console.log('RESULT:save:not_clicked:select_not_found');
        } else if (!saveButton) {
            console.log('RESULT:save:not_clicked:save_button_not_found');
        } else {
            const initialMode = await modeSelect.inputValue();
            const optionValues = await modeSelect.locator('option').evaluateAll((options) => options.map((option) => option.value));
            const targetMode = ['hybrid_server', 'server_web_only'].find((mode) => mode !== initialMode && optionValues.includes(mode));
            console.log('RESULT:initial_mode:' + initialMode);
            console.log('RESULT:target_mode:' + (targetMode || 'not_found'));

            if (!targetMode) {
                console.log('RESULT:save:not_clicked:target_mode_not_found');
            } else {
                await modeSelect.focus();
                await modeSelect.selectOption(targetMode);
                await modeSelect.dispatchEvent('input', {bubbles: true});
                await modeSelect.dispatchEvent('change', {bubbles: true});
                await page.waitForFunction(({selector, target}) => document.querySelector(selector)?.value === target, {
                    selector: READ_RECEIPT_MODE_SELECTOR,
                    target: targetMode,
                }, {timeout: 5000}).catch(() => null);
                await modeSelect.evaluate((select) => select.blur()).catch(() => null);
                await page.waitForTimeout(1000);

                const selectedModeAfterChange = await modeSelect.inputValue().catch(() => 'unknown');
                saveButton = await getSaveButton(page);
                const saveButtonAfterChangeState = await getButtonState(saveButton);
                console.log('RESULT:selected_mode_after_change:' + selectedModeAfterChange);
                console.log('RESULT:save_button_after_change:' + saveButtonAfterChangeState);

                const saveButtonEnabled = saveButton ? await saveButton.isEnabled().catch(() => false) : false;
                if (selectedModeAfterChange !== targetMode) {
                    console.log('RESULT:save:not_clicked:select_value_not_changed');
                } else if (!saveButton || !saveButtonEnabled) {
                    console.log('RESULT:save:not_clicked:save_button_not_enabled_after_change');
                } else {
                    const startTime = Date.now();
                    await saveButton.click();
                    const saveOutcome = await waitForSaveOutcome(page, saveButton, startTime);
                    const saveButtonAfterState = await getButtonState(await getSaveButton(page));
                    console.log('RESULT:save:' + saveOutcome.outcome + ':clicked:' + saveOutcome.elapsed + 'ms');
                    console.log('RESULT:save_button_after:' + saveButtonAfterState);
                }
            }
        }

        await page.waitForTimeout(2000);
        console.log('RESULT:save_request_mode:' + (saveRequestModes.length > 0 ? saveRequestModes.join('|') : 'not_observed'));
        console.log('RESULT:save_response:' + (saveResponses.length > 0 ? saveResponses.join('|') : 'not_observed'));
        console.log('RESULT:console_errors:' + errors.length);
        if (errors.length > 0) {
            errors.slice(0, 5).forEach((e) => console.log('RESULT:error:' + e.substring(0, 200)));
        }
    } finally {
        await page.close();
        await context.close();
        await browser.close();
    }
}

run().catch((err) => {
    console.error('Browser test error:', err.message);
    process.exit(1);
});
`;

        try {
            const output = await runBrowserScript(browserScript, 120000);
            const lines = getBrowserResultLines(output);
            printBrowserResultLines(lines);

            const panelResult = getBrowserResultValue(lines, 'panel');
            const selectResult = getBrowserResultValue(lines, 'settings_select');
            const saveButtonBeforeResult = getBrowserResultValue(lines, 'save_button_before');
            recordResult(
                'Plugin settings page loads in System Console',
                Boolean(panelResult === 'found' && selectResult === 'found' && saveButtonBeforeResult?.startsWith('found')),
                [
                    `panel:${panelResult || 'no_result'}`,
                    `settings_select:${selectResult || 'no_result'}`,
                    `save_button_before:${saveButtonBeforeResult || 'no_result'}`,
                ].join('; '),
            );

            const targetMode = getBrowserResultValue(lines, 'target_mode');
            let persistedMode = undefined;
            let persistedKeysJson = '{}';
            let runtimeMode = undefined;
            let persistedConfigJson = '{}';
            let persistedElapsed = undefined;
            let persistedError = undefined;
            try {
                const persistedResult = targetMode && targetMode !== 'not_found'
                    ? await waitForSystemPluginMode(adminToken, targetMode, 10000)
                    : {config: await getSystemPluginConfig(adminToken), elapsed: 0, error: null};
                const runtimeConfig = await getPluginConfigViaApi(adminToken);
                persistedMode = getEffectivePersistedReadReceiptMode(persistedResult.config);
                persistedKeysJson = JSON.stringify(getPersistedReadReceiptModeKeys(persistedResult.config));
                persistedConfigJson = JSON.stringify(persistedResult.config);
                runtimeMode = runtimeConfig.readReceiptMode;
                persistedElapsed = persistedResult.elapsed;
                persistedError = persistedResult.error?.message;
                const persistedLines = [
                    `RESULT:persisted_config:${persistedMode || 'missing'}`,
                    `RESULT:persisted_config_keys:${persistedKeysJson}`,
                    `RESULT:persisted_config_json:${truncate(persistedConfigJson, 300)}`,
                    `RESULT:runtime_config:${runtimeMode || 'missing'}`,
                    `RESULT:persisted_config_wait:${persistedResult.matched ? 'matched' : 'not_matched'}:${persistedElapsed}ms`,
                ];
                lines.push(...persistedLines);
                printBrowserResultLines(persistedLines);
            } catch (err) {
                const persistedLine = `RESULT:persisted_config_error:${truncate(err.message, 200)}`;
                lines.push(persistedLine);
                printBrowserResultLines([persistedLine]);
            }

            const saveResult = getBrowserResultValue(lines, 'save');
            const saveClicked = saveResult?.includes(':clicked:') || false;
            const saveOutcomeOk = saveClicked && (
                saveResult.startsWith('success_banner') ||
                saveResult.startsWith('save_button_disabled') ||
                saveResult.startsWith('spinner_detached') ||
                saveResult.startsWith('no_pending_state')
            );
            recordResult(
                'Save completes (no infinite spinner)',
                saveOutcomeOk,
                [
                    `initial_mode:${getBrowserResultValue(lines, 'initial_mode') || 'no_result'}`,
                    `target_mode:${targetMode || 'no_result'}`,
                    `save_button_after_change:${getBrowserResultValue(lines, 'save_button_after_change') || 'no_result'}`,
                    `save:${saveResult || 'no_result'}`,
                    `save_button_after:${getBrowserResultValue(lines, 'save_button_after') || 'no_result'}`,
                ].join('; '),
            );

            recordResult(
                'System Console save persists effective readReceiptMode target',
                Boolean(targetMode && targetMode !== 'not_found' && runtimeMode === targetMode && persistedMode === targetMode),
                `target=${targetMode || 'no_result'}, persisted_effective=${persistedMode || 'no_result'}, runtime=${runtimeMode || 'no_result'}, ` +
                    `wait=${persistedElapsed ?? 'n/a'}ms, persisted_keys=${persistedKeysJson}, ` +
                    `persisted_config=${truncate(persistedConfigJson, 300)}` +
                    (persistedError ? `, error=${persistedError}` : ''),
            );
        } catch (err) {
            recordResult('System Console browser test', false, formatExecError(err));
        } finally {
            try {
                const restoreResult = await restoreReadReceiptConfig(adminToken, initialSystemPluginConfig, initialReadReceiptMode);
                console.log('RESULT:restored_config:' + restoreResult.targetMode);
            } catch (err) {
                console.log('RESULT:restore_config_error:' + truncate(err.message, 200));
            }
        }
    }

    // =====================================================
    // SUMMARY
    // =====================================================
    console.log('\n=== E2E SMOKE TEST SUMMARY ===');
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${results.length}`);
    results.forEach((r) => {
        console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] Step ${r.step}: ${r.name}`);
        if (!r.passed && r.details) {
            console.log(`         ${r.details}`);
        }
    });

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(2);
});
