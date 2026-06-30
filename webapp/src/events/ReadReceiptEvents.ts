import manifest from '@/manifest';

import {ReadReceiptScopeType} from '../services/ServerReadReceiptService';

export const READ_RECEIPT_UPDATED_WEBSOCKET_EVENT = `custom_${manifest.id}_read_receipt_updated`;
export const READ_RECEIPT_CONFIG_CHANGED_WEBSOCKET_EVENT = `custom_${manifest.id}_read_receipt_config_changed`;

export const READ_RECEIPT_UPDATED_BROWSER_EVENT = 'who-read-plugin:read-receipt-updated';
export const READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT = 'who-read-plugin:read-receipt-config-changed';

export interface ReadReceiptUpdatedEventDetail {
    user_id?: string;
    scope_type?: ReadReceiptScopeType;
    scope_id?: string;
    channel_id?: string;
    post_id?: string;
    previous_post_id?: string;
    updated_at?: number;
}

export interface ReadReceiptConfigChangedEventDetail {
    config?: unknown;
    updated_at?: number;
}

export interface ReadReceiptUpdatedWebSocketEvent {
    data?: ReadReceiptUpdatedEventDetail;
}

export interface ReadReceiptConfigChangedWebSocketEvent {
    data?: ReadReceiptConfigChangedEventDetail;
}

export function dispatchReadReceiptUpdated(detail: ReadReceiptUpdatedEventDetail): void {
    window.dispatchEvent(new CustomEvent<ReadReceiptUpdatedEventDetail>(READ_RECEIPT_UPDATED_BROWSER_EVENT, {detail}));
}

export function dispatchReadReceiptConfigChanged(detail: ReadReceiptConfigChangedEventDetail): void {
    window.dispatchEvent(new CustomEvent<ReadReceiptConfigChangedEventDetail>(READ_RECEIPT_CONFIG_CHANGED_BROWSER_EVENT, {detail}));
}
