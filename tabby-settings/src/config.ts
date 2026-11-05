import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class SettingsConfigProvider extends ConfigProvider {
    defaults = {
        configSync: {
            backend: 'tabby-web',
            host: null,
            token: null,
            configID: null,
            auto: false,
            parts: {
                hotkeys: true,
                appearance: true,
                vault: true,
            },
        },
        hotkeys: {
            'settings-tab': {
                __nonStructural: true,
            },
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                settings: ['⌘-,'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
    }
}
