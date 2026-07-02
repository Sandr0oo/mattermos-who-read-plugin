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

    it('inserts fallback indicator right after .reaction-list when present', async () => {
        document.body.innerHTML = `
            <div class="post" data-testid="postView" id="post_${postAID}">
                <div class="post__content">
                    <div class="post__body">
                        <div id="${postAID}_message">message A</div>
                        <div class="reaction-list"><span>eyes</span></div>
                        <button class="add-reaction">Add Reaction</button>
                    </div>
                </div>
            </div>
        `;
        fetchReadReceiptReadersMock.mockImplementation(readReadersForTest);

        await scanReadReceiptDomFallback();

        const postA = document.getElementById(`post_${postAID}`) as HTMLElement;
        const indicator = postA.querySelector('.who-read-readers[data-who-read-fallback-indicator="true"]') as HTMLElement;
        expect(indicator).toBeTruthy();
        expect(indicator.textContent).toBe('✓ 2');

        const reactionList = postA.querySelector('.reaction-list');
        expect(indicator.previousElementSibling).toBe(reactionList);
        expect(indicator.nextElementSibling?.classList.contains('add-reaction')).toBe(true);
    });

    it('inserts fallback indicator after .post-reaction-list in Mattermost 9.11 DOM', async () => {
        document.body.innerHTML = `
            <div class="post" data-testid="postView" id="post_${postAID}">
                <div class="post__content">
                    <div class="post__body">
                        <div class="AutoHeight">
                            <div id="${postAID}_message">message A</div>
                        </div>
                        <div class="post__body-reactions-acks">
                            <div class="post-reaction-list">
                                <div class="Reaction">eyes</div>
                            </div>
                            <button class="post-add-reaction">Add Reaction</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        fetchReadReceiptReadersMock.mockImplementation(readReadersForTest);

        await scanReadReceiptDomFallback();

        const postA = document.getElementById(`post_${postAID}`) as HTMLElement;
        const indicator = postA.querySelector('.who-read-readers[data-who-read-fallback-indicator="true"]') as HTMLElement;
        expect(indicator).toBeTruthy();
        expect(indicator.textContent).toBe('✓ 2');

        // Indicator should be inside .post__body-reactions-acks, right after .post-reaction-list
        const reactionList = postA.querySelector('.post-reaction-list');
        expect(indicator.parentElement).toBe(reactionList?.parentElement);
        expect(indicator.previousElementSibling).toBe(reactionList);
        expect(indicator.nextElementSibling?.classList.contains('post-add-reaction')).toBe(true);
    });

    it('inserts fallback indicator inside .post__body-reactions-acks when no reactions exist', async () => {
        document.body.innerHTML = `
            <div class="post" data-testid="postView" id="post_${postAID}">
                <div class="post__content">
                    <div class="post__body">
                        <div class="AutoHeight">
                            <div id="${postAID}_message">message A</div>
                        </div>
                        <div class="post__body-reactions-acks"></div>
                    </div>
                </div>
            </div>
        `;
        fetchReadReceiptReadersMock.mockImplementation(readReadersForTest);

        await scanReadReceiptDomFallback();

        const postA = document.getElementById(`post_${postAID}`) as HTMLElement;
        const indicator = postA.querySelector('.who-read-readers[data-who-read-fallback-indicator="true"]') as HTMLElement;
        expect(indicator).toBeTruthy();
        expect(indicator.textContent).toBe('✓ 2');

        // Indicator should be inside .post__body-reactions-acks, as first child
        const reactionsAcks = postA.querySelector('.post__body-reactions-acks');
        expect(indicator.parentElement).toBe(reactionsAcks);
        expect(indicator).toBe(reactionsAcks?.firstElementChild);
    });

    it('injects fallback indicator in RHS thread post DOM', async () => {
        document.body.innerHTML = `
            <div class="post" data-testid="rhsPostView" id="rhsPost_${postAID}">
                <div class="post__content" data-testid="postContent">
                    <div class="post__body">
                        <div class="AutoHeight">
                            <div class="post-message post-message--collapsed">
                                <div class="post-message__text-container">
                                    <div id="rhsPostMessageText_${postAID}" class="post-message__text">message A</div>
                                </div>
                            </div>
                        </div>
                        <div class="post__body-reactions-acks"></div>
                    </div>
                </div>
            </div>
        `;
        fetchReadReceiptReadersMock.mockImplementation(readReadersForTest);

        await scanReadReceiptDomFallback();

        const rhsPost = document.getElementById(`rhsPost_${postAID}`) as HTMLElement;
        const indicator = rhsPost.querySelector('.who-read-readers[data-who-read-fallback-indicator="true"]') as HTMLElement;
        expect(indicator).toBeTruthy();
        expect(indicator.textContent).toBe('✓ 2');

        // Indicator should be inside .post__body-reactions-acks
        const reactionsAcks = rhsPost.querySelector('.post__body-reactions-acks');
        expect(indicator.parentElement).toBe(reactionsAcks);
    });

    it('does not inject a duplicate fallback when a visible footer indicator is present', async () => {
        document.body.innerHTML = `
            <div class="post" data-testid="postView" id="post_${postAID}">
                <div class="post__content">
                    <span class="who-read-readers">✓ 2</span>
                    <div class="post__body">
                        <div id="${postAID}_message">message A</div>
                    </div>
                </div>
            </div>
        `;
        const existingIndicator = document.querySelector('.who-read-readers') as HTMLElement;
        Object.defineProperty(existingIndicator, 'getClientRects', {value: () => ({length: 1})});
        fetchReadReceiptReadersMock.mockImplementation(readReadersForTest);

        await scanReadReceiptDomFallback();

        expect(document.querySelectorAll('.who-read-readers')).toHaveLength(1);
        expect(document.querySelector('.who-read-readers[data-who-read-fallback-indicator="true"]')).toBeNull();
    });
});
