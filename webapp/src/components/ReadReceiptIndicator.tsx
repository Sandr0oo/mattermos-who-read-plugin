import React, {useCallback, useEffect, useState} from 'react';
import {Post} from 'mattermost-redux/types/posts';

import {
    READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT,
    READ_RECEIPT_UPDATED_BROWSER_EVENT,
    ReadReceiptUpdatedEventDetail,
} from '../events/ReadReceiptEvents';
import {clearReadReceiptReadersCache, fetchReadReceiptReaders} from '../services/ReadReceiptReadersStore';
import {ReaderInfo} from '../services/ServerReadReceiptService';

interface ReadReceiptIndicatorProps {
    post?: Post;
}

interface IndicatorState {
    count: number;
    readers: ReaderInfo[];
}

const EMPTY_STATE: IndicatorState = {count: 0, readers: []};

export default function ReadReceiptIndicator({post}: ReadReceiptIndicatorProps): React.ReactElement | null {
    const postId = post?.id;
    const [state, setState] = useState<IndicatorState>(EMPTY_STATE);

    const loadReaders = useCallback(async (): Promise<IndicatorState> => {
        if (!postId) {
            return EMPTY_STATE;
        }

        return fetchReadReceiptReaders(postId);
    }, [postId]);

    useEffect(() => {
        let isMounted = true;

        const refresh = async (): Promise<void> => {
            try {
                const nextState = await loadReaders();
                if (isMounted) {
                    setState(nextState);
                }
            } catch {
                if (isMounted) {
                    setState(EMPTY_STATE);
                }
            }
        };

        const handleReadReceiptUpdated = (event: Event): void => {
            const detail = (event as CustomEvent<ReadReceiptUpdatedEventDetail>).detail || {};
            if (detail.post_id !== postId && detail.previous_post_id !== postId) {
                return;
            }

            clearReadReceiptReadersCache([detail.post_id || '', detail.previous_post_id || '']);
            refresh();
        };

        const handleConfigChanged = (): void => {
            clearReadReceiptReadersCache();
            refresh();
        };

        refresh();
        window.addEventListener(READ_RECEIPT_UPDATED_BROWSER_EVENT, handleReadReceiptUpdated);
        window.addEventListener(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, handleConfigChanged);

        return () => {
            isMounted = false;
            window.removeEventListener(READ_RECEIPT_UPDATED_BROWSER_EVENT, handleReadReceiptUpdated);
            window.removeEventListener(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, handleConfigChanged);
        };
    }, [loadReaders, postId]);

    if (!postId || state.count <= 0) {
        return null;
    }

    const title = buildTitle(state.count, state.readers);
    return React.createElement('span', {
        'aria-label': title,
        className: 'who-read-readers',
        style: {color: 'var(--center-channel-color-56)', fontSize: '12px', marginLeft: '8px'},
        title,
    }, `✓ ${state.count}`);
}

function buildTitle(count: number, readers: ReaderInfo[]): string {
    const names = readers.map(readerDisplayName).filter(Boolean);
    if (names.length > 0) {
        return `Прочитали: ${names.join(', ')}`;
    }

    return `Прочитали: ${count}`;
}

function readerDisplayName(reader: ReaderInfo): string {
    const fullName = [reader.first_name, reader.last_name].filter(Boolean).join(' ').trim();
    return reader.nickname || fullName || reader.username || reader.user_id;
}
