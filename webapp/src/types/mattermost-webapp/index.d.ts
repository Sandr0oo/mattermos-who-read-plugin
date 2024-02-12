export interface PluginRegistry {
    registerPostTypeComponent(typeName: string, component: React.ElementType)

    registerWebSocketEventHandler(event: string, handler: (event: any) => void)

    // Add more if needed from https://developers.mattermost.com/extend/plugins/webapp/reference
}
