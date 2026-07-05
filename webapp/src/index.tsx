import React from 'react';
import {Store, Action} from 'redux';
import {GlobalState} from 'mattermost-redux/types/store';

import {getLastPostPerChannel} from 'mattermost-redux/selectors/entities/posts';
import {getCurrentChannelId} from 'mattermost-redux/selectors/entities/channels';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';
import {Post} from 'mattermost-redux/types/posts';
import {UserProfile} from 'mattermost-redux/types/users';

import {PluginRegistry} from '@/types/mattermost-webapp';
import manifest from '@/manifest';

import MirrorReactionHider from './components/MirrorReactionHider';
import ReadReceiptDomFallback from './components/ReadReceiptDomFallback';
import {DEFAULT_READ_RECEIPT_CONFIG, LEGACY_READ_RECEIPT_EMOJI, ReadReceiptConfig, resolveReadReceiptConfig} from './config/ReadReceiptConfig';
import {
    READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT,
    READ_RECEIPT_UPDATED_WEBSOCKET_EVENT,
    ReadReceiptConfigChangedWebSocketEvent,
    ReadReceiptUpdatedWebSocketEvent,
    dispatchReadReceiptConfigChanged,
    dispatchReadReceiptUpdated,
} from './events/ReadReceiptEvents';
import Storage from './utils/Storage';
import Logger from './utils/Logger';
import {isValidPost} from './utils/Guards';

import ReadState from './services/ReadState';
import PostService from './services/PostService';
import ReactionService from './services/ReactionService';
import ServerReadReceiptService, {MarkReadStateRequest} from './services/ServerReadReceiptService';

interface MultipleChannelsViewedEvent {
    data?: {
        channel_times?: Record<string, number>;
    };
}

interface ThreadReadChangedEvent {
    data?: {
        thread_id?: string;
    };
}

export default class Plugin {
    private me: UserProfile = {} as UserProfile;
    private emoji = LEGACY_READ_RECEIPT_EMOJI;
    private readReceiptConfig: ReadReceiptConfig = DEFAULT_READ_RECEIPT_CONFIG;
    private readState = new ReadState();
    private postService!: PostService;
    private reactionService: ReactionService | null = null;
    private serverReadReceiptService = new ServerReadReceiptService();
    private registry: PluginRegistry | null = null;
    private mirrorReactionHiderComponentId: string | null = null;
    private mirrorReactionHiderEmojiName: string | null = null;
    private readReceiptDomFallbackComponentId: string | null = null;
    private serverWebSocketHandlersRegistered = false;
    private operationQueues = new Map<string, Promise<void>>();
    private store: Store<GlobalState, Action<Record<string, unknown>>> | null = null;

    // Ссылки на обработчики для cleanup в uninitialize
    private focusHandler = async (): Promise<void> => {
        Logger.log('window focus');
        await this.onWindowActive();
    };

    private blurHandler = (): void => {
        Logger.log('window blur');
        this.readState.setWindowIsActive(false);
    };

    private visibilityChangeHandler = async (): Promise<void> => {
        if (document.hidden) {
            Logger.log('document hidden');
            this.readState.setWindowIsActive(false);
            return;
        }
        Logger.log('document visible');
        await this.onWindowActive();
    };

    // Ссылки на обработчики online/offline для cleanup в uninitialize
    private onlineHandler = async (): Promise<void> => {
        await this.onNetworkRestored();
    };

    private offlineHandler = (): void => {
        // Offline state is tracked implicitly — re-sync happens on 'online' event
    };

    private async onWindowActive(): Promise<void> {
        this.readState.setWindowIsActive(true);

        // Process deferred thread (existing logic from focusHandler)
        const threadId = this.readState.getCurrentThreadId();
        if (threadId && !this.readState.isProcessing()) {
            await this.processThread(threadId);
            this.readState.setCurrentThreadId(null);
        }

        // Process deferred channels
        const deferredChannels = this.readState.getDeferredChannelsAndClear();
        if (deferredChannels.length > 0 && this.store) {
            const lastPostsInChannel = getLastPostPerChannel(this.store.getState());
            for (const {channelId, viewedAt} of deferredChannels) {
                if (!this.readState.isWindowActive()) {
                    break;
                }
                // eslint-disable-next-line no-await-in-loop
                await this.enqueueOperation(`channel:${channelId}`, async () => {
                    await this.processViewedChannel(channelId, lastPostsInChannel[channelId], viewedAt);
                });
            }
        }
    }

