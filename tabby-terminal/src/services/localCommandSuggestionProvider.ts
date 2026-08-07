import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { CommandSuggestionProvider } from '../api/commandSuggestionProvider'

const MAX_RESULTS = 5
const MAX_HISTORY_LINES = 20000
const REFRESH_INTERVAL_MS = 2000

interface HistoryFileState {
    path: string
    mtimeMs: number
    /** Newest-first, deduplicated commands */
    commands: string[]
}

interface IndexedCommand {
    command: string
    normalized: string
}

/**
 * Suggests commands from the local shell's real history files
 * (bash/zsh/fish/PowerShell). Read-only: nothing typed into programs
 * (credentials, interactive answers) can ever leak into the suggestions.
 */
@Injectable()
export class LocalCommandSuggestionProvider extends CommandSuggestionProvider {
    private files: HistoryFileState[] = []
    private commands: IndexedCommand[] = []
    private initialized = false
    private lastRefreshAt = 0
    private refreshPromise: Promise<void>|null = null

    constructor () {
        super()
        void this.refresh()
    }

    supports (tab: BaseTerminalTabComponent<any>): boolean {
        return tab.profile?.type === 'local'
    }

    getDebounceMs (): number {
        return 25
    }

    async fetchSuggestions (_tab: BaseTerminalTabComponent<any>, query: string): Promise<string[]> {
        if (!this.initialized) {
            // The first lookup must wait for the shared warm-up so it cannot
            // incorrectly hide the panel before the history index is ready.
            await this.refresh()
        } else if (Date.now() - this.lastRefreshAt >= REFRESH_INTERVAL_MS) {
            // Do not make every keystroke wait for filesystem I/O.
            void this.refresh()
        }
        const needle = query.trim().toLowerCase()
        if (!needle) {
            return []
        }
        const current = query.trim()
        return this.commands
            .filter(item => item.normalized.startsWith(needle) && item.command.trim() !== current)
            .slice(0, MAX_RESULTS)
            .map(item => item.command)
    }

    private async refresh (): Promise<void> {
        if (this.refreshPromise) {
            return this.refreshPromise
        }
        this.refreshPromise = this.refreshFiles().finally(() => {
            this.refreshPromise = null
        })
        return this.refreshPromise
    }

    private async refreshFiles (): Promise<void> {
        const paths = this.historyFilePaths()
        let changed = !this.initialized
        const nextFiles: HistoryFileState[] = []

        for (const filePath of paths) {
            let mtimeMs = 0
            try {
                mtimeMs = (await fs.promises.stat(filePath)).mtimeMs
            } catch {
                continue // file does not exist
            }
            const state = this.files.find(f => f.path === filePath)
            if (state && state.mtimeMs === mtimeMs) {
                nextFiles.push(state)
                continue
            }
            try {
                const content = await fs.promises.readFile(filePath, 'utf-8')
                nextFiles.push({ path: filePath, mtimeMs, commands: this.parseHistory(content) })
                changed = true
            } catch {
                if (state) {
                    nextFiles.push(state)
                }
            }
        }

        if (nextFiles.length !== this.files.length) {
            changed = true
        }
        this.files = nextFiles
        if (changed) {
            const seen = new Set<string>()
            this.commands = this.files
                .flatMap(file => file.commands)
                .filter(command => {
                    if (seen.has(command)) {
                        return false
                    }
                    seen.add(command)
                    return true
                })
                .map(command => ({ command, normalized: command.toLowerCase() }))
        }
        this.initialized = true
        this.lastRefreshAt = Date.now()
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
