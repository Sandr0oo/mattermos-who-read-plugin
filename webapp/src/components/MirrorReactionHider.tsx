import React, {useEffect} from 'react';

import {HYBRID_READ_RECEIPT_EMOJI} from '../config/ReadReceiptConfig';

const MIRROR_REACTION_HIDDEN_ATTRIBUTE = 'data-who-read-mirror-reaction-hidden';
const REACTION_CONTAINER_SELECTOR = [
    '.post-reaction',
    '.PostReaction',
    '.reaction',
    '.Reaction',
    'button',
    '[role="button"]',
    'li',
].join(',');

const MIRROR_REACTION_HIDE_STYLE = `
[${MIRROR_REACTION_HIDDEN_ATTRIBUTE}="true"] {
    display: none !important;
}
`;

interface MirrorReactionHiderProps {
    emojiName?: string;
}

function buildMirrorReactionNodeSelector(emojiName: string): string {
    const escapedEmojiName = escapeAttributeValue(emojiName);
    return [
        `[aria-label*="${escapedEmojiName}"]`,
        `[title*="${escapedEmojiName}"]`,
        `[id^="postReaction-"][id$="-${escapedEmojiName}"]`,
        `[data-testid*="${escapedEmojiName}"]`,
        `[data-emoticon="${escapedEmojiName}"]`,
        `[data-emoji="${escapedEmojiName}"]`,
        `[alt="${escapedEmojiName}"]`,
    ].join(',');
}

function escapeAttributeValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function hideMirrorReactionNodes(emojiName: string): void {
    if (!emojiName) {
        return;
    }

    document.querySelectorAll(buildMirrorReactionNodeSelector(emojiName)).forEach((node) => {
        const container = node.closest(REACTION_CONTAINER_SELECTOR) || node;
        container.setAttribute(MIRROR_REACTION_HIDDEN_ATTRIBUTE, 'true');
    });

    // Hide reaction-acks containers that have no visible reactions left.
    // This prevents empty space and hover overlap when all reactions are hidden mirror reactions.
    document.querySelectorAll('.post__body-reactions-acks').forEach((container) => {
        const allReactions = Array.from(container.querySelectorAll(REACTION_CONTAINER_SELECTOR)).filter(
            (el) => !el.closest('.post-add-reaction'),
        );

        const visibleReactions = allReactions.filter((el) => (
            !el.hasAttribute(MIRROR_REACTION_HIDDEN_ATTRIBUTE)
        ));

        if (allReactions.length > 0 && visibleReactions.length === 0) {
            container.setAttribute(MIRROR_REACTION_HIDDEN_ATTRIBUTE, 'true');
        } else {
            container.removeAttribute(MIRROR_REACTION_HIDDEN_ATTRIBUTE);
        }
    });
}

function restoreMirrorReactionNodes(): void {
    document.querySelectorAll(`[${MIRROR_REACTION_HIDDEN_ATTRIBUTE}="true"]`).forEach((node) => {
        node.removeAttribute(MIRROR_REACTION_HIDDEN_ATTRIBUTE);
    });
}

export default function MirrorReactionHider({emojiName = HYBRID_READ_RECEIPT_EMOJI}: MirrorReactionHiderProps): React.ReactElement {
    useEffect(() => {
        let observer: MutationObserver | null = null;

        if (document.body) {
            // В web/desktop зеркальная реакция нужна только как mobile fallback — скрываем её из обычного UI.
            hideMirrorReactionNodes(emojiName);

            observer = new MutationObserver(() => {
                hideMirrorReactionNodes(emojiName);
            });
            observer.observe(document.body, {childList: true, subtree: true});
        }

        return () => {
            observer?.disconnect();
            restoreMirrorReactionNodes();
        };
    }, [emojiName]);

    return React.createElement('style', {id: 'who-read-mirror-reaction-hider'}, MIRROR_REACTION_HIDE_STYLE);
}
