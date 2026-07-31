import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { CommandSuggestionProvider } from '../api/commandSuggestionProvider'

const MAX_RESULTS = 5
const MAX_HISTORY_LINES = 20000

interface HistoryFileState {
    path: string
    mtimeMs: number
    /** Newest-first, deduplicated commands */
    commands: string[]
}

/**
 * Suggests commands from the local shell's real history files
 * (bash/zsh/fish/PowerShell). Read-only: nothing typed into programs
 * (credentials, interactive answers) can ever leak into the suggestions.
 */
@Injectable()
export class LocalCommandSuggestionProvider extends CommandSuggestionProvider {
    private files: HistoryFileState[] = []

    supports (tab: BaseTerminalTabComponent<any>): boolean {
        return tab.profile?.type === 'local'
    }

    async fetchSuggestions (_tab: BaseTerminalTabComponent<any>, query: string): Promise<string[]> {
        await this.refresh()
        const needle = query.trim().toLowerCase()
        if (!needle) {
            return []
        }
        // Prefix match only; commands are already newest-first
        return this.files
            .flatMap(f => f.commands)
            .filter(command => command.toLowerCase().startsWith(needle) && command.trim() !== query.trim())
            .slice(0, MAX_RESULTS)
    }

    private async refresh (): Promise<void> {
        for (const filePath of this.historyFilePaths()) {
            let mtimeMs = 0
            try {
                mtimeMs = (await fs.promises.stat(filePath)).mtimeMs
            } catch {
                continue // file doesn't exist
            }
            let state = this.files.find(f => f.path === filePath)
            if (state && state.mtimeMs === mtimeMs) {
                continue
            }
            try {
                const content = await fs.promises.readFile(filePath, 'utf-8')
                const commands = this.parseHistory(content)
                if (state) {
                    state.mtimeMs = mtimeMs
                    state.commands = commands
                } else {
                    state = { path: filePath, mtimeMs, commands }
                    this.files.push(state)
                }
            } catch {
                // unreadable file — keep previous state
            }
        }
    }

    /** Parse a history file into newest-first, deduplicated commands */
    private parseHistory (content: string): string[] {
        const lines = content.split('\n').slice(-MAX_HISTORY_LINES)
        const seen = new Set<string>()
        const commands: string[] = []
        for (let i = lines.length - 1; i >= 0; i--) {
            let line = lines[i].trim()
            if (!line) {
                continue
            }
            // zsh extended format: ": <timestamp>:<elapsed>;<command>"
            line = line.replace(/^: \d+:\d+;/, '')
            // fish YAML format: "- cmd: <command>"
            line = line.replace(/^- cmd: /, '')
            line = line.trim()
            if (line.length < 2 || seen.has(line)) {
                continue
            }
            seen.add(line)
            commands.push(line)
        }
        return commands
    }

    private historyFilePaths (): string[] {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
        const paths = [
            path.join(home, '.bash_history'),
            path.join(home, '.zsh_history'),
            path.join(home, '.config', 'fish', 'fish_history'),
            path.join(home, '.history'),
        ]
        if (process.platform === 'win32' && process.env.APPDATA) {
            paths.push(path.join(
                process.env.APPDATA,
                'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt',
            ))
        }
        return paths
    }
}