    private async onNetworkRestored(delayMs = 2000): Promise<void> {
        // Allow Mattermost WebSocket time to reconnect and fetch fresh data
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (!this.store) {
            return;
        }

        const state = this.store.getState();
        const channelId = getCurrentChannelId(state);
        if (!channelId) {
            return;
        }

        const lastPostsInChannel = getLastPostPerChannel(state);
        const lastPost = lastPostsInChannel[channelId];
        if (!lastPost || !isValidPost(lastPost)) {
            return;
        }

        await this.enqueueOperation(`channel:${channelId}`, async () => {
            await this.processViewedChannel(channelId, lastPost);
        });
    }

    private readReceiptUpdatedHandler = (event: ReadReceiptUpdatedWebSocketEvent): void => {
        dispatchReadReceiptUpdated(event.data || {});
    };

    private readReceiptConfigChangedHandler = (event: ReadReceiptConfigChangedWebSocketEvent): void => {
        dispatchReadReceiptConfigChanged(event.data || {});
    };

    public async initialize(registry: PluginRegistry, store: Store<GlobalState, Action<Record<string, unknown>>>) {
        Logger.log('initialize start');
        this.registry = registry;
        this.store = store;
        this.applyReadReceiptConfig(await this.fetchInitialReadReceiptConfig());

        // Register components and handlers first — they don't depend on this.me.
        this.postService = new PostService(store);
        if (this.readReceiptConfig.isLegacyMode) {
            this.reactionService = new ReactionService(store, this.readState, this.emoji);
        }
        this.mirrorReactionHiderEmojiName = await this.fetchMirrorReactionHiderEmojiName();
        this.registerOptionalComponents(registry);

        window.addEventListener('focus', this.focusHandler);
        window.addEventListener('blur', this.blurHandler);
        document.addEventListener('visibilitychange', this.visibilityChangeHandler);
        window.addEventListener('online', this.onlineHandler);
        window.addEventListener('offline', this.offlineHandler);

        // Set initial window state — the window is typically active when the plugin loads.
        this.readState.setWindowIsActive(typeof document !== 'undefined' && document.hasFocus());

        registry.registerWebSocketEventHandler<MultipleChannelsViewedEvent>('multiple_channels_viewed', async (event) => {
            Logger.log('multiple_channels_viewed raw event', event);
            try {
                const channelTimes = event.data?.channel_times;
                Logger.log('channelTimes', channelTimes);
                if (!channelTimes || typeof channelTimes !== 'object') {
                    Logger.log('no channelTimes');
                    return;
                }

                const channelIds = Object.keys(channelTimes);
                Logger.log('channelIds', channelIds);
                if (channelIds.length === 0) {
                    Logger.log('no channelIds');
                    return;
                }

                if (this.readReceiptConfig.isLegacyMode) {
                    // В legacy сохраняем время просмотра до reaction-операций, как раньше.
                    Object.entries(channelTimes).forEach(([channelId, timestamp]) => {
                        Storage.setLastViewed(channelId, timestamp);
                    });
                }

                const currentStore = store.getState();
                const lastPostsInChannel = getLastPostPerChannel(currentStore);
                Logger.log('lastPostsInChannel keys', Object.keys(lastPostsInChannel || {}));

                for (const channelId of channelIds) {
                    // eslint-disable-next-line no-await-in-loop
                    await this.enqueueOperation(`channel:${channelId}`, async () => {
                        await this.processViewedChannel(channelId, lastPostsInChannel[channelId], channelTimes[channelId]);
                    });
                }
            } catch (err) {
                Logger.error('Error in multiple_channels_viewed handler:', err);
            }
        });

        registry.registerWebSocketEventHandler<ThreadReadChangedEvent>('thread_read_changed', async (event) => {
            Logger.log('thread_read_changed raw event', event);
            try {
                const threadId = event.data?.thread_id;
                Logger.log('threadId', threadId);
                if (!threadId) {
                    return;
                }

                await this.enqueueOperation(`thread:${threadId}`, async () => {
                    const postList = await this.postService.getSortedThreadPosts(threadId);
                    await this.processLoadedThread(threadId, postList);
                });
            } catch (err) {
                Logger.error('Error in thread_read_changed handler:', err);
            }
        });

        if (this.readReceiptConfig.isServerMode) {
            registry.registerWebSocketEventHandler<ReadReceiptUpdatedWebSocketEvent>(READ_RECEIPT_UPDATED_WEBSOCKET_EVENT, this.readReceiptUpdatedHandler);
            registry.registerWebSocketEventHandler<ReadReceiptConfigChangedWebSocketEvent>(READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT, this.readReceiptConfigChangedHandler);
            this.serverWebSocketHandlersRegistered = true;
        }

        // Try to get current user — may not be available yet (e.g. before login completes).
        if (!this.ensureCurrentUser()) {
            Logger.log('current user not yet available in store, will retry on events');
        }

        Logger.log('initialize done');
    }

