import {ReaderInfo} from '../services/ServerReadReceiptService';

export const READ_RECEIPT_INDICATOR_CLASS = 'who-read-readers';

export const READ_RECEIPT_INDICATOR_STYLE = {
    color: 'var(--center-channel-color-56)',
    fontSize: '12px',
    marginLeft: '8px',
};

export function buildReadReceiptTitle(count: number, readers: ReaderInfo[]): string {
    const names = readers.map(readerDisplayName).filter(Boolean);
    if (names.length > 0) {
        return `Прочитали: ${names.join(', ')}`;
    }

    return `Прочитали: ${count}`;
}

export function buildReadReceiptText(count: number): string {
    return `✓ ${count}`;
}

export function readerDisplayName(reader: ReaderInfo): string {
    const fullName = [reader.first_name, reader.last_name].filter(Boolean).join(' ').trim();
    return reader.nickname || fullName || reader.username || reader.user_id;
}
