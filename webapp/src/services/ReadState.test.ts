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
        state.setLastViewed('channel-id', 123);
        state.addPending('post-id');

        expect(state.isWindowActive()).toBe(true);
        expect(state.isProcessing()).toBe(true);
        expect(state.getCurrentThreadId()).toBe('thread-id');
        expect(state.getLastReactedPost('channel-id')).toBe('post-id');
        expect(state.getLastViewed('channel-id')).toBe(123);
        expect(state.isPending('post-id')).toBe(true);
    });

    it('documents current canReactToPost guards', () => {
        const state = new ReadState();

        expect(state.canReactToPost('channel-id', '', null)).toBe(false);

        state.addPending('post-id');
        expect(state.canReactToPost('channel-id', 'post-id', null)).toBe(false);

        state.removePending('post-id');
        state.setLastReactedPost('channel-id', 'post-id');
        expect(state.canReactToPost('channel-id', 'post-id', null)).toBe(false);
        expect(state.canReactToPost('channel-id', 'other-post-id', 'other-post-id')).toBe(false);
        expect(state.canReactToPost('channel-id', 'new-post-id', 'post-id')).toBe(true);
    });

    it('clears all in-memory state', () => {
        const state = new ReadState();

        state.setWindowIsActive(true);
        state.setCurrentThreadId('thread-id');
        state.setIsProcessingThread(true);
        state.setLastReactedPost('channel-id', 'post-id');
        state.setLastViewed('channel-id', 123);
        state.addPending('post-id');

        state.clear();

        expect(state.isWindowActive()).toBe(false);
        expect(state.isProcessing()).toBe(false);
        expect(state.getCurrentThreadId()).toBeNull();
        expect(state.getLastReactedPost('channel-id')).toBeUndefined();
        expect(state.getLastViewed('channel-id')).toBeUndefined();
        expect(state.isPending('post-id')).toBe(false);
    });
});
