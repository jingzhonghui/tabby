import { BaseTerminalTabComponent } from './baseTerminalTab.component'

/**
 * Provides command suggestions for a terminal tab based on the shell's
 * real command history. Implementations are registered as multi-providers;
 * the first one whose `supports()` returns true is used.
 */
export abstract class CommandSuggestionProvider {
    abstract supports (tab: BaseTerminalTabComponent<any>): boolean

    /**
     * Return up to 5 history commands matching the query, best match first.
     * May return an empty array when no history is available.
     */
    abstract fetchSuggestions (tab: BaseTerminalTabComponent<any>, query: string): Promise<string[]>
}
