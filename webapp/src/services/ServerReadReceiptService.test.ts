/* eslint-disable max-nested-callbacks */

import {ReadReceiptMode} from '../config/ReadReceiptConfig';
import Logger from '../utils/Logger';

import ServerReadReceiptService, {SERVER_READ_RECEIPT_API_PREFIX} from './ServerReadReceiptService';

jest.mock('@/manifest', () => ({
    id: 'com.mattermost.who-read-plugin',
    version: 'test',
}), {virtual: true});

function createFetchResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
    return Promise.resolve({
        json: jest.fn(() => Promise.resolve(body)),
        ok,
        status,
        statusText: ok ? 'OK' : 'Internal Server Error',
        text: jest.fn(() => Promise.resolve(JSON.stringify(body))),
    });
}

function expectFetchBody(fetchMock: jest.Mock, body: Record<string, unknown>) {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(body);
}

describe('ServerReadReceiptService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('fetches server config with plugin API prefix and same-origin credentials', async () => {
        const fetchMock = jest.fn(() => createFetchResponse({readReceiptMode: ReadReceiptMode.HybridServer}));
        (global as any).fetch = fetchMock;

        const config = await new ServerReadReceiptService().fetchConfig();

        expect(config).toEqual({readReceiptMode: ReadReceiptMode.HybridServer});
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER_READ_RECEIPT_API_PREFIX}/config`, expect.objectContaining({
            credentials: 'same-origin',
            headers: expect.objectContaining({'X-Requested-With': 'XMLHttpRequest'}),
            method: 'GET',
        }));
    });

    it('fetches effective mirror emoji status', async () => {
        const body = {
            configured_available: false,
            configured_emoji_name: 'who_read_eyes',
            effective_available: true,
            effective_emoji_name: 'eyes',
            fallback_used: true,
        };
        const fetchMock = jest.fn(() => createFetchResponse(body));
        (global as any).fetch = fetchMock;

        const status = await new ServerReadReceiptService().fetchEmojiStatus();

        expect(status).toEqual(body);
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER_READ_RECEIPT_API_PREFIX}/emoji/status`, expect.objectContaining({
            credentials: 'same-origin',
            method: 'GET',
        }));
    });

    it('marks read state with snake_case request body', async () => {
        const fetchMock = jest.fn(() => createFetchResponse({data: {post_id: 'post-id'}, status: 'ok'}));
        (global as any).fetch = fetchMock;

        await new ServerReadReceiptService().markReadState({
            channelId: 'channel-id',
            lastReadPostId: 'post-id',
            scopeType: 'thread',
            threadId: 'thread-id',
        });

        expect(fetchMock).toHaveBeenCalledWith(`${SERVER_READ_RECEIPT_API_PREFIX}/read-state`, expect.objectContaining({
            credentials: 'same-origin',
            method: 'POST',
        }));
        expectFetchBody(fetchMock, {
            channel_id: 'channel-id',
            last_read_post_id: 'post-id',
            scope_type: 'thread',
            thread_id: 'thread-id',
        });
    });

    it('deduplicates post ids when fetching readers', async () => {
        const fetchMock = jest.fn(() => createFetchResponse({
            max_readers_per_post: 50,
            posts: {},
        }));
        (global as any).fetch = fetchMock;

        await new ServerReadReceiptService().fetchReaders(['post-id', 'post-id', '']);

        expect(fetchMock).toHaveBeenCalledWith(`${SERVER_READ_RECEIPT_API_PREFIX}/readers/batch`, expect.objectContaining({
            credentials: 'same-origin',
            method: 'POST',
        }));
        expectFetchBody(fetchMock, {post_ids: ['post-id']});
    });

    it('logs and rethrows failed requests', async () => {
        const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(jest.fn());
        (global as any).fetch = jest.fn(() => createFetchResponse({error: 'boom'}, false, 500));

        await expect(new ServerReadReceiptService().fetchConfig()).rejects.toThrow('HTTP 500: boom');

        expect(errorSpy).toHaveBeenCalledWith('Failed to fetch read receipt config:', expect.any(Error));
        errorSpy.mockRestore();
    });
});
