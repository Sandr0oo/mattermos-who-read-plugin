const MATTERMOST_ID_PATTERN = /^[A-Za-z0-9]{26}$/;

export function isValidMattermostId(value: unknown): value is string {
    return typeof value === 'string' && MATTERMOST_ID_PATTERN.test(value);
}
