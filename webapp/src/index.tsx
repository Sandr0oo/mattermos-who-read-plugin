import {Store, Action} from 'redux';
import {GlobalState} from 'mattermost-redux/types/store';

import {getLastPostPerChannel} from 'mattermost-redux/selectors/entities/posts';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';
import {Post} from 'mattermost-redux/types/posts';
import {UserProfile} from 'mattermost-redux/types/users';

import {PluginRegistry} from '@/types/mattermost-webapp';
import manifest from '@/manifest';

import Storage from './utils/Storage';
import Logger from './utils/Logger';
import {isValidPost} from './utils/Guards';
import ReadState from './services/ReadState';
import PostService from './services/PostService';
import ReactionService from './services/ReactionService';

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
    private emoji = 'eyes';
    private readState = new ReadState();
    private postService!: PostService;
    private reactionService!: ReactionService;
    private registry: PluginRegistry | null = null;
    private operationQueues = new Map<string, Promise<void>>();

    // Ссылки на обработчики для cleanup в uninitialize
    private focusHandler = async (): Promise<void> => {
        Logger.log('window focus');
        this.readState.setWindowIsActive(true);
        const threadId = this.readState.getCurrentThreadId();
        if (threadId && !this.readState.isProcessing()) {
            await this.processThread(threadId);
            this.readState.setCurrentThreadId(null);
        }
    };

    private blurHandler = (): void => {
        Logger.log('window blur');
        this.readState.setWindowIsActive(false);
    };

    public async initialize(registry: PluginRegistry, store: Store<GlobalState, Action<Record<string, unknown>>>) {
        Logger.log('initialize start');
        this.registry = registry;
        const me = getCurrentUser(store.getState());
        Logger.log('current user from store', me?.id);
        if (!me?.id) {
            Logger.error('Failed to get current user from store');
            return;
        }
        this.me = me;
        Logger.log('current user id', this.me.id);

        this.postService = new PostService(store);
        this.reactionService = new ReactionService(store, this.readState, this.emoji);

        window.addEventListener('focus', this.focusHandler);
        window.addEventListener('blur', this.blurHandler);

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

                // Сохраняем время просмотра
                Object.entries(channelTimes).forEach(([channelId, timestamp]) => {
                    Storage.setLastViewed(channelId, timestamp);
                });

                const currentStore = store.getState();
                const lastPostsInChannel = getLastPostPerChannel(currentStore);
                Logger.log('lastPostsInChannel keys', Object.keys(lastPostsInChannel || {}));

                for (const channelId of channelIds) {
                    // eslint-disable-next-line no-await-in-loop
                    await this.enqueueOperation(`channel:${channelId}`, async () => {
                        await this.processViewedChannel(channelId, lastPostsInChannel[channelId]);
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

        Logger.log('initialize done');
    }

    public uninitialize() {
        Logger.log('uninitialize');
        window.removeEventListener('focus', this.focusHandler);
        window.removeEventListener('blur', this.blurHandler);
        this.registry?.unregisterWebSocketEventHandler('multiple_channels_viewed');
        this.registry?.unregisterWebSocketEventHandler('thread_read_changed');
        this.registry = null;
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

    private async processViewedChannel(channelId: string, lastPost: unknown): Promise<void> {
        Logger.log('lastPost for channel', channelId, lastPost);

        if (!isValidPost(lastPost)) {
            Logger.log('lastPost invalid');
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
        return this.reactionService.add(postId);
    }

    private async removeOldChannelReaction(lastReactedPostId: string | undefined, storageLastPostId: string | null, currentPostId?: string): Promise<boolean> {
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

        const isLastPostByMe = lastPost.user_id === this.me.id;
        Logger.log('isLastPostByMe', isLastPostByMe, 'windowActive', this.readState.isWindowActive());

        // Окно неактивно и последний пост не наш — запоминаем тред для обработки при фокусе
        if (!this.readState.isWindowActive() && !isLastPostByMe) {
            this.readState.setCurrentThreadId(threadId);
            Logger.log('window inactive, saved threadId for later');
            return;
        }

        await this.processThreadPosts(postList);
        this.readState.setCurrentThreadId(null);
    }

    /**
     * Удаляет старые реакции :eyes: в треде и ставит на последний пост (если он не наш).
     */
    private async processThreadPosts(postList: Post[]): Promise<void> {
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
