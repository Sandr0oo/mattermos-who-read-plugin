import type React from 'react';

import {PluginRegistry} from '@/types/mattermost-webapp';

export interface PluginRegistryWithPostFooter extends PluginRegistry {
    registerPostFooterComponent(component: React.ElementType): string;
}

export function canRegisterPostFooterComponent(registry: PluginRegistry): registry is PluginRegistryWithPostFooter {
    return typeof registry.registerPostFooterComponent === 'function';
}
