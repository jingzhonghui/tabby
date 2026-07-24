import { Injectable } from '@angular/core'
import { SettingsTabLayout, SettingsTabProvider } from 'tabby-settings'

import { SSHSettingsTabComponent } from './components/sshSettingsTab.component'

/** @hidden */
@Injectable()
export class SSHSettingsTabProvider extends SettingsTabProvider {
    id = 'ssh'
    icon = 'globe'
    title = 'SSH'
    layout: SettingsTabLayout = 'compact'

    getComponentType (): any {
        return SSHSettingsTabComponent
    }
}
