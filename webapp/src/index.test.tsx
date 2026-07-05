/** @jest-environment jsdom */
/* eslint-disable max-nested-callbacks */

import {addReaction, getPostThread, removeReaction} from 'mattermost-redux/actions/posts';
import {getLastPostPerChannel} from 'mattermost-redux/selectors/entities/posts';
import {getCurrentChannelId} from 'mattermost-redux/selectors/entities/channels';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';

import {createPost, createRegistry, createStore, flushPromises} from '../tests/helpers';

import {HYBRID_READ_RECEIPT_EMOJI, READ_RECEIPT_MODE_STORAGE_KEY, ReadReceiptMode} from './config/ReadReceiptConfig';
import {
    READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT,
    READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT,
    READ_RECEIPT_UPDATED_BROWSER_EVENT,
    READ_RECEIPT_UPDATED_WEBSOCKET_EVENT,
} from './events/ReadReceiptEvents';
import {SERVER_READ_RECEIPT_API_PREFIX} from './services/ServerReadReceiptService';
import Logger from './utils/Logger';
import Storage from './utils/Storage';

import Plugin from './index';

jest.mock('@/manifest', () => ({
    id: 'com.mattermost.who-read-plugin',
    version: 'test',
}), {virtual: true});

jest.mock('mattermost-redux/actions/posts', () => ({
    addReaction: jest.fn((postId: string, emoji: string) => ({emoji, postId, type: 'ADD_REACTION'})),
    getPostThread: jest.fn((threadId: string) => ({threadId, type: 'GET_POST_THREAD'})),
    removeReaction: jest.fn((postId: string, emoji: string) => ({emoji, postId, type: 'REMOVE_REACTION'})),
}));

jest.mock('mattermost-redux/selectors/entities/posts', () => ({
    getLastPostPerChannel: jest.fn(),
}));

jest.mock('mattermost-redux/selectors/entities/channels', () => ({
    getCurrentChannelId: jest.fn(),
}));

jest.mock('mattermost-redux/selectors/entities/users', () => ({
    getCurrentUser: jest.fn(),
}));

const addReactionMock = addReaction as jest.Mock;
const getCurrentChannelIdMock = getCurrentChannelId as jest.Mock;
const getCurrentUserMock = getCurrentUser as jest.Mock;
const getLastPostPerChannelMock = getLastPostPerChannel as jest.Mock;
const getPostThreadMock = getPostThread as jest.Mock;
const removeReactionMock = removeReaction as jest.Mock;

function createMetadataWithMyReadReaction(postId: string, emojiName = 'eyes') {
    return {
        embeds: [],
        emojis: [],
        files: [],
        images: {},
        reactions: [{create_at: 0, emoji_name: emojiName, post_id: postId, user_id: 'me'}],
    };
}

function createControlledPromise() {
    let resolvePromise: () => void = jest.fn();
    const promise = new Promise((resolve) => {
        resolvePromise = () => resolve({data: {}});
    });

    return {promise, resolvePromise};
}

function createFetchResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
    return Promise.resolve({
        json: jest.fn(() => Promise.resolve(body)),
        ok,
        status,
        statusText: ok ? 'OK' : 'Internal Server Error',
        text: jest.fn(() => Promise.resolve(JSON.stringify(body))),
    });
}

