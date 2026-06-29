import {Post} from 'mattermost-redux/types/posts';

export function isValidPost(post: unknown): post is Post {
    const p = post as any;
    return Boolean(p && typeof p.id === 'string' && typeof p.user_id === 'string');
}
