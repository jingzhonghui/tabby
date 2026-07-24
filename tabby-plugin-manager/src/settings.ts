import { Injectable } from '@angular/core'
import { SettingsTabLayout, SettingsTabProvider } from 'tabby-settings'

import { PluginsSettingsTabComponent } from './components/pluginsSettingsTab.component'

/** @hidden */
@Injectable()
export class PluginsSettingsTabProvider extends SettingsTabProvider {
    id = 'plugins'
    title = 'Plugins'
    layout: SettingsTabLayout = 'wide'

    getComponentType (): any {
        return PluginsSettingsTabComponent
    }
}