function mockServerConfig(config: Record<string, unknown> = {readReceiptMode: ReadReceiptMode.LegacyReactions}, emojiStatus: Record<string, unknown> = {}) {
    const fetchMock = jest.fn((url: string) => {
        if (url === `${SERVER_READ_RECEIPT_API_PREFIX}/config`) {
            return createFetchResponse(config);
        }

        if (url === `${SERVER_READ_RECEIPT_API_PREFIX}/emoji/status`) {
            return createFetchResponse({
                configured_available: true,
                configured_emoji_name: HYBRID_READ_RECEIPT_EMOJI,
                effective_available: true,
                effective_emoji_name: HYBRID_READ_RECEIPT_EMOJI,
                fallback_used: false,
                ...emojiStatus,
            });
        }

        if (url === `${SERVER_READ_RECEIPT_API_PREFIX}/read-state`) {
            return createFetchResponse({data: {post_id: 'post-id'}, status: 'ok'});
        }

        return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    (global as any).fetch = fetchMock;
    return fetchMock;
}

function mockServerConfigUnavailable() {
    const fetchMock = jest.fn((url: string) => {
        if (url === `${SERVER_READ_RECEIPT_API_PREFIX}/config`) {
            return Promise.reject(new Error('server unavailable'));
        }

        if (url === `${SERVER_READ_RECEIPT_API_PREFIX}/emoji/status`) {
            return createFetchResponse({
                configured_available: true,
                configured_emoji_name: HYBRID_READ_RECEIPT_EMOJI,
                effective_available: true,
                effective_emoji_name: HYBRID_READ_RECEIPT_EMOJI,
                fallback_used: false,
            });
        }

        if (url === `${SERVER_READ_RECEIPT_API_PREFIX}/read-state`) {
            return createFetchResponse({data: {post_id: 'post-id'}, status: 'ok'});
        }

        return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    (global as any).fetch = fetchMock;
    return fetchMock;
}

function expectReadStateRequest(fetchMock: jest.Mock, body: Record<string, unknown>) {
    const call = fetchMock.mock.calls.find(([url]) => url === `${SERVER_READ_RECEIPT_API_PREFIX}/read-state`);
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit;
    expect(init).toEqual(expect.objectContaining({
        credentials: 'same-origin',
        method: 'POST',
    }));
    expect(JSON.parse(String(init.body))).toEqual(body);
}

function createDispatchForThread(posts: Record<string, unknown>) {
    return jest.fn((action) => {
        if (action.type === 'GET_POST_THREAD') {
            return Promise.resolve({data: {posts}});
        }

        return Promise.resolve({data: {}});
    });
}

describe('Plugin read reaction behavior', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        localStorage.clear();
        getCurrentUserMock.mockReturnValue({id: 'me'});
        getLastPostPerChannelMock.mockReturnValue({});
        mockServerConfig();

        // Simulate focused window — document.hasFocus() returns false in jsdom
        jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('lifecycle', () => {
        it('unregisters WebSocket handlers on uninitialize', async () => {
            const {handlers, registry} = createRegistry();
            const {store} = createStore();
            const plugin = new Plugin();

            await plugin.initialize(registry, store);

            expect(handlers.multiple_channels_viewed).toBeDefined();
            expect(handlers.thread_read_changed).toBeDefined();

            plugin.uninitialize();

            expect(registry.unregisterWebSocketEventHandler).toHaveBeenCalledWith('multiple_channels_viewed');
            expect(registry.unregisterWebSocketEventHandler).toHaveBeenCalledWith('thread_read_changed');
            expect(handlers.multiple_channels_viewed).toBeUndefined();
            expect(handlers.thread_read_changed).toBeUndefined();
        });

        it('registers and unregisters the mirror reaction hider and DOM fallback in hybrid mode', async () => {
            mockServerConfig({
                hideMirrorReactionsInWeb: true,
                mirrorReactionsEnabled: true,
                readReceiptMode: ReadReceiptMode.HybridServer,
            });
            const {registry} = createRegistry();
            const {store} = createStore();
            const plugin = new Plugin();

            await plugin.initialize(registry, store);

            expect(registry.registerRootComponent).toHaveBeenCalledTimes(2);

            plugin.uninitialize();

            expect(registry.unregisterComponent).toHaveBeenCalledWith('root-component-id');
            expect(registry.unregisterComponent).toHaveBeenCalledWith('root-component-id-2');
        });

        it('uses effective fallback emoji for the mirror reaction hider', async () => {
            mockServerConfig({
                hideMirrorReactionsInWeb: true,
                mirrorReactionsEnabled: true,
                readReceiptMode: ReadReceiptMode.HybridServer,
            }, {
                configured_available: false,
                effective_emoji_name: 'eyes',
                fallback_used: true,
            });
            const {registry} = createRegistry();
            const {store} = createStore();

            await new Plugin().initialize(registry, store);

            const component = (registry.registerRootComponent as jest.Mock).mock.calls[0][0];
            expect(component().props.emojiName).toBe('eyes');
        });

        it('registers server websocket handlers in server modes', async () => {
            mockServerConfig({readReceiptMode: ReadReceiptMode.ServerWebOnly});
            const {handlers, registry} = createRegistry();
            const {store} = createStore();
            const plugin = new Plugin();
            const readReceiptListener = jest.fn();
            const configChangedListener = jest.fn();
            window.addEventListener(READ_RECEIPT_UPDATED_BROWSER_EVENT, readReceiptListener);
            window.addEventListener(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, configChangedListener);

            await plugin.initialize(registry, store);

            expect(handlers[READ_RECEIPT_UPDATED_WEBSOCKET_EVENT]).toBeDefined();
            expect(handlers[READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT]).toBeDefined();

            await handlers[READ_RECEIPT_UPDATED_WEBSOCKET_EVENT]({data: {post_id: 'post-id', previous_post_id: 'old-post-id'}});
            await handlers[READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT]({data: {updated_at: 123}});

            expect(readReceiptListener).toHaveBeenCalledWith(expect.objectContaining({detail: {post_id: 'post-id', previous_post_id: 'old-post-id'}}));
            expect(configChangedListener).toHaveBeenCalledWith(expect.objectContaining({detail: {updated_at: 123}}));

            plugin.uninitialize();
            expect(registry.unregisterWebSocketEventHandler).toHaveBeenCalledWith(READ_RECEIPT_UPDATED_WEBSOCKET_EVENT);
            expect(registry.unregisterWebSocketEventHandler).toHaveBeenCalledWith(READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT);

            window.removeEventListener(READ_RECEIPT_UPDATED_BROWSER_EVENT, readReceiptListener);
            window.removeEventListener(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, configChangedListener);
        });

        it('registers DOM fallback root component in server mode', async () => {
            mockServerConfig({readReceiptMode: ReadReceiptMode.ServerWebOnly});
            const {registry} = createRegistry();
            const {store} = createStore();
            const plugin = new Plugin();

            await plugin.initialize(registry, store);

            expect(registry.registerRootComponent).toHaveBeenCalledTimes(1);
            expect(registry.registerRootComponent).toHaveBeenCalledWith(expect.any(Function));

            plugin.uninitialize();

            expect(registry.unregisterComponent).toHaveBeenCalledWith('root-component-id');
        });

        it('syncs current channel read state on network restore', async () => {
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = ((fn: (...args: any[]) => void, ...args: any[]) => {
                fn();
                return 0;
            }) as any;
            try {
                const {registry} = createRegistry();
                const dispatch = jest.fn(() => Promise.resolve({data: {}}));
                const {store} = createStore({}, dispatch);
                const lastPost = createPost({id: 'last-online-post-id', user_id: 'other'});
                getCurrentChannelIdMock.mockReturnValue('channelA');
                getLastPostPerChannelMock.mockReturnValue({channelA: lastPost});

                const plugin = new Plugin();
                await plugin.initialize(registry, store);

                window.dispatchEvent(new Event('online'));

                // Allow async chain to complete
                await flushPromises();
                await flushPromises();
                await flushPromises();
                await flushPromises();
                await flushPromises();

                expect(addReactionMock).toHaveBeenCalledWith('last-online-post-id', 'eyes');

                plugin.uninitialize();
            } finally {
                global.setTimeout = originalSetTimeout;
            }
        });

        it('cleans up online/offline listeners on uninitialize', async () => {
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = ((fn: (...args: any[]) => void, ...args: any[]) => {
                fn();
                return 0;
            }) as any;
            try {
                const {registry} = createRegistry();
                const {store} = createStore();
                const plugin = new Plugin();

                await plugin.initialize(registry, store);

                // Handler is active — online event triggers re-sync
                // After uninitialize, handlers should be removed
                plugin.uninitialize();

                getCurrentChannelIdMock.mockReturnValue('channelA');
                getLastPostPerChannelMock.mockReturnValue({channelA: createPost({id: 'post-after-cleanup', user_id: 'other'})});

                window.dispatchEvent(new Event('online'));
                await flushPromises();
                await flushPromises();
                await flushPromises();
                await flushPromises();
                await flushPromises();

                // Listener was removed, so no reaction should be added
                expect(addReactionMock).not.toHaveBeenCalled();
            } finally {
                global.setTimeout = originalSetTimeout;
            }
        });
    });

    describe('multiple_channels_viewed', () => {
        it('adds :eyes: to the last non-own channel post and stores read state', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            const lastPost = createPost({id: 'last-post-id', user_id: 'other'});
            getLastPostPerChannelMock.mockReturnValue({channelA: lastPost});

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(addReactionMock).toHaveBeenCalledWith('last-post-id', 'eyes');
            expect(registry.registerRootComponent).not.toHaveBeenCalled();
            expect(registry.registerPostFooterComponent).not.toHaveBeenCalled();
            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(Storage.getLastPostId('channelA')).toBe('last-post-id');
            expect(Storage.getLastViewed('channelA')).toBe(123);
        });

        it('falls back to localStorage hybrid mode and marks channel read state through server API', async () => {
            const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(jest.fn());
            const fetchMock = mockServerConfigUnavailable();
            localStorage.setItem(READ_RECEIPT_MODE_STORAGE_KEY, ReadReceiptMode.HybridServer);
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            const lastPost = createPost({id: 'last-post-id', user_id: 'other'});
            getLastPostPerChannelMock.mockReturnValue({channelA: lastPost});

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expectReadStateRequest(fetchMock, {
                channel_id: 'channelA',
                last_read_post_id: 'last-post-id',
                scope_type: 'channel',
            });
            expect(addReactionMock).not.toHaveBeenCalled();
            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(registry.registerRootComponent).toHaveBeenCalledTimes(2);
            expect(Storage.getLastPostId('channelA')).toBe('last-post-id');
            expect(Storage.getLastViewed('channelA')).toBe(123);

            errorSpy.mockRestore();
        });

        it('marks own channel post through server API without direct reaction calls in server_web_only mode', async () => {
            const fetchMock = mockServerConfig({readReceiptMode: ReadReceiptMode.ServerWebOnly});
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            Storage.setLastPostId('channelA', 'old-post-id');
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({id: 'own-post-id', user_id: 'me'}),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expectReadStateRequest(fetchMock, {
                channel_id: 'channelA',
                last_read_post_id: 'own-post-id',
                scope_type: 'channel',
            });
            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(addReactionMock).not.toHaveBeenCalled();
            expect(registry.registerRootComponent).toHaveBeenCalledTimes(1);
            expect(Storage.getLastPostId('channelA')).toBe('own-post-id');
            expect(Storage.getLastViewed('channelA')).toBe(123);
        });

        it('moves :eyes: from the stored old post to a new last post', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            Storage.setLastPostId('channelA', 'old-post-id');
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({id: 'new-post-id', user_id: 'other'}),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(removeReactionMock).toHaveBeenCalledWith('old-post-id', 'eyes');
            expect(addReactionMock).toHaveBeenCalledWith('new-post-id', 'eyes');
            expect(Storage.getLastPostId('channelA')).toBe('new-post-id');
        });

        it('removes an old reaction but does not add one when the last post is own', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            Storage.setLastPostId('channelA', 'old-post-id');
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({id: 'own-post-id', user_id: 'me'}),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(removeReactionMock).toHaveBeenCalledWith('old-post-id', 'eyes');
            expect(addReactionMock).not.toHaveBeenCalled();
            expect(Storage.getLastPostId('channelA')).toBe('own-post-id');
        });

        it('marks every viewed channel and stores all timestamps', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({id: 'channel-a-post-id', user_id: 'other'}),
                channelB: createPost({id: 'channel-b-post-id', user_id: 'other'}),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({
                data: {
                    channel_times: {
                        channelA: 123,
                        channelB: 456,
                    },
                },
            });

            expect(addReactionMock).toHaveBeenCalledTimes(2);
            expect(addReactionMock).toHaveBeenCalledWith('channel-a-post-id', 'eyes');
            expect(addReactionMock).toHaveBeenCalledWith('channel-b-post-id', 'eyes');
            expect(Storage.getLastViewed('channelA')).toBe(123);
            expect(Storage.getLastViewed('channelB')).toBe(456);
            expect(Storage.getLastPostId('channelA')).toBe('channel-a-post-id');
            expect(Storage.getLastPostId('channelB')).toBe('channel-b-post-id');
        });

        it('does not touch reactions when the last channel post already has my :eyes:', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({
                    id: 'already-reacted-post-id',
                    metadata: createMetadataWithMyReadReaction('already-reacted-post-id'),
                    user_id: 'other',
                }),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(addReactionMock).not.toHaveBeenCalled();
            expect(Storage.getLastPostId('channelA')).toBe('already-reacted-post-id');
        });

        it('uses server API in hybrid mode even when a mirror reaction is already present', async () => {
            const fetchMock = mockServerConfig({readReceiptMode: ReadReceiptMode.HybridServer});
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({
                    id: 'already-reacted-post-id',
                    metadata: createMetadataWithMyReadReaction('already-reacted-post-id', HYBRID_READ_RECEIPT_EMOJI),
                    user_id: 'other',
                }),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(addReactionMock).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(`${SERVER_READ_RECEIPT_API_PREFIX}/read-state`, expect.objectContaining({method: 'POST'}));
            expect(Storage.getLastPostId('channelA')).toBe('already-reacted-post-id');
        });

        it('serializes reaction moves for the same channel', async () => {
            const {promise, resolvePromise} = createControlledPromise();
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn((action) => {
                if (action.type === 'ADD_REACTION' && action.postId === 'first-post-id') {
                    return promise;
                }

                return Promise.resolve({data: {}});
            });
            const {store} = createStore({}, dispatch);
            getLastPostPerChannelMock.
                mockReturnValueOnce({channelA: createPost({id: 'first-post-id', user_id: 'other'})}).
                mockReturnValueOnce({channelA: createPost({id: 'second-post-id', user_id: 'other'})});

            await new Plugin().initialize(registry, store);
            const firstEvent = handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});
            await flushPromises();
            const secondEvent = handlers.multiple_channels_viewed({data: {channel_times: {channelA: 456}}});
            await flushPromises();

            expect(addReactionMock).toHaveBeenCalledTimes(1);
            expect(addReactionMock).toHaveBeenCalledWith('first-post-id', 'eyes');

            resolvePromise();
            await firstEvent;
            await secondEvent;

            expect(removeReactionMock).toHaveBeenCalledWith('first-post-id', 'eyes');
            expect(addReactionMock).toHaveBeenCalledWith('second-post-id', 'eyes');
            expect(Storage.getLastPostId('channelA')).toBe('second-post-id');
        });

        it('does not store a new last post when addReaction fails', async () => {
            const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(jest.fn());
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn((action) => {
                if (action.type === 'ADD_REACTION') {
                    return Promise.reject(new Error('network'));
                }

                return Promise.resolve({data: {}});
            });
            const {store} = createStore({}, dispatch);
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({id: 'new-post-id', user_id: 'other'}),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(addReactionMock).toHaveBeenCalledTimes(2);
            expect(Storage.getLastPostId('channelA')).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith('Failed to add reaction on post new-post-id:', expect.any(Error));

            errorSpy.mockRestore();
        });

        it('defers channel processing when the window is inactive and processes on focus', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            const lastPost = createPost({id: 'last-post-id', user_id: 'other'});
            getLastPostPerChannelMock.mockReturnValue({channelA: lastPost});

            const plugin = new Plugin();
            await plugin.initialize(registry, store);

            // Make window inactive
            window.dispatchEvent(new Event('blur'));

            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            // Should NOT have marked read state (deferred)
            expect(addReactionMock).not.toHaveBeenCalled();

            // Focus the window — should process deferred channel
            window.dispatchEvent(new Event('focus'));
            await flushPromises();

            expect(addReactionMock).toHaveBeenCalledWith('last-post-id', 'eyes');

            plugin.uninitialize();
        });

        it('processes own post immediately even when window is inactive', async () => {
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            const lastPost = createPost({id: 'own-post-id', user_id: 'me'});
            getLastPostPerChannelMock.mockReturnValue({channelA: lastPost});

            const plugin = new Plugin();
            await plugin.initialize(registry, store);

            // Make window inactive
            window.dispatchEvent(new Event('blur'));

            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            // Own post should still be processed (not deferred)
            // In legacy mode, own post removes old reaction but doesn't add new one
            expect(Storage.getLastPostId('channelA')).toBe('own-post-id');

            plugin.uninitialize();
        });

        it('defers server-mode channel processing when window is inactive', async () => {
            const fetchMock = mockServerConfig({readReceiptMode: ReadReceiptMode.ServerWebOnly});
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn(() => Promise.resolve({data: {}}));
            const {store} = createStore({}, dispatch);
            const lastPost = createPost({id: 'last-post-id', user_id: 'other'});
            getLastPostPerChannelMock.mockReturnValue({channelA: lastPost});

            const plugin = new Plugin();
            await plugin.initialize(registry, store);

            // Make window inactive
            window.dispatchEvent(new Event('blur'));

            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            // Should NOT have called read-state API (deferred)
            const readStateCall = fetchMock.mock.calls.find(([url]) => url === `${SERVER_READ_RECEIPT_API_PREFIX}/read-state`);
            expect(readStateCall).toBeUndefined();

            // Focus the window — should process deferred channel
            window.dispatchEvent(new Event('focus'));
            await flushPromises();

            // Now read-state should have been called
            expectReadStateRequest(fetchMock, {
                channel_id: 'channelA',
                last_read_post_id: 'last-post-id',
                scope_type: 'channel',
            });

            plugin.uninitialize();
        });

        it('keeps the old stored post when old reaction removal fails', async () => {
            const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(jest.fn());
            const {handlers, registry} = createRegistry();
            const dispatch = jest.fn((action) => {
                if (action.type === 'REMOVE_REACTION') {
                    return Promise.reject(new Error('network'));
                }

                return Promise.resolve({data: {}});
            });
            const {store} = createStore({}, dispatch);
            Storage.setLastPostId('channelA', 'old-post-id');
            getLastPostPerChannelMock.mockReturnValue({
                channelA: createPost({id: 'new-post-id', user_id: 'other'}),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(removeReactionMock).toHaveBeenCalledTimes(2);
            expect(addReactionMock).not.toHaveBeenCalled();
            expect(Storage.getLastPostId('channelA')).toBe('old-post-id');
            expect(errorSpy).toHaveBeenCalledWith('Failed to remove reaction on post old-post-id:', expect.any(Error));

            errorSpy.mockRestore();
        });
    });

    describe('thread_read_changed', () => {
        it('marks latest reply through server API in server modes without direct reaction calls', async () => {
            const fetchMock = mockServerConfig({readReceiptMode: ReadReceiptMode.ServerWebOnly});
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({channel_id: 'channel-id', create_at: 100, id: 'root-id'});
            const lastReply = createPost({channel_id: 'channel-id', create_at: 300, id: 'last-reply-id', root_id: 'thread-id', user_id: 'other'});
            const dispatch = createDispatchForThread({lastReply, rootPost});
            const {store} = createStore({}, dispatch);

            await new Plugin().initialize(registry, store);
            window.dispatchEvent(new Event('focus'));
            await handlers.thread_read_changed({data: {thread_id: 'thread-id'}});

            expect(getPostThreadMock).toHaveBeenCalledWith('thread-id');
            expectReadStateRequest(fetchMock, {
                channel_id: 'channel-id',
                last_read_post_id: 'last-reply-id',
                scope_type: 'thread',
                thread_id: 'thread-id',
            });
            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(addReactionMock).not.toHaveBeenCalled();
        });

        it('cleans old thread reactions and marks the latest reply when the window is active', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const oldReply = createPost({
                create_at: 200,
                id: 'old-reply-id',
                metadata: createMetadataWithMyReadReaction('old-reply-id'),
                user_id: 'other',
            });
            const lastReply = createPost({create_at: 300, id: 'last-reply-id', user_id: 'other'});
            const dispatch = createDispatchForThread({lastReply, oldReply, rootPost});
            const {store} = createStore({}, dispatch);

            await new Plugin().initialize(registry, store);
            window.dispatchEvent(new Event('focus'));
            await handlers.thread_read_changed({data: {thread_id: 'thread-id'}});

            expect(getPostThreadMock).toHaveBeenCalledWith('thread-id');
            expect(removeReactionMock).toHaveBeenCalledWith('old-reply-id', 'eyes');
            expect(addReactionMock).toHaveBeenCalledWith('last-reply-id', 'eyes');
        });

        it('defers marking a non-own latest reply until the window gets focus', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const lastReply = createPost({create_at: 200, id: 'last-reply-id', user_id: 'other'});
            const dispatch = createDispatchForThread({lastReply, rootPost});
            const {store} = createStore({}, dispatch);
            const plugin = new Plugin();

            await plugin.initialize(registry, store);

            // Window starts active due to document.hasFocus() mock — blur to test deferral
            window.dispatchEvent(new Event('blur'));
            await handlers.thread_read_changed({data: {thread_id: 'thread-id'}});

            expect(addReactionMock).not.toHaveBeenCalled();

            window.dispatchEvent(new Event('focus'));
            await flushPromises();

            expect(addReactionMock).toHaveBeenCalledWith('last-reply-id', 'eyes');

            plugin.uninitialize();
        });

        it('does nothing for a thread without replies', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const dispatch = createDispatchForThread({rootPost});
            const {store} = createStore({}, dispatch);

            await new Plugin().initialize(registry, store);
            window.dispatchEvent(new Event('focus'));
            await handlers.thread_read_changed({data: {thread_id: 'thread-id'}});

            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(addReactionMock).not.toHaveBeenCalled();
        });

        it('removes old reactions but does not mark the latest own reply', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const oldReply = createPost({
                create_at: 200,
                id: 'old-reply-id',
                metadata: createMetadataWithMyReadReaction('old-reply-id'),
                user_id: 'other',
            });
            const ownReply = createPost({create_at: 300, id: 'own-reply-id', user_id: 'me'});
            const dispatch = createDispatchForThread({oldReply, ownReply, rootPost});
            const {store} = createStore({}, dispatch);

            await new Plugin().initialize(registry, store);
            await handlers.thread_read_changed({data: {thread_id: 'thread-id'}});

            expect(removeReactionMock).toHaveBeenCalledWith('old-reply-id', 'eyes');
            expect(addReactionMock).not.toHaveBeenCalled();
        });

        it('deduplicates thread cleanup and keeps the correct last-post reaction', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const oldReply = createPost({
                create_at: 200,
                id: 'old-reply-id',
                metadata: {
                    embeds: [],
                    emojis: [],
                    files: [],
                    images: {},
                    reactions: [
                        {create_at: 0, emoji_name: 'eyes', post_id: 'old-reply-id', user_id: 'me'},
                        {create_at: 0, emoji_name: 'eyes', post_id: 'old-reply-id', user_id: 'me'},
                    ],
                },
                user_id: 'other',
            });
            const lastReply = createPost({
                create_at: 300,
                id: 'last-reply-id',
                metadata: createMetadataWithMyReadReaction('last-reply-id'),
                user_id: 'other',
            });
            const dispatch = createDispatchForThread({lastReply, oldReply, rootPost});
            const {store} = createStore({}, dispatch);

            await new Plugin().initialize(registry, store);
            window.dispatchEvent(new Event('focus'));
            await handlers.thread_read_changed({data: {thread_id: 'thread-id'}});

            expect(removeReactionMock).toHaveBeenCalledTimes(1);
            expect(removeReactionMock).toHaveBeenCalledWith('old-reply-id', 'eyes');
            expect(addReactionMock).not.toHaveBeenCalled();
        });

        it('serializes processing for the same thread', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const lastReply = createPost({create_at: 200, id: 'last-reply-id', user_id: 'other'});
            const firstThreadLoad = new Promise((resolve) => {
                setTimeout(() => resolve({data: {posts: {lastReply, rootPost}}}), 10);
            });
            const dispatch = jest.fn((action) => {
                if (action.type === 'GET_POST_THREAD' && dispatch.mock.calls.length === 1) {
                    return firstThreadLoad;
                }

                if (action.type === 'GET_POST_THREAD') {
                    return Promise.resolve({data: {posts: {lastReply, rootPost}}});
                }

                return Promise.resolve({data: {}});
            });
            const {store} = createStore({}, dispatch);

            await new Plugin().initialize(registry, store);
            window.dispatchEvent(new Event('focus'));
            const firstEvent = handlers.thread_read_changed({data: {thread_id: 'thread-id'}});
            await flushPromises();
            const secondEvent = handlers.thread_read_changed({data: {thread_id: 'thread-id'}});
            await flushPromises();

            expect(getPostThreadMock).toHaveBeenCalledTimes(1);

            await firstEvent;
            await secondEvent;

            expect(getPostThreadMock).toHaveBeenCalledTimes(2);
        });
    });
});
