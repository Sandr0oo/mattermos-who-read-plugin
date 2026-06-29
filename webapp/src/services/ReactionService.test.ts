/* eslint-disable max-nested-callbacks */

import {addReaction, removeReaction} from 'mattermost-redux/actions/posts';

import {createStore, flushPromises} from '../../tests/helpers';

import Logger from '../utils/Logger';

import ReadState from './ReadState';
import ReactionService from './ReactionService';

jest.mock('mattermost-redux/actions/posts', () => ({
    addReaction: jest.fn((postId: string, emoji: string) => ({emoji, postId, type: 'ADD_REACTION'})),
    removeReaction: jest.fn((postId: string, emoji: string) => ({emoji, postId, type: 'REMOVE_REACTION'})),
}));

describe('ReactionService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it('dispatches addReaction and removeReaction with the configured emoji', async () => {
        const dispatch = jest.fn(() => Promise.resolve({}));
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, new ReadState(), 'eyes');

        await service.add('post-id');
        await service.remove('post-id');

        expect(addReaction).toHaveBeenCalledWith('post-id', 'eyes');
        expect(removeReaction).toHaveBeenCalledWith('post-id', 'eyes');
        expect(dispatch).toHaveBeenCalledWith({emoji: 'eyes', postId: 'post-id', type: 'ADD_REACTION'});
        expect(dispatch).toHaveBeenCalledWith({emoji: 'eyes', postId: 'post-id', type: 'REMOVE_REACTION'});
    });

    it('returns operation status from add and remove', async () => {
        const dispatch = jest.fn(() => Promise.resolve({}));
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, new ReadState(), 'eyes');

        await expect(service.add('post-id')).resolves.toBe(true);
        await expect(service.remove('post-id')).resolves.toBe(true);
        await expect(service.add('')).resolves.toBe(false);
        await expect(service.remove('')).resolves.toBe(false);
    });

    it('skips duplicate operations while a post is pending', async () => {
        let resolveDispatch: () => void = jest.fn();
        const dispatch = jest.fn(() => new Promise<void>((resolve) => {
            resolveDispatch = resolve;
        }));
        const readState = new ReadState();
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, readState, 'eyes');

        const firstAdd = service.add('post-id');
        await flushPromises();

        expect(readState.isPending('post-id')).toBe(true);
        await service.add('post-id');
        expect(addReaction).toHaveBeenCalledTimes(1);

        resolveDispatch();
        await firstAdd;
        expect(readState.isPending('post-id')).toBe(false);
    });

    it('retries once and clears pending state after a failed add', async () => {
        jest.useFakeTimers();
        const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(jest.fn());
        const dispatch = jest.fn(() => Promise.reject(new Error('network')));
        const readState = new ReadState();
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, readState, 'eyes');

        const addPromise = service.add('post-id');
        await Promise.resolve();

        expect(readState.isPending('post-id')).toBe(true);

        jest.advanceTimersByTime(500);
        await expect(addPromise).resolves.toBe(false);

        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(readState.isPending('post-id')).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith('Failed to add reaction on post post-id:', expect.any(Error));

        errorSpy.mockRestore();
    });

    it('removes reactions from posts sequentially', async () => {
        const dispatch = jest.fn(() => Promise.resolve({}));
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, new ReadState(), 'eyes');

        await service.removeFromPosts(['old-post-id', 'new-post-id']);

        expect(removeReaction).toHaveBeenNthCalledWith(1, 'old-post-id', 'eyes');
        expect(removeReaction).toHaveBeenNthCalledWith(2, 'new-post-id', 'eyes');
    });

    it('deduplicates removeFromPosts input', async () => {
        const dispatch = jest.fn(() => Promise.resolve({}));
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, new ReadState(), 'eyes');

        await service.removeFromPosts(['old-post-id', '', 'old-post-id', 'new-post-id', 'new-post-id']);

        expect(removeReaction).toHaveBeenCalledTimes(2);
        expect(removeReaction).toHaveBeenNthCalledWith(1, 'old-post-id', 'eyes');
        expect(removeReaction).toHaveBeenNthCalledWith(2, 'new-post-id', 'eyes');
    });

    it('stops removing posts after the first failed remove', async () => {
        jest.useFakeTimers();
        const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(jest.fn());
        const dispatch = jest.fn(() => Promise.reject(new Error('network')));
        const {store} = createStore({}, dispatch);
        const service = new ReactionService(store, new ReadState(), 'eyes');

        const removePromise = service.removeFromPosts(['old-post-id', 'new-post-id']);
        await Promise.resolve();

        jest.advanceTimersByTime(500);
        await expect(removePromise).resolves.toBe(false);

        expect(removeReaction).toHaveBeenCalledTimes(2);
        expect(removeReaction).toHaveBeenCalledWith('old-post-id', 'eyes');
        expect(removeReaction).not.toHaveBeenCalledWith('new-post-id', 'eyes');
        expect(errorSpy).toHaveBeenCalledWith('Failed to remove reaction on post old-post-id:', expect.any(Error));

        errorSpy.mockRestore();
    });
});