    private ensureCurrentUser(): boolean {
        if (this.me?.id) {
            return true;
        }
        if (!this.store) {
            return false;
        }
        const me = getCurrentUser(this.store.getState());
        if (me?.id) {
            this.me = me;
            Logger.log('current user id (lazy)', this.me.id);
            return true;
        }
        Logger.log('current user not yet available in store');
        return false;
    }

    private async fetchInitialReadReceiptConfig(): Promise<ReadReceiptConfig> {
        try {
            return resolveReadReceiptConfig(await this.serverReadReceiptService.fetchConfig());
        } catch (err) {
            Logger.error('Server read receipt config is unavailable, using local fallback:', err);
            return resolveReadReceiptConfig();
        }
    }

    private applyReadReceiptConfig(readReceiptConfig: ReadReceiptConfig): void {
        this.readReceiptConfig = readReceiptConfig;
        this.emoji = readReceiptConfig.emoji;
    }

    private async fetchMirrorReactionHiderEmojiName(): Promise<string | null> {
        if (!this.readReceiptConfig.isHybridServerMode || !this.readReceiptConfig.hideMirrorReactionsInWeb || !this.readReceiptConfig.mirrorReactionsEnabled) {
            return null;
        }

        try {
            const status = await this.serverReadReceiptService.fetchEmojiStatus();
            if (status.effective_available && status.effective_emoji_name) {
                return status.effective_emoji_name;
            }
        } catch (err) {
            Logger.error('Mirror emoji status is unavailable, using configured emoji for hider:', err);
        }

        return this.readReceiptConfig.mirrorEmojiName;
    }

    private registerOptionalComponents(registry: PluginRegistry): void {
        if (this.mirrorReactionHiderEmojiName) {
            const mirrorEmojiName = this.mirrorReactionHiderEmojiName;
            const MirrorReactionHiderComponent = (): React.ReactElement => React.createElement(MirrorReactionHider, {emojiName: mirrorEmojiName});
            this.mirrorReactionHiderComponentId = registry.registerRootComponent(MirrorReactionHiderComponent);
        }

        if (this.readReceiptConfig.isServerMode) {
            this.readReceiptDomFallbackComponentId = registry.registerRootComponent(ReadReceiptDomFallback);
        }
    }

    public uninitialize() {
        Logger.log('uninitialize');
        window.removeEventListener('focus', this.focusHandler);
        window.removeEventListener('blur', this.blurHandler);
        document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
        window.removeEventListener('online', this.onlineHandler);
        window.removeEventListener('offline', this.offlineHandler);
        this.registry?.unregisterWebSocketEventHandler('multiple_channels_viewed');
        this.registry?.unregisterWebSocketEventHandler('thread_read_changed');
        if (this.serverWebSocketHandlersRegistered) {
            this.registry?.unregisterWebSocketEventHandler(READ_RECEIPT_UPDATED_WEBSOCKET_EVENT);
            this.registry?.unregisterWebSocketEventHandler(READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT);
            this.serverWebSocketHandlersRegistered = false;
        }
        if (this.mirrorReactionHiderComponentId) {
            this.registry?.unregisterComponent(this.mirrorReactionHiderComponentId);
            this.mirrorReactionHiderComponentId = null;
        }
        if (this.readReceiptDomFallbackComponentId) {
            this.registry?.unregisterComponent(this.readReceiptDomFallbackComponentId);
            this.readReceiptDomFallbackComponentId = null;
        }
        this.registry = null;
        this.store = null;
        this.reactionService = null;
        this.operationQueues.clear();
        this.readState.clear();
    }

    private async enqueueOperation(key: string, operation: () => Promise<void>): Promise<void> {
        const previousOperation = this.operationQueues.get(key) || Promise.resolve();
        const nextOperation = previousOperation.catch((err) => {
            Logger.error(`Queued operation ${key} failed before next operation:`, err);
        }).then(operation);

        this.operationQueues.set(key, nextOperation);

        try {
            await nextOperation;
        } finally {
            if (this.operationQueues.get(key) === nextOperation) {
                this.operationQueues.delete(key);
            }
        }
    }

