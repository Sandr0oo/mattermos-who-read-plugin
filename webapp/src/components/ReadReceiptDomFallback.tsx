import React, {useEffect} from 'react';

import {
    READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT,
    READ_RECEIPT_UPDATED_BROWSER_EVENT,
    ReadReceiptUpdatedEventDetail,
} from '../events/ReadReceiptEvents';
import {clearReadReceiptReadersCache, fetchReadReceiptReaders} from '../services/ReadReceiptReadersStore';
import {isValidMattermostId} from '../utils/MattermostIds';

import {
    READ_RECEIPT_INDICATOR_CLASS,
    READ_RECEIPT_INDICATOR_STYLE,
    buildReadReceiptText,
    buildReadReceiptTitle,
} from './ReadReceiptIndicatorDisplay';

const POST_SELECTOR = '.post[data-testid="postView"][id^="post_"], .post[data-testid="rhsPostView"][id^="rhsPost_"]';
const FALLBACK_INDICATOR_ATTRIBUTE = 'data-who-read-fallback-indicator';
const POST_ID_ATTRIBUTE = 'data-who-read-post-id';
const FALLBACK_INDICATOR_SELECTOR = `span.${READ_RECEIPT_INDICATOR_CLASS}[${FALLBACK_INDICATOR_ATTRIBUTE}="true"]`;
const INJECTED_STYLE_ID = 'who-read-readers-style';

let scanTimer: ReturnType<typeof setTimeout> | null = null;

const noopCleanup = (): void => {
    // Nothing to clean up when document.body is unavailable.
};

function injectReadReceiptStyle(): void {
    if (!document.head || document.getElementById(INJECTED_STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = INJECTED_STYLE_ID;
    style.textContent = `
        .post__header .who-read-readers {
            display: inline-block;
            margin-left: 6px;
            vertical-align: middle;
        }
        .post__body .who-read-readers {
            display: block;
            margin-left: 0;
            margin-top: 2px;
        }
    `;
    document.head.appendChild(style);
}

function removeReadReceiptStyle(): void {
    const style = document.getElementById(INJECTED_STYLE_ID);
    if (style) {
        style.remove();
    }
}

export default function ReadReceiptDomFallback(): React.ReactElement | null {
    useEffect(() => {
        if (!document.body) {
            return noopCleanup;
        }

        injectReadReceiptStyle();
        scheduleReadReceiptDomFallbackScan();

        const observer = new MutationObserver(() => {
            scheduleReadReceiptDomFallbackScan();
        });
        observer.observe(document.body, {childList: true, subtree: true});

        const handleReadReceiptUpdated = (event: Event): void => {
            const detail = (event as CustomEvent<ReadReceiptUpdatedEventDetail>).detail || {};
            const changedPostIds = [detail.post_id || '', detail.previous_post_id || ''].filter(Boolean);
            if (changedPostIds.length > 0) {
                clearReadReceiptReadersCache(changedPostIds);
            } else {
                clearReadReceiptReadersCache();
            }
            scheduleReadReceiptDomFallbackScan();
        };

        const handleConfigChanged = (): void => {
            clearReadReceiptReadersCache();
            scheduleReadReceiptDomFallbackScan();
        };

        window.addEventListener(READ_RECEIPT_UPDATED_BROWSER_EVENT, handleReadReceiptUpdated);
        window.addEventListener(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, handleConfigChanged);

        return () => {
            observer.disconnect();
            window.removeEventListener(READ_RECEIPT_UPDATED_BROWSER_EVENT, handleReadReceiptUpdated);
            window.removeEventListener(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, handleConfigChanged);
            clearScheduledReadReceiptDomFallbackScan();
            removeReadReceiptDomFallbackIndicators();
            removeReadReceiptStyle();
        };
    }, []);

    return null;
}

export function scheduleReadReceiptDomFallbackScan(): void {
    if (scanTimer) {
        return;
    }

    scanTimer = setTimeout(() => {
        scanTimer = null;
        scanReadReceiptDomFallback();
    }, 0);
}

export function clearScheduledReadReceiptDomFallbackScan(): void {
    if (!scanTimer) {
        return;
    }

    clearTimeout(scanTimer);
    scanTimer = null;
}

export async function scanReadReceiptDomFallback(root: ParentNode = document): Promise<void> {
    const posts = Array.from(root.querySelectorAll(POST_SELECTOR));

    await Promise.all(posts.map(updatePostReadReceiptIndicator));
}

export function removeReadReceiptDomFallbackIndicators(root: ParentNode = document): void {
    root.querySelectorAll(FALLBACK_INDICATOR_SELECTOR).forEach((indicator) => indicator.remove());
}

function extractPostId(postElement: Element): string | null {
    const elementId = postElement.id || '';
    let postId = '';

    if (elementId.startsWith('rhsPost_')) {
        postId = elementId.slice('rhsPost_'.length);
    } else if (elementId.startsWith('post_')) {
        postId = elementId.slice('post_'.length);
    } else {
        return null;
    }

    return isValidMattermostId(postId) ? postId : null;
}

async function updatePostReadReceiptIndicator(postElement: Element): Promise<void> {
    const postId = extractPostId(postElement);
    if (!postId) {
        return;
    }

    try {
        const postReaders = await fetchReadReceiptReaders(postId);
        if (!postElement.isConnected) {
            return;
        }

        syncPostReadReceiptIndicator(postElement, postId, postReaders.count, postReaders.readers);
    } catch {
        removePostFallbackIndicators(postElement);
    }
}

function syncPostReadReceiptIndicator(postElement: Element, postId: string, count: number, readers: Parameters<typeof buildReadReceiptTitle>[1]): void {
    if (count <= 0) {
        removePostFallbackIndicators(postElement);
        return;
    }

    if (hasVisibleNonFallbackIndicator(postElement)) {
        removePostFallbackIndicators(postElement);
        return;
    }

    const target = findIndicatorTarget(postElement, postId);
    if (!target) {
        return;
    }

    const title = buildReadReceiptTitle(count, readers);
    const text = buildReadReceiptText(count);
    const existingIndicators = Array.from(postElement.querySelectorAll(FALLBACK_INDICATOR_SELECTOR));
    let indicator = existingIndicators.find((node) => node.getAttribute(POST_ID_ATTRIBUTE) === postId) as HTMLSpanElement | undefined;

    existingIndicators.filter((node) => node !== indicator).forEach((node) => node.remove());

    if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = READ_RECEIPT_INDICATOR_CLASS;
        indicator.setAttribute(FALLBACK_INDICATOR_ATTRIBUTE, 'true');
        indicator.setAttribute(POST_ID_ATTRIBUTE, postId);
        Object.assign(indicator.style, READ_RECEIPT_INDICATOR_STYLE);
    }

    if (indicator.textContent !== text) {
        indicator.textContent = text;
    }
    if (indicator.getAttribute('title') !== title) {
        indicator.setAttribute('title', title);
    }
    if (indicator.getAttribute('aria-label') !== title) {
        indicator.setAttribute('aria-label', title);
    }

    if (indicator.parentElement !== target) {
        insertIndicatorIntoTarget(target, indicator);
    }
}

function hasVisibleNonFallbackIndicator(postElement: Element): boolean {
    return Array.from(postElement.querySelectorAll(`.${READ_RECEIPT_INDICATOR_CLASS}`)).some((indicator) => {
        if (indicator.getAttribute(FALLBACK_INDICATOR_ATTRIBUTE) === 'true') {
            return false;
        }

        if (!(indicator instanceof HTMLElement)) {
            return false;
        }

        const style = window.getComputedStyle(indicator);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }

        return indicator.offsetParent !== null || indicator.getClientRects().length > 0;
    });
}

