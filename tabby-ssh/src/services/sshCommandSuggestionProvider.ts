import { Injectable } from '@angular/core'
import { BaseTerminalTabComponent, CommandSuggestionProvider } from 'tabby-terminal'
import { SSHTabComponent } from '../components/sshTab.component'
import { execRemoteCommand } from '../utils/execCommand'

const MAX_RESULTS = 5
const MAX_REMOTE_LINES = 200
const EXEC_TIMEOUT_MS = 5000

/**
 * Suggests commands from the remote shell's real history files.
 * The fuzzy matching runs on the remote host (grep over the history
 * files) so no full history is ever transferred to the client.
 */
@Injectable()
export class SSHCommandSuggestionProvider extends CommandSuggestionProvider {
    supports (tab: BaseTerminalTabComponent<any>): boolean {
        return tab instanceof SSHTabComponent && !!tab.sshSession
    }

    async fetchSuggestions (tab: BaseTerminalTabComponent<any>, query: string): Promise<string[]> {
        if (!(tab instanceof SSHTabComponent) || !tab.sshSession) {
            return []
        }
        try {
            const output = await execRemoteCommand(tab.sshSession, this.buildCommand(query), EXEC_TIMEOUT_MS)
            return this.parseResults(output)
        } catch {
            return []
        }
    }

    private buildCommand (query: string): string {
        // Anchored prefix match, case-insensitive
        const regex = [...query]
            .map(ch => /[\\^$.|?*+()[\]{}]/.test(ch) ? '\\' + ch : ch)
            .join('')
        // Escape for the double quotes inside the sh -c script
        const shSafe = regex.replace(/(["`$\\])/g, '\\$1')
        // sh -c wrapper keeps this working regardless of the login shell (csh/zsh/fish);
        // sed strips zsh/fish history decorations before the prefix match
        return `sh -c 'for f in ~/.bash_history ~/.zsh_history ~/.config/fish/fish_history ~/.history; do [ -f "$f" ] && cat "$f"; done 2>/dev/null | sed -e "s/^: [0-9][0-9]*:[0-9][0-9]*;//" -e "s/^- cmd: //" | grep -iE -- "^${shSafe}" | tail -n ${MAX_REMOTE_LINES}'`
    }

    /** Newest-first, deduplicated, top MAX_RESULTS */
    private parseResults (output: string): string[] {
        const lines = output.split('\n')
            .map(line => line
                .replace(/\r$/, '')
                .replace(/^: \d+:\d+;/, '') // zsh extended format
                .replace(/^- cmd: /, '') // fish YAML format
                .trim(),
            )
            .filter(line => line.length >= 2)

        const seen = new Set<string>()
        const results: string[] = []
        for (let i = lines.length - 1; i >= 0 && results.length < MAX_RESULTS; i--) {
            if (!seen.has(lines[i])) {
                seen.add(lines[i])
                results.push(lines[i])
            }
        }
        return results
    }
}
