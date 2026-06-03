import {getPostThread} from 'mattermost-redux/actions/posts';
import {Post} from 'mattermost-redux/types/posts';

import {isValidPost} from '../utils/Guards';
import {AppStore, dispatchAsync} from '../utils/Dispatch';

export default class PostService {
    private readonly store: AppStore;

    constructor(store: AppStore) {
        this.store = store;
    }

    /**
     * Получает все посты треда, сортирует по create_at (от ранних к поздним).
     * Исключает головной пост (slice(1)).
     * Если в треде нет ответов — возвращает пустой массив.
     */
    async getSortedThreadPosts(threadId: string): Promise<Post[]> {
        const result = await dispatchAsync(this.store, getPostThread(threadId));
        const posts = result?.data?.posts;

        if (!posts || typeof posts !== 'object') {
            throw new Error(`Failed to load thread posts for threadId=${threadId}: invalid response`);
        }

        const postArray = Object.values(posts).filter(isValidPost) as Post[];
        postArray.sort((a, b) => a.create_at - b.create_at);

        // Убираем головной пост — он виден в основном канале
        return postArray.slice(1);
    }
}
