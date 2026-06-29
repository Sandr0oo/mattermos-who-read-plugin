export default class ReadState {
    private lastReactedPost = new Map<string, string>();
    private pendingReactions = new Set<string>();
    private currentOpenThreadId: string | null = null;
    private windowIsActive = false;
    private isProcessingThread = false;

    setWindowIsActive(active: boolean): void {
        this.windowIsActive = active;
    }

    isWindowActive(): boolean {
        return this.windowIsActive;
    }

    setCurrentThreadId(threadId: string | null): void {
        this.currentOpenThreadId = threadId;
    }

    getCurrentThreadId(): string | null {
        return this.currentOpenThreadId;
    }

    setIsProcessingThread(processing: boolean): void {
        this.isProcessingThread = processing;
    }

    isProcessing(): boolean {
        return this.isProcessingThread;
    }

    setLastReactedPost(channelId: string, postId: string): void {
        this.lastReactedPost.set(channelId, postId);
    }

    getLastReactedPost(channelId: string): string | undefined {
        return this.lastReactedPost.get(channelId);
    }

    addPending(postId: string): void {
        this.pendingReactions.add(postId);
    }

    removePending(postId: string): void {
        this.pendingReactions.delete(postId);
    }

    isPending(postId: string): boolean {
        return this.pendingReactions.has(postId);
    }

    clear(): void {
        this.lastReactedPost.clear();
        this.pendingReactions.clear();
        this.currentOpenThreadId = null;
        this.windowIsActive = false;
        this.isProcessingThread = false;
    }
}
