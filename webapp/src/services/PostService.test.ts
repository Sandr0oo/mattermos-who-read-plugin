/* eslint-disable max-nested-callbacks */

import {getPostThread} from 'mattermost-redux/actions/posts';

import {createPost, createStore} from '../../tests/helpers';

import PostService from './PostService';

jest.mock('mattermost-redux/actions/posts', () => ({
    getPostThread: jest.fn((threadId: string) => ({threadId, type: 'GET_POST_THREAD'})),
}));

describe('PostService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('loads, filters, sorts and drops the root post from a thread', async () => {
        const rootPost = createPost({create_at: 100, id: 'root-id'});
        const laterReply = createPost({create_at: 300, id: 'later-reply-id'});
        const earlierReply = createPost({create_at: 200, id: 'earlier-reply-id'});
        const invalidPost = {create_at: 250, id: 'invalid-post-id'};
        const dispatch = jest.fn(() => Promise.resolve({
            data: {
                posts: {
                    earlierReply,
                    invalidPost,
                    laterReply,
                    rootPost,
                },
            },
        }));
        const {store} = createStore({}, dispatch);
        const service = new PostService(store);

        await expect(service.getSortedThreadPosts('thread-id')).resolves.toEqual([earlierReply, laterReply]);
        expect(getPostThread).toHaveBeenCalledWith('thread-id');
        expect(dispatch).toHaveBeenCalledWith({threadId: 'thread-id', type: 'GET_POST_THREAD'});
    });

    it('returns an empty list when the thread has only the root post', async () => {
        const rootPost = createPost({create_at: 100, id: 'root-id'});
        const dispatch = jest.fn(() => Promise.resolve({data: {posts: {rootPost}}}));
        const {store} = createStore({}, dispatch);
        const service = new PostService(store);

        await expect(service.getSortedThreadPosts('thread-id')).resolves.toEqual([]);
    });

    it('rejects invalid thread responses', async () => {
        const dispatch = jest.fn(() => Promise.resolve({data: {posts: null}}));
        const {store} = createStore({}, dispatch);
        const service = new PostService(store);

        await expect(service.getSortedThreadPosts('thread-id')).rejects.toThrow(
            'Failed to load thread posts for threadId=thread-id: invalid response',
        );
    });
});
