const DEBUG_KEY = 'com.mattermost.who-read-plugin.debug';

class Logger {
    static isDebugEnabled(): boolean {
        return localStorage.getItem(DEBUG_KEY) === 'true';
    }

    static enableDebug(): void {
        localStorage.setItem(DEBUG_KEY, 'true');
    }

    static disableDebug(): void {
        localStorage.removeItem(DEBUG_KEY);
    }

    static log(...args: any[]): void {
        if (Logger.isDebugEnabled()) {
            // eslint-disable-next-line no-console
            console.log('[WhoReadPlugin]', ...args);
        }
    }

    static error(...args: any[]): void {
        // eslint-disable-next-line no-console
        console.error('[WhoReadPlugin]', ...args);
    }
}

export default Logger;
