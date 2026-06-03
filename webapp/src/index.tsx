import {Store, Action} from 'redux';
import {GlobalState} from 'mattermost-redux/types/store';
import {WebSocketMessage} from '@mattermost/types/lib/websocket';

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

interface ChannelTimes {
    [channelId: string]: number;
}

export default class Plugin {
    private me: UserProfile = {} as UserProfile;
    private emoji = 'eyes';
    private readState = new ReadState();
    private postService!: PostService;
    private reactionService!: ReactionService;

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

        registry.registerWebSocketEventHandler('multiple_channels_viewed', async (event: any) => {
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
                    this.readState.setLastViewed(channelId, timestamp as number);
                    Storage.setLastViewed(channelId, timestamp as number);
                });

                const currentStore = store.getState();
                const lastPostsInChannel = getLastPostPerChannel(currentStore);
                Logger.log('lastPostsInChannel keys', Object.keys(lastPostsInChannel || {}));

                // Берём первый канал из события (как в оригинале)
                const channelIdEvent = channelIds[0];
                const lastPost = lastPostsInChannel[channelIdEvent];
                Logger.log('lastPost for channel', channelIdEvent, lastPost);

                if (!isValidPost(lastPost)) {
                    Logger.log('lastPost invalid');
                    return;
                }

                const storageLastPostId = Storage.getLastPostId(channelIdEvent);
                const lastReactedPostId = this.readState.getLastReactedPost(channelIdEvent);
                Logger.log('storageLastPostId', storageLastPostId, 'lastReactedPostId', lastReactedPostId, 'lastPost.id', lastPost.id);

                // Если последний пост — наш, удаляем старую реакцию (если была на другом посте)
                // и обновляем состояние, но не ставим новую реакцию на свой пост
                if (lastPost.user_id === this.me.id) {
                    if (lastReactedPostId && lastReactedPostId !== lastPost.id) {
                        Logger.log('mine: removing old reaction from', lastReactedPostId);
                        await this.reactionService.remove(lastReactedPostId);
                    } else if (storageLastPostId && storageLastPostId !== lastPost.id) {
                        Logger.log('mine: removing old reaction from storage', storageLastPostId);
                        await this.reactionService.remove(storageLastPostId);
                    }
                    this.readState.setLastReactedPost(channelIdEvent, lastPost.id);
                    Storage.setLastPostId(channelIdEvent, lastPost.id);
                    Logger.log('lastPost is mine, skip adding reaction');
                    return;
                }

                // Уже есть реакция на этом посте — пропускаем
                if (lastReactedPostId === lastPost.id || storageLastPostId === lastPost.id) {
                    Logger.log('already reacted on this post, skip');
                    return;
                }

                // Удаляем старую реакцию
                if (lastReactedPostId) {
                    Logger.log('removing old reaction from', lastReactedPostId);
                    await this.reactionService.remove(lastReactedPostId);
                } else if (storageLastPostId) {
                    Logger.log('removing old reaction from storage', storageLastPostId);
                    await this.reactionService.remove(storageLastPostId);
                }

                // Ставим новую реакцию
                Logger.log('adding reaction to', lastPost.id);
                await this.reactionService.add(lastPost.id);

                // Запоминаем
                this.readState.setLastReactedPost(channelIdEvent, lastPost.id);
                Storage.setLastPostId(channelIdEvent, lastPost.id);
            } catch (err) {
                Logger.error('Error in multiple_channels_viewed handler:', err);
            }
        });

        registry.registerWebSocketEventHandler('thread_read_changed', async (event: any) => {
            Logger.log('thread_read_changed raw event', event);
            try {
                const threadId = event.data?.thread_id as string | undefined;
                Logger.log('threadId', threadId);
                if (!threadId) {
                    return;
                }

                const postList = await this.postService.getSortedThreadPosts(threadId);
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
        this.readState.clear();
    }

    /**
     * Обрабатывает тред: удаляет старые реакции и ставит на последний пост.
     */
    private async processThread(threadId: string): Promise<void> {
        Logger.log('processThread', threadId);
        try {
            const postList = await this.postService.getSortedThreadPosts(threadId);
            if (postList.length === 0) {
                return;
            }
            await this.processThreadPosts(postList);
        } catch (err) {
            Logger.error(`Error processing thread ${threadId}:`, err);
        }
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
            Logger.log('isLastPostByMe', isLastPostByMe);

            // Находим все посты в треде, где уже стоит наша реакция
            const postsToClean: string[] = [];
            for (const post of postList) {
                if (!post.metadata?.reactions) {
                    continue;
                }
                const myReactions = post.metadata.reactions.filter(
                    (r) => r.user_id === this.me.id && r.emoji_name === this.emoji,
                );
                for (const reaction of myReactions) {
                    postsToClean.push(reaction.post_id);
                }
            }
            Logger.log('postsToClean', postsToClean);

            // Удаляем реакции последовательно
            await this.reactionService.removeFromPosts(postsToClean);

            // Ставим на последний пост, если он не наш
            if (isLastPostByMe) {
                Logger.log('last post is mine, skip reaction');
            } else {
                Logger.log('adding reaction to last post', lastPost.id);
                await this.reactionService.add(lastPost.id);
            }
        } finally {
            this.readState.setIsProcessingThread(false);
        }
    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());
