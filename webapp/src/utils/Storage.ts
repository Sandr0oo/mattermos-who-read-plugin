const PREFIX = 'com.mattermost.who-read-plugin.';

export default class Storage {
    static getLastPostId(channelId: string): string | null {
        return localStorage.getItem(`${PREFIX}lastPost.${channelId}`);
    }

    static setLastPostId(channelId: string, postId: string): void {
        localStorage.setItem(`${PREFIX}lastPost.${channelId}`, postId);
    }

    static getLastViewed(channelId: string): number | null {
        const raw = localStorage.getItem(`${PREFIX}lastViewed.${channelId}`);
        return raw ? parseInt(raw, 10) : null;
    }

    static setLastViewed(channelId: string, timestamp: number): void {
        localStorage.setItem(`${PREFIX}lastViewed.${channelId}`, String(timestamp));
    }
}
