export type SettingsTabLayout = 'compact'|'form'|'wide'|'workspace'

/**
 * Extend to add your own settings tabs
 */
export abstract class SettingsTabProvider {
    id: string
    icon: string
    title: string
    weight = 0
    prioritized = false
    layout: SettingsTabLayout = 'form'

    getComponentType (): any {
        return null
    }
}
