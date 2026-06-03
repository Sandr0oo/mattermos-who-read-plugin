export default class ReadState {
    private lastReactedPost = new Map<string, string>();
    private lastChannelsViewed = new Map<string, number>();
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

    setLastViewed(channelId: string, timestamp: number): void {
        this.lastChannelsViewed.set(channelId, timestamp);
    }

    getLastViewed(channelId: string): number | undefined {
        return this.lastChannelsViewed.get(channelId);
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

    /**
     * Проверяет, можем ли мы проставить реакцию на данный пост в канале.
     * Возвращает true, если:
     * - пост валиден
     * - нет pending-операции на этом посте
     * - реакция ещё не стоит на этом посте
     */
    canReactToPost(channelId: string, postId: string, storageLastPostId: string | null): boolean {
        if (!postId) {
            return false;
        }
        if (this.isPending(postId)) {
            return false;
        }
        const lastReacted = this.getLastReactedPost(channelId);
        if (lastReacted === postId) {
            return false;
        }
        if (storageLastPostId === postId) {
            return false;
        }
        return true;
    }

    clear(): void {
        this.lastReactedPost.clear();
        this.lastChannelsViewed.clear();
        this.pendingReactions.clear();
        this.currentOpenThreadId = null;
        this.windowIsActive = false;
        this.isProcessingThread = false;
    }
}
