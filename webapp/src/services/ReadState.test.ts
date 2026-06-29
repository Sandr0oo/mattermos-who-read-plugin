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