    private async processViewedChannel(channelId: string, lastPost: unknown, viewedAt?: number): Promise<void> {
        Logger.log('lastPost for channel', channelId, lastPost);

        if (!isValidPost(lastPost)) {
            Logger.log('lastPost invalid');
            return;
        }

        if (!this.readState.isWindowActive()) {
            // Own posts proceed even when inactive (consistent with thread processing).
            if (this.ensureCurrentUser() && lastPost.user_id === this.me.id) {
                Logger.log('window inactive but last post is own, proceeding');
            } else {
                this.readState.addDeferredChannel(channelId, viewedAt);
                Logger.log('window inactive, deferred channel', channelId);
                return;
            }
        }

        if (this.readReceiptConfig.isServerMode) {
            await this.processServerViewedChannel(channelId, lastPost, viewedAt);
            return;
        }

        if (!this.ensureCurrentUser()) {
            Logger.log('user not available, skipping legacy channel processing');
            return;
        }

        const storageLastPostId = Storage.getLastPostId(channelId);
        const lastReactedPostId = this.readState.getLastReactedPost(channelId);
        Logger.log('storageLastPostId', storageLastPostId, 'lastReactedPostId', lastReactedPostId, 'lastPost.id', lastPost.id);

        if (lastPost.user_id === this.me.id) {
            await this.processOwnChannelPost(channelId, lastPost, lastReactedPostId, storageLastPostId);
            return;
        }

        if (lastReactedPostId === lastPost.id || storageLastPostId === lastPost.id || this.hasOwnReadReaction(lastPost)) {
            Logger.log('already reacted on this post, skip');
            this.rememberChannelPost(channelId, lastPost.id);
            return;
        }

        const oldReactionRemoved = await this.removeOldChannelReaction(lastReactedPostId, storageLastPostId);
        if (!oldReactionRemoved) {
            return;
        }

        const added = await this.addReadReaction(lastPost.id);
        if (!added) {
            return;
        }

        this.rememberChannelPost(channelId, lastPost.id);
    }

    private async processServerViewedChannel(channelId: string, lastPost: Post, viewedAt?: number): Promise<void> {
        const marked = await this.markServerReadState({
            channelId,
            lastReadPostId: lastPost.id,
            scopeType: 'channel',
        });
        if (!marked) {
            return;
        }

        this.rememberChannelPost(channelId, lastPost.id);
        if (typeof viewedAt === 'number') {
            Storage.setLastViewed(channelId, viewedAt);
        }
    }

    private async processOwnChannelPost(channelId: string, lastPost: Post, lastReactedPostId: string | undefined, storageLastPostId: string | null): Promise<void> {
        const oldReactionRemoved = await this.removeOldChannelReaction(lastReactedPostId, storageLastPostId, lastPost.id);
        if (!oldReactionRemoved) {
            Logger.log('old reaction was not removed, skip state update');
            return;
        }

        this.rememberChannelPost(channelId, lastPost.id);
        Logger.log('lastPost is mine, skip adding reaction');
    }

    private rememberChannelPost(channelId: string, postId: string): void {
        this.readState.setLastReactedPost(channelId, postId);
        Storage.setLastPostId(channelId, postId);
    }

    private async addReadReaction(postId: string): Promise<boolean> {
        Logger.log('adding reaction to', postId);
        if (!this.reactionService) {
            Logger.error('ReactionService is not initialized');
            return false;
        }

        return this.reactionService.add(postId);
    }

    private async removeOldChannelReaction(lastReactedPostId: string | undefined, storageLastPostId: string | null, currentPostId?: string): Promise<boolean> {
        if (!this.reactionService) {
            Logger.error('ReactionService is not initialized');
            return false;
        }

        if (lastReactedPostId && lastReactedPostId !== currentPostId) {
            Logger.log('removing old reaction from', lastReactedPostId);
            return this.reactionService.remove(lastReactedPostId);
        }

        if (storageLastPostId && storageLastPostId !== currentPostId) {
            Logger.log('removing old reaction from storage', storageLastPostId);
            return this.reactionService.remove(storageLastPostId);
        }

        return true;
    }

    private async markServerReadState(request: MarkReadStateRequest): Promise<boolean> {
        try {
            await this.serverReadReceiptService.markReadState(request);
            return true;
        } catch (err) {
            Logger.error('Failed to update server read state:', err);
            return false;
        }
    }

