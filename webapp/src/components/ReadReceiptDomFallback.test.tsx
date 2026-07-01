/** @jest-environment jsdom */

import {fetchReadReceiptReaders} from '../services/ReadReceiptReadersStore';

import {scanReadReceiptDomFallback} from './ReadReceiptDomFallback';

jest.mock('@/manifest', () => ({
    id: 'com.mattermost.who-read-plugin',
    version: 'test',
}), {virtual: true});

jest.mock('../services/ReadReceiptReadersStore', () => ({
    fetchReadReceiptReaders: jest.fn(),
}));

const fetchReadReceiptReadersMock = fetchReadReceiptReaders as jest.Mock;
const postAID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const postBID = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

function readReadersForTest(postId: string) {
    if (postId === postAID) {
        return Promise.resolve({
            count: 2,
            readers: [
                {nickname: 'Bob', updated_at: 1, user_id: 'bob'},
                {first_name: 'Alice', last_name: 'Reader', updated_at: 1, user_id: 'alice'},
            ],
        });
    }

    return Promise.resolve({count: 0, readers: []});
}

describe('ReadReceiptDomFallback', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        fetchReadReceiptReadersMock.mockReset();
    });

    it('injects, updates and removes fallback reader indicators in Mattermost post DOM', async () => {
        document.body.innerHTML = `
            <div class="post" data-testid="postView" id="post_${postAID}">
                <div class="post__content">
                    <div class="post__body">
                        <div id="${postAID}_message">message A</div>
                    </div>
                </div>
            </div>
            <div class="post" data-testid="postView" id="post_invalid_id">
                <div class="post__content">
                    <div id="invalid_id_message">not a real post</div>
                </div>
            </div>
            <div class="post" data-testid="postView" id="post_${postBID}">
                <div class="post__content">
                    <span class="who-read-readers" data-who-read-fallback-indicator="true" data-who-read-post-id="${postBID}">✓ 1</span>
                    <div id="${postBID}_message">message B</div>
                </div>
            </div>
        `;
        fetchReadReceiptReadersMock.mockImplementation(readReadersForTest);

        await scanReadReceiptDomFallback();
        await scanReadReceiptDomFallback();

        const postA = document.getElementById(`post_${postAID}`) as HTMLElement;
        const indicators = postA.querySelectorAll('.who-read-readers[data-who-read-fallback-indicator="true"]');
        expect(indicators).toHaveLength(1);
        expect(indicators[0].textContent).toBe('✓ 2');
        expect(indicators[0].getAttribute('title')).toBe('Прочитали: Bob, Alice Reader');
        expect(indicators[0].getAttribute('aria-label')).toBe('Прочитали: Bob, Alice Reader');
        expect(document.querySelector(`#post_${postBID} .who-read-readers`)).toBeNull();
        expect(fetchReadReceiptReadersMock).not.toHaveBeenCalledWith('invalid_id');
    });
});
