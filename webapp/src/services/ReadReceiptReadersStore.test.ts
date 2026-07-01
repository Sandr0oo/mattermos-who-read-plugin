/* eslint-disable max-nested-callbacks */

import {SERVER_READ_RECEIPT_API_PREFIX} from './ServerReadReceiptService';
import {clearReadReceiptReadersCache, fetchReadReceiptReaders} from './ReadReceiptReadersStore';

const postAID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const postBID = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

jest.mock('@/manifest', () => ({
    id: 'com.mattermost.who-read-plugin',
    version: 'test',
}), {virtual: true});

function createFetchResponse(body: unknown) {
    return Promise.resolve({
        json: jest.fn(() => Promise.resolve(body)),
        ok: true,
        status: 200,
        statusText: 'OK',
        text: jest.fn(() => Promise.resolve(JSON.stringify(body))),
    });
}

describe('ReadReceiptReadersStore', () => {
    beforeEach(() => {
        clearReadReceiptReadersCache();
        jest.clearAllMocks();
    });

    it('batches readers requests made in the same tick', async () => {
        const fetchMock = jest.fn(() => createFetchResponse({
            max_readers_per_post: 50,
            posts: {
                [postAID]: {count: 1, readers: [{user_id: 'userA', updated_at: 1}]},
                [postBID]: {count: 2, readers: []},
            },
        }));
        (global as any).fetch = fetchMock;

        const [postA, postB] = await Promise.all([
            fetchReadReceiptReaders(postAID),
            fetchReadReceiptReaders(postBID),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect(JSON.parse(String(init.body))).toEqual({post_ids: [postAID, postBID]});
        expect(postA.count).toBe(1);
        expect(postB.count).toBe(2);
    });

    it('serves cached readers without another request', async () => {
        const fetchMock = jest.fn(() => createFetchResponse({
            max_readers_per_post: 50,
            posts: {
                [postAID]: {count: 1, readers: []},
            },
        }));
        (global as any).fetch = fetchMock;

        await fetchReadReceiptReaders(postAID);
        await fetchReadReceiptReaders(postAID);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER_READ_RECEIPT_API_PREFIX}/readers/batch`, expect.objectContaining({method: 'POST'}));
    });

    it('does not request readers for invalid post ids', async () => {
        const fetchMock = jest.fn(() => createFetchResponse({max_readers_per_post: 50, posts: {}}));
        (global as any).fetch = fetchMock;

        const readers = await fetchReadReceiptReaders('invalid_id');

        expect(readers).toEqual({count: 0, readers: []});
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