    private async markServerThreadReadState(threadId: string, lastPost: Post): Promise<void> {
        await this.markServerReadState({
            channelId: lastPost.channel_id,
            lastReadPostId: lastPost.id,
            scopeType: 'thread',
            threadId,
        });
    }

    /**
     * Обрабатывает тред: удаляет старые реакции и ставит на последний пост.
     */
    private async processThread(threadId: string): Promise<void> {
        Logger.log('processThread', threadId);
        try {
            await this.enqueueOperation(`thread:${threadId}`, async () => {
                const postList = await this.postService.getSortedThreadPosts(threadId);
                await this.processLoadedThread(threadId, postList);
            });
        } catch (err) {
            Logger.error(`Error processing thread ${threadId}:`, err);
        }
    }

    private async processLoadedThread(threadId: string, postList: Post[]): Promise<void> {
        Logger.log('postList length', postList.length);

        // Тред без ответов — нечего маркировать
        if (postList.length === 0) {
            Logger.log('postList empty');
            return;
        }

        const lastPost = postList[postList.length - 1];
        Logger.log('lastPost', lastPost?.id, lastPost?.user_id);
        if (!isValidPost(lastPost)) {
            Logger.log('lastPost invalid');
            return;
        }

        if (!this.ensureCurrentUser()) {
            Logger.log('user not available, skipping thread processing');
            return;
        }

        const isLastPostByMe = lastPost.user_id === this.me.id;
        Logger.log('isLastPostByMe', isLastPostByMe, 'windowActive', this.readState.isWindowActive());

        // Окно неактивно и последний пост не наш — запоминаем тред для обработки при фокусе
        if (!this.readState.isWindowActive() && !isLastPostByMe) {
            this.readState.setCurrentThreadId(threadId);
            Logger.log('window inactive, saved threadId for later');
            return;
        }

        await this.processThreadPosts(threadId, postList);
        this.readState.setCurrentThreadId(null);
    }

    /**
     * Удаляет старые read-reaction в треде и ставит на последний пост (если он не наш).
     */
    private async processThreadPosts(threadId: string, postList: Post[]): Promise<void> {
        Logger.log('processThreadPosts count', postList.length);
        this.readState.setIsProcessingThread(true);
        try {
            const lastPost = postList[postList.length - 1];
            if (!isValidPost(lastPost)) {
                Logger.log('lastPost invalid in processThreadPosts');
                return;
            }

            const isLastPostByMe = lastPost.user_id === this.me.id;
            const lastPostAlreadyReacted = this.hasOwnReadReaction(lastPost);
            Logger.log('isLastPostByMe', isLastPostByMe);

            if (this.readReceiptConfig.isServerMode) {
                await this.markServerThreadReadState(threadId, lastPost);
                return;
            }

            // Находим все посты в треде, где уже стоит наша реакция
            const postsToClean = new Set<string>();
            for (const post of postList) {
                if (!post.metadata?.reactions) {
                    continue;
                }
                for (const reaction of post.metadata.reactions) {
                    if (reaction.user_id !== this.me.id || reaction.emoji_name !== this.emoji) {
                        continue;
                    }
                    if (!isLastPostByMe && lastPostAlreadyReacted && reaction.post_id === lastPost.id) {
                        continue;
                    }
                    postsToClean.add(reaction.post_id);
                }
            }
            Logger.log('postsToClean', Array.from(postsToClean));

            // Удаляем реакции последовательно
            if (!this.reactionService) {
                Logger.error('ReactionService is not initialized');
                return;
            }

            const oldReactionsRemoved = await this.reactionService.removeFromPosts(Array.from(postsToClean));
            if (!oldReactionsRemoved) {
                return;
            }

            // Ставим на последний пост, если он не наш
            if (isLastPostByMe) {
                Logger.log('last post is mine, skip reaction');
            } else if (lastPostAlreadyReacted) {
                Logger.log('last post already has my reaction, skip adding reaction');
            } else {
                await this.addReadReaction(lastPost.id);
            }
        } finally {
            this.readState.setIsProcessingThread(false);
        }
    }

    private hasOwnReadReaction(post: Post): boolean {
        if (!this.me?.id) {
            return false;
        }
        if (!post.metadata?.reactions) {
            return false;
        }

        for (const reaction of post.metadata.reactions) {
            if (reaction.user_id === this.me.id && reaction.emoji_name === this.emoji) {
                return true;
            }
        }

        return false;
    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());
