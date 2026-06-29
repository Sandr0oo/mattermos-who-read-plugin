import {Post} from 'mattermost-redux/types/posts';

import {PluginRegistry} from '../src/types/mattermost-webapp';

type Handler = (event: any) => void | Promise<void>;

export function createRegistry() {
    const handlers: Record<string, Handler> = {};
    const registry: PluginRegistry = {
        registerPostTypeComponent: jest.fn(),
        registerWebSocketEventHandler: jest.fn((event: string, handler: Handler) => {
            handlers[event] = handler;
        }),
        unregisterWebSocketEventHandler: jest.fn((event: string) => {
            delete handlers[event];
        }),
        unregisterComponent: jest.fn(),
    };

    return {handlers, registry};
}

export function createStore(state: Record<string, unknown> = {}, dispatch = jest.fn()) {
    return {
        dispatch,
        store: {
            dispatch,
            getState: jest.fn(() => state),
            replaceReducer: jest.fn(),
            subscribe: jest.fn(),
        } as any,
    };
}

export function createPost(overrides: Partial<Post> = {}): Post {
    return {
        id: 'post-id',
        create_at: 1,
        update_at: 1,
        edit_at: 0,
        delete_at: 0,
        is_pinned: false,
        user_id: 'user-id',
        channel_id: 'channel-id',
        root_id: '',
        parent_id: '',
        original_id: '',
        message: '',
        type: '',
        props: {},
        hashtags: '',
        pending_post_id: '',
        metadata: {},
        ...overrides,
    } as Post;
}

export function flushPromises(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
