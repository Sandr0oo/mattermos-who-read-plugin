export interface PluginRegistry {
    registerPostTypeComponent(typeName: string, component: React.ElementType): void;

    registerWebSocketEventHandler(event: string, handler: (evt: any) => void): void;

    unregisterWebSocketEventHandler(event: string): void;

    unregisterComponent(componentId: string): void;

    // Add more if needed from https://developers.mattermost.com/extend/plugins/webapp/reference
}
