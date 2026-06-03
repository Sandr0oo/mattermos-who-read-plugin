export function isMobileBrowser(): boolean {
    const ua = navigator.userAgent || navigator.vendor || (window as any).opera || '';
    return (/android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i).test(ua.toLowerCase());
}

export function isDesktop(): boolean {
    return !isMobileBrowser();
}
