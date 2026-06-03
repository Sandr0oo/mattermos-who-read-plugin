import {Post} from 'mattermost-redux/types/posts';

export function assertPost(post: Post | undefined | null): asserts post is Post {
    if (!post || typeof post.id !== 'string') {
        throw new Error('Expected a valid Post, but received undefined or invalid object');
    }
}

export function assertNonEmptyThread(posts: Post[]): asserts posts is [Post, ...Post[]] {
    if (!posts || posts.length === 0) {
        throw new Error('Expected a non-empty thread, but received empty array');
    }
}

export function isValidPost(post: unknown): post is Post {
    const p = post as any;
    return Boolean(p && typeof p.id === 'string' && typeof p.user_id === 'string');
}
