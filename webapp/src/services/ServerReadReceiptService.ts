import manifest from '@/manifest';

import {ServerReadReceiptConfigResponse} from '../config/ReadReceiptConfig';
import Logger from '../utils/Logger';

export const SERVER_READ_RECEIPT_API_PREFIX = `/plugins/${manifest.id}/api/v1`;

export type ReadReceiptScopeType = 'channel' | 'thread';

export interface MarkReadStateRequest {
    scopeType: ReadReceiptScopeType;
    channelId: string;
    threadId?: string;
    lastReadPostId: string;
}

export interface ServerReadStateResult {
    user_id: string;
    scope_type: ReadReceiptScopeType;
    scope_id: string;
    channel_id: string;
    post_id: string;
    previous_post_id?: string;
    updated_at: number;
    mirror_reaction: string;
    mirror_emoji_name?: string;
}

export interface MarkReadStateResponse {
    status: string;
    data: ServerReadStateResult;
}

export interface ReaderInfo {
    user_id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    updated_at: number;
}

export interface PostReadersResponse {
    post_id: string;
    count: number;
    readers: ReaderInfo[];
}

export interface ReadersBatchResponse {
    posts: Record<string, PostReadersResponse>;
    max_readers_per_post: number;
}

export interface MirrorEmojiStatusResponse {
    configured_emoji_name: string;
    configured_available: boolean;
    effective_emoji_name: string;
    effective_available: boolean;
    fallback_used: boolean;
    fallback_emoji_name?: string;
    error?: string;
}

export default class ServerReadReceiptService {
    async fetchConfig(): Promise<ServerReadReceiptConfigResponse> {
        try {
            return await this.requestJSON<ServerReadReceiptConfigResponse>('/config', {
                method: 'GET',
            });
        } catch (err) {
            Logger.error('Failed to fetch read receipt config:', err);
            throw err;
        }
    }

    async fetchEmojiStatus(): Promise<MirrorEmojiStatusResponse> {
        try {
            return await this.requestJSON<MirrorEmojiStatusResponse>('/emoji/status', {
                method: 'GET',
            });
        } catch (err) {
            Logger.error('Failed to fetch mirror emoji status:', err);
            throw err;
        }
    }

    async markReadState(request: MarkReadStateRequest): Promise<MarkReadStateResponse> {
        try {
            return await this.requestJSON<MarkReadStateResponse>('/read-state', {
                body: JSON.stringify({
                    scope_type: request.scopeType,
                    channel_id: request.channelId,
                    thread_id: request.threadId,
                    last_read_post_id: request.lastReadPostId,
                }),
                method: 'POST',
            });
        } catch (err) {
            Logger.error('Failed to mark read state on server:', err);
            throw err;
        }
    }

    async fetchReaders(postIds: string[]): Promise<ReadersBatchResponse> {
        const uniquePostIds = Array.from(new Set(postIds.filter(Boolean)));
        if (uniquePostIds.length === 0) {
            return {posts: {}, max_readers_per_post: 0};
        }

        try {
            return await this.requestJSON<ReadersBatchResponse>('/readers/batch', {
                body: JSON.stringify({post_ids: uniquePostIds}),
                method: 'POST',
            });
        } catch (err) {
            Logger.error('Failed to fetch read receipt readers:', err);
            throw err;
        }
    }

    private async requestJSON<T>(path: string, init: RequestInit): Promise<T> {
        if (typeof fetch !== 'function') {
            throw new Error('fetch is not available');
        }

        const response = await fetch(`${SERVER_READ_RECEIPT_API_PREFIX}${path}`, {
            ...init,
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                ...(init.body ? {'Content-Type': 'application/json'} : {}),
                'X-Requested-With': 'XMLHttpRequest',
                ...init.headers,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await this.readErrorMessage(response)}`);
        }

        return response.json() as Promise<T>;
    }

    private async readErrorMessage(response: Response): Promise<string> {
        try {
            const payload = await response.json();
            if (payload && typeof payload.error === 'string') {
                return payload.error;
            }
        } catch {
            // Пробуем ниже прочитать text(), если тело не JSON.
        }

        try {
            const text = await response.text();
            return text || response.statusText || 'request failed';
        } catch {
            return response.statusText || 'request failed';
        }
    }
}
