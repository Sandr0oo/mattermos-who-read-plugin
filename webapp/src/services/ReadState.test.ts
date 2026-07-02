import ReadState from './ReadState';

describe('ReadState', () => {
    it('stores window, thread, read and pending state', () => {
        const state = new ReadState();

        expect(state.isWindowActive()).toBe(false);
        expect(state.isProcessing()).toBe(false);
        expect(state.getCurrentThreadId()).toBeNull();

        state.setWindowIsActive(true);
        state.setCurrentThreadId('thread-id');
        state.setIsProcessingThread(true);
        state.setLastReactedPost('channel-id', 'post-id');
        state.addPending('post-id');

        expect(state.isWindowActive()).toBe(true);
        expect(state.isProcessing()).toBe(true);
        expect(state.getCurrentThreadId()).toBe('thread-id');
        expect(state.getLastReactedPost('channel-id')).toBe('post-id');
        expect(state.isPending('post-id')).toBe(true);
    });

    it('stores and clears deferred channels', () => {
        const state = new ReadState();

        expect(state.getDeferredChannelsAndClear()).toEqual([]);

        state.addDeferredChannel('channel-a', 123);
        state.addDeferredChannel('channel-b', 456);

        const channels = state.getDeferredChannelsAndClear();
        expect(channels).toEqual([
            {channelId: 'channel-a', viewedAt: 123},
            {channelId: 'channel-b', viewedAt: 456},
        ]);

        // Second call returns empty (was cleared)
        expect(state.getDeferredChannelsAndClear()).toEqual([]);
    });

    it('clears deferred channels on clear()', () => {
        const state = new ReadState();

        state.addDeferredChannel('channel-a', 123);
        state.clear();

        expect(state.getDeferredChannelsAndClear()).toEqual([]);
    });

    it('clears all in-memory state', () => {
        const state = new ReadState();

        state.setWindowIsActive(true);
        state.setCurrentThreadId('thread-id');
        state.setIsProcessingThread(true);
        state.setLastReactedPost('channel-id', 'post-id');
        state.addPending('post-id');

        state.clear();

        expect(state.isWindowActive()).toBe(false);
        expect(state.isProcessing()).toBe(false);
        expect(state.getCurrentThreadId()).toBeNull();
        expect(state.getLastReactedPost('channel-id')).toBeUndefined();
        expect(state.isPending('post-id')).toBe(false);
    });
});
