import {isValidMattermostId} from '../utils/MattermostIds';

import ServerReadReceiptService, {ReaderInfo} from './ServerReadReceiptService';

export interface CachedPostReaders {
    count: number;
    readers: ReaderInfo[];
}

const EMPTY_READERS: CachedPostReaders = {count: 0, readers: []};

type PendingReaderRequest = {
    resolve: (value: CachedPostReaders) => void;
    reject: (reason?: unknown) => void;
};

const service = new ServerReadReceiptService();
const cache = new Map<string, CachedPostReaders>();
const pendingRequests = new Map<string, PendingReaderRequest[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function clearReadReceiptReadersCache(postIds?: string[]): void {
    if (!postIds) {
        cache.clear();
        return;
    }

    postIds.filter(Boolean).forEach((postId) => cache.delete(postId));
}

export function fetchReadReceiptReaders(postId: string): Promise<CachedPostReaders> {
    if (!isValidMattermostId(postId)) {
        return Promise.resolve(EMPTY_READERS);
    }

    const cached = cache.get(postId);
    if (cached) {
        return Promise.resolve(cached);
    }

    return new Promise((resolve, reject) => {
        const requests = pendingRequests.get(postId) || [];
        requests.push({resolve, reject});
        pendingRequests.set(postId, requests);

        if (!flushTimer) {
            flushTimer = setTimeout(flushPendingReaders, 0);
        }
    });
}

async function flushPendingReaders(): Promise<void> {
    const postIds = Array.from(pendingRequests.keys()).filter(isValidMattermostId);
    const requests = new Map(pendingRequests);
    pendingRequests.clear();
    flushTimer = null;

    try {
        const response = await service.fetchReaders(postIds);
        for (const postId of postIds) {
            const postReaders = response.posts?.[postId];
            const value = {
                count: postReaders?.count || 0,
                readers: postReaders?.readers || [],
            };
            cache.set(postId, value);
            resolveRequests(requests.get(postId), value);
        }
    } catch (err) {
        for (const postId of postIds) {
            rejectRequests(requests.get(postId), err);
        }
    }
}

function resolveRequests(requests: PendingReaderRequest[] | undefined, value: CachedPostReaders): void {
    requests?.forEach((request) => request.resolve(value));
}

function rejectRequests(requests: PendingReaderRequest[] | undefined, err: unknown): void {
    requests?.forEach((request) => request.reject(err));
}
