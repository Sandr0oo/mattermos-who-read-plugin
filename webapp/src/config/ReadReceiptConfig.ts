export const ReadReceiptMode = {
    Legacy: 'legacy',
    LegacyReactions: 'legacy_reactions',
    HybridServer: 'hybrid_server',
    ServerWebOnly: 'server_web_only',
} as const;

export type ReadReceiptModeValue =
    typeof ReadReceiptMode.LegacyReactions |
    typeof ReadReceiptMode.HybridServer |
    typeof ReadReceiptMode.ServerWebOnly;

export const READ_RECEIPT_MODE_STORAGE_KEY = 'com.mattermost.who-read-plugin.readReceiptMode';
export const LEGACY_READ_RECEIPT_EMOJI = 'eyes';
export const HYBRID_READ_RECEIPT_EMOJI = 'who_read_eyes';
export const DEFAULT_SHOW_READER_NAMES = true;
export const DEFAULT_MAX_READERS_PER_POST = 50;

export interface ServerReadReceiptConfigResponse {
    readReceiptMode?: unknown;
    mirrorEmojiName?: unknown;
    mirrorReactionsEnabled?: unknown;
    hideMirrorReactionsInWeb?: unknown;
    showReaderNames?: unknown;
    maxReadersPerPost?: unknown;
}

export interface ReadReceiptConfig {
    mode: ReadReceiptModeValue;
    emoji: string;
    mirrorEmojiName: string;
    isLegacyMode: boolean;
    isHybridServerMode: boolean;
    isServerMode: boolean;
    hideMirrorReactionsInWeb: boolean;
    mirrorReactionsEnabled: boolean;
    showReaderNames: boolean;
    maxReadersPerPost: number;
}

export const DEFAULT_READ_RECEIPT_CONFIG: ReadReceiptConfig = buildReadReceiptConfig({});

export function resolveReadReceiptConfig(serverConfig?: ServerReadReceiptConfigResponse | null): ReadReceiptConfig {
    if (serverConfig) {
        return buildReadReceiptConfig(serverConfig);
    }

    return buildReadReceiptConfig({
        readReceiptMode: readStoredReadReceiptMode(),
    });
}

function buildReadReceiptConfig(rawConfig: ServerReadReceiptConfigResponse): ReadReceiptConfig {
    const mode = normalizeReadReceiptMode(rawConfig.readReceiptMode);
    const mirrorEmojiName = normalizeEmojiName(rawConfig.mirrorEmojiName, HYBRID_READ_RECEIPT_EMOJI);
    const isLegacyMode = mode === ReadReceiptMode.LegacyReactions;
    const isHybridServerMode = mode === ReadReceiptMode.HybridServer;
    const isServerMode = isHybridServerMode || mode === ReadReceiptMode.ServerWebOnly;

    return {
        mode,
        emoji: isLegacyMode ? LEGACY_READ_RECEIPT_EMOJI : mirrorEmojiName,
        mirrorEmojiName,
        isLegacyMode,
        isHybridServerMode,
        isServerMode,
        hideMirrorReactionsInWeb: normalizeBoolean(rawConfig.hideMirrorReactionsInWeb, true),
        mirrorReactionsEnabled: normalizeBoolean(rawConfig.mirrorReactionsEnabled, true),
        showReaderNames: normalizeBoolean(rawConfig.showReaderNames, DEFAULT_SHOW_READER_NAMES),
        maxReadersPerPost: normalizePositiveInteger(rawConfig.maxReadersPerPost, DEFAULT_MAX_READERS_PER_POST),
    };
}

function readStoredReadReceiptMode(): string | null {
    try {
        return window.localStorage.getItem(READ_RECEIPT_MODE_STORAGE_KEY);
    } catch {
        return null;
    }
}

function normalizeReadReceiptMode(value: unknown): ReadReceiptModeValue {
    const mode = typeof value === 'string' ? value.trim() : '';

    switch (mode) {
    case ReadReceiptMode.Legacy:
    case ReadReceiptMode.LegacyReactions:
        return ReadReceiptMode.LegacyReactions;
    case ReadReceiptMode.HybridServer:
        return ReadReceiptMode.HybridServer;
    case ReadReceiptMode.ServerWebOnly:
        return ReadReceiptMode.ServerWebOnly;
    default:
        return ReadReceiptMode.LegacyReactions;
    }
}

function normalizeEmojiName(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }

    const normalized = value.trim().replace(/^:/, '').replace(/:$/, '');
    return normalized || fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }

    return Math.floor(value);
}
