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

const CACHE_TTL_MS = 30_000; // 30 seconds

const service = new ServerReadReceiptService();
const cache = new Map<string, {data: CachedPostReaders; expiresAt: number}>();
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
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.data);
    }

    // Cache miss or expired — remove stale entry
    if (cached) {
        cache.delete(postId);
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
        const expiresAt = Date.now() + CACHE_TTL_MS;
        for (const postId of postIds) {
            const postReaders = response.posts?.[postId];
            const data = {
                count: postReaders?.count || 0,
                readers: postReaders?.readers || [],
            };
            cache.set(postId, {data, expiresAt});
            resolveRequests(requests.get(postId), data);
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