function findIndicatorTarget(postElement: Element, postId: string): HTMLElement | null {
    // Grouped posts (same--user) have a 0-height header even when permalink is shown on hover.
    // Always place the indicator in .post__body for these posts to avoid overlap.
    if (postElement.classList.contains('same--user')) {
        const body = postElement.querySelector('.post__body');
        if (body instanceof HTMLElement) {
            return body;
        }
    }

    // Prefer the permalink's parent (.col.d-flex.align-items-center) so the indicator
    // lands next to the timestamp rather than at the far right of .post__header.
    const permalink = postElement.querySelector('.post__permalink');
    if (permalink?.parentElement instanceof HTMLElement) {
        return permalink.parentElement;
    }

    const time = postElement.querySelector('.post__time');
    if (time?.parentElement instanceof HTMLElement) {
        return time.parentElement;
    }

    // No permalink and no time — this is a grouped post (collapsed header).
    // Inject into .post__body instead (between message text and reactions).
    const body = postElement.querySelector('.post__body');
    if (body instanceof HTMLElement) {
        return body;
    }

    // Try .post__header directly within the post element
    const header = postElement.querySelector('.post__header');
    if (header instanceof HTMLElement) {
        return header;
    }

    // Fallback: find .post__content then .post__header within it
    const content = postElement.querySelector('.post__content');
    if (content instanceof HTMLElement) {
        const headerInContent = content.querySelector('.post__header');
        if (headerInContent instanceof HTMLElement) {
            return headerInContent;
        }
    }

    // Last resort: keep existing fallback to .post__body
    const messageElement = document.getElementById(`${postId}_message`);
    if (messageElement && postElement.contains(messageElement)) {
        const messageBody = messageElement.closest('.post__body');
        if (messageBody instanceof HTMLElement) {
            return messageBody;
        }

        if (messageElement.parentElement) {
            return messageElement.parentElement;
        }
    }

    const target = postElement.querySelector('.post__content, .post__body');
    if (target instanceof HTMLElement) {
        return target;
    }

    return postElement instanceof HTMLElement ? postElement : null;
}

function insertIndicatorIntoTarget(target: HTMLElement, indicator: HTMLSpanElement): void {
    // When target is .post__body (grouped posts), insert after the message text
    // so the indicator appears between the message and reactions.
    if (target.classList.contains('post__body')) {
        const autoHeight = target.querySelector('.AutoHeight');
        if (autoHeight) {
            target.insertBefore(indicator, autoHeight.nextSibling);
            return;
        }
        const postMessage = target.querySelector('.post-message');
        if (postMessage) {
            target.insertBefore(indicator, postMessage.nextSibling);
            return;
        }
    }

    // The target is the permalink's parent (.col.d-flex.align-items-center).
    // Insert the indicator right after the permalink within this parent.
    const permalink = target.querySelector('.post__permalink');
    if (permalink) {
        target.insertBefore(indicator, permalink.nextSibling);
        return;
    }

    const time = target.querySelector('.post__time');
    if (time) {
        target.insertBefore(indicator, time.nextSibling);
        return;
    }

    // Fallback: append to target if no target-specific anchor found.
    target.appendChild(indicator);
}

function removePostFallbackIndicators(postElement: Element): void {
    postElement.querySelectorAll(FALLBACK_INDICATOR_SELECTOR).forEach((indicator) => indicator.remove());
}
