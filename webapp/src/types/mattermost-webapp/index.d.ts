export interface PluginRegistry {
    registerPostTypeComponent(typeName: string, component: React.ElementType): void;

    registerWebSocketEventHandler<TEvent = unknown>(event: string, handler: (evt: TEvent) => void | Promise<void>): void;

    unregisterWebSocketEventHandler(event: string): void;

    unregisterComponent(componentId: string): void;

    // Add more if needed from https://developers.mattermost.com/extend/plugins/webapp/reference
}
