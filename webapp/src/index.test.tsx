/** @jest-environment jsdom */
/* eslint-disable max-nested-callbacks */

import {addReaction, getPostThread, removeReaction} from 'mattermost-redux/actions/posts';
import {getLastPostPerChannel} from 'mattermost-redux/selectors/entities/posts';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';

import {createPost, createRegistry, createStore, flushPromises} from '../tests/helpers';

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

jest.mock('mattermost-redux/selectors/entities/users', () => ({
    getCurrentUser: jest.fn(),
}));

const addReactionMock = addReaction as jest.Mock;
const getCurrentUserMock = getCurrentUser as jest.Mock;
const getLastPostPerChannelMock = getLastPostPerChannel as jest.Mock;
const getPostThreadMock = getPostThread as jest.Mock;
const removeReactionMock = removeReaction as jest.Mock;

function createMetadataWithMyEyes(postId: string) {
    return {
        embeds: [],
        emojis: [],
        files: [],
        images: {},
        reactions: [{create_at: 0, emoji_name: 'eyes', post_id: postId, user_id: 'me'}],
    };
}

function createControlledPromise() {
    let resolvePromise: () => void = jest.fn();
    const promise = new Promise((resolve) => {
        resolvePromise = () => resolve({data: {}});
    });

    return {promise, resolvePromise};
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
            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(Storage.getLastPostId('channelA')).toBe('last-post-id');
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
                    metadata: createMetadataWithMyEyes('already-reacted-post-id'),
                    user_id: 'other',
                }),
            });

            await new Plugin().initialize(registry, store);
            await handlers.multiple_channels_viewed({data: {channel_times: {channelA: 123}}});

            expect(removeReactionMock).not.toHaveBeenCalled();
            expect(addReactionMock).not.toHaveBeenCalled();
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
        it('cleans old thread reactions and marks the latest reply when the window is active', async () => {
            const {handlers, registry} = createRegistry();
            const rootPost = createPost({create_at: 100, id: 'root-id'});
            const oldReply = createPost({
                create_at: 200,
                id: 'old-reply-id',
                metadata: createMetadataWithMyEyes('old-reply-id'),
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
                metadata: createMetadataWithMyEyes('old-reply-id'),
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
                metadata: createMetadataWithMyEyes('last-reply-id'),
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
