import {addReaction, removeReaction} from 'mattermost-redux/actions/posts';

import {AppStore, dispatchAsync} from '../utils/Dispatch';

import ReadState from './ReadState';

const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 1;

export default class ReactionService {
    private readonly store: AppStore;
    private readonly readState: ReadState;
    private readonly emoji: string;

    constructor(store: AppStore, readState: ReadState, emoji: string) {
        this.store = store;
        this.readState = readState;
        this.emoji = emoji;
    }

    private async dispatchWithRetry(dispatchFn: () => any, retries = MAX_RETRIES): Promise<void> {
        try {
            await dispatchFn();
        } catch (err) {
            if (retries > 0) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                await this.dispatchWithRetry(dispatchFn, retries - 1);
            } else {
                throw err;
            }
        }
    }

    async add(postId: string): Promise<void> {
        if (!postId || this.readState.isPending(postId)) {
            return;
        }
        this.readState.addPending(postId);
        try {
            await this.dispatchWithRetry(() => dispatchAsync(this.store, addReaction(postId, this.emoji)));
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[WhoReadPlugin] Failed to add reaction on post ${postId}:`, err);
        } finally {
            this.readState.removePending(postId);
        }
    }

    async remove(postId: string): Promise<void> {
        if (!postId || this.readState.isPending(postId)) {
            return;
        }
        this.readState.addPending(postId);
        try {
            await this.dispatchWithRetry(() => dispatchAsync(this.store, removeReaction(postId, this.emoji)));
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[WhoReadPlugin] Failed to remove reaction on post ${postId}:`, err);
        } finally {
            this.readState.removePending(postId);
        }
    }

    /**
     * Удаляет реакцию текущего пользователя со всех указанных постов.
     * Выполняется последовательно (for…of + await), чтобы избежать гонок.
     */
    async removeFromPosts(postIds: string[]): Promise<void> {
        for (const postId of postIds) {
            // eslint-disable-next-line no-await-in-loop
            await this.remove(postId);
        }
    }
}
