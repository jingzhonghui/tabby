import { ChangeDetectorRef, Component, Inject, Input, OnDestroy, OnInit, Optional } from '@angular/core'
import { Subscription } from 'rxjs'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { CommandSuggestionProvider } from '../api/commandSuggestionProvider'
import { XTermFrontend } from '../frontends/xtermFrontend'

const ITEM_HEIGHT = 28
const PANEL_WIDTH = 380
const MAX_QUERY_LENGTH = 40

/**
 * Floating panel that suggests shell history commands matching what the user
 * is currently typing. Keystrokes are tracked into a "shadow" copy of the
 * current command line used purely as the match query — nothing is recorded
 * locally; suggestions always come from the shell's real history via
 * CommandSuggestionProviders, so input typed into programs (credentials,
 * interactive answers) can never leak into the candidates.
 *
 * The shadow is marked dirty (suggestions paused) whenever the shell may have
 * altered the line itself (arrow keys, Tab completion, escape sequences) and
 * reset on every submitted line.
 */
@Component({
    selector: 'command-suggestion-panel',
    templateUrl: './commandSuggestionPanel.component.pug',
    styleUrls: ['./commandSuggestionPanel.component.scss'],
})
export class CommandSuggestionPanelComponent implements OnInit, OnDestroy {
    @Input() tab: BaseTerminalTabComponent<any>

    suggestions: string[] = []
    selectedIndex: number|null = null
    visible = false
    position = { left: 0, top: 0 }

    private shadow = ''
    private dirty = false
    private suppressed = false
    private subscriptions: Subscription[] = []
    private debounceTimer: any = null
    private requestSeq = 0

    constructor (
        @Optional() @Inject(CommandSuggestionProvider) private providers: CommandSuggestionProvider[]|null,
        private cdr: ChangeDetectorRef,
    ) { }

    ngOnInit (): void {
        this.subscriptions.push(this.tab.input$.subscribe(data => this.onInput(data)))
        const frontend = this.tab.frontend
        if (frontend instanceof XTermFrontend) {
            frontend.extraKeyEventHandler = event => this.onKeyEvent(event)
        }
    }

    ngOnDestroy (): void {
        for (const sub of this.subscriptions) {
            sub.unsubscribe()
        }
        clearTimeout(this.debounceTimer)
        this.requestSeq++ // invalidate in-flight requests
        const frontend = this.tab.frontend
        if (frontend instanceof XTermFrontend && frontend.extraKeyEventHandler) {
            frontend.extraKeyEventHandler = undefined
        }
    }

    accept (command: string): void {
        if (command.startsWith(this.shadow)) {
            this.tab.sendInput(command.slice(this.shadow.length))
        } else {
            // Fuzzy match that isn't a prefix: clear the line and retype it
            this.tab.sendInput('\x15' + command)
        }
        this.shadow = command
        this.dirty = false
        this.hide()
    }

    trackByCommand (_index: number, command: string): string {
        return command
    }

    /** Key interceptor: only consumes keys while the panel is visible */
    private onKeyEvent (event: KeyboardEvent): boolean {
        if (!this.visible) {
            return true
        }
        switch (event.key) {
            case 'ArrowUp':
                this.selectedIndex = this.selectedIndex === null
                    ? this.suggestions.length - 1
                    : (this.selectedIndex + this.suggestions.length - 1) % this.suggestions.length
                this.cdr.detectChanges()
                return false
            case 'ArrowDown':
                this.selectedIndex = this.selectedIndex === null
                    ? 0
                    : (this.selectedIndex + 1) % this.suggestions.length
                this.cdr.detectChanges()
                return false
            case 'Tab':
            case 'Enter':
                if (this.selectedIndex !== null) {
                    this.accept(this.suggestions[this.selectedIndex])
                    this.cdr.detectChanges()
                    return false
                }
                return true
            case 'ArrowRight':
                if (this.selectedIndex !== null) {
                    this.accept(this.suggestions[this.selectedIndex])
                    this.cdr.detectChanges()
                    return false
                }
                return true
            case 'Escape':
                this.suppressed = true
                this.hide()
                return false
            default:
                return true
        }
    }

    private onInput (data: Buffer): void {
        const text = data.toString('utf-8')
        if (text.length > 0) {
            this.selectedIndex = null
        }
        for (const ch of text) {
            if (ch === '\x1b') {
                // Escape sequence: arrows, Home/End, bracketed paste markers, etc.
                // The shell may change the line in ways we can't track.
                // xterm delivers a full sequence in a single chunk, so the
                // rest of this chunk belongs to the sequence — drop it all.
                this.dirty = true
                break
            }
            switch (ch) {
                case '\r':
                case '\n':
                    this.resetLine()
                    continue
                case '\x7f':
                case '\b':
                    this.shadow = this.shadow.slice(0, -1)
                    break
                case '\x03': // Ctrl-C: aborts the line, a fresh prompt follows
                    this.resetLine()
                    continue
                case '\x15': // Ctrl-U: clear line
                    this.shadow = ''
                    this.suppressed = false
                    break
                case '\x17': // Ctrl-W: delete previous word
                    this.shadow = this.shadow.replace(/\s*\S+\s*$/, '')
                    break
                case '\x09': // Tab: shell completion may rewrite the line
                case '\x01': case '\x05': // Home/End
                case '\x02': case '\x06': // char-wise cursor movement
                    this.dirty = true
                    continue
                default:
                    if (ch >= ' ') {
                        this.shadow += ch
                        this.suppressed = false
                    }
                    continue
            }
            // shadow changed through deletion
            this.suppressed = false
        }
        this.updateSuggestions()
    }

    private resetLine (): void {
        this.shadow = ''
        this.dirty = false
        this.suppressed = false
        this.hide()
    }

    private updateSuggestions (): void {
        clearTimeout(this.debounceTimer)
        const query = this.shadow.trim()
        if (
            this.suppressed ||
            this.dirty ||
            query.length === 0 ||
            this.shadow.startsWith(' ') ||
            !(this.tab.frontend instanceof XTermFrontend) ||
            this.tab.frontend.isAlternateScreenActive()
        ) {
            this.hide()
            return
        }
        this.debounceTimer = setTimeout(() => this.fetch(query), 25)
    }

    private async fetch (query: string): Promise<void> {
        const provider = (this.providers ?? []).find(p => {
            try {
                return p.supports(this.tab)
            } catch {
                return false
            }
        })
        if (!provider) {
            this.hide()
            return
        }
        const seq = ++this.requestSeq
        let results: string[] = []
        try {
            results = await provider.fetchSuggestions(this.tab, query.slice(0, MAX_QUERY_LENGTH))
        } catch {
            results = []
        }
        // Drop stale responses: a newer request was issued, or the user
        // kept typing / submitted the line while this one was in flight
        if (seq !== this.requestSeq || this.shadow.trim() !== query) {
            return
        }
        if (results.length === 0) {
            this.hide()
            return
        }
        this.suggestions = results
        this.selectedIndex = null
        this.updatePosition()
        this.visible = true
        this.cdr.detectChanges()
    }

    private updatePosition (): void {
        const frontend = this.tab.frontend as XTermFrontend
        const rect = frontend.getCursorPixelRect()
        if (!rect) {
            return
        }
        const estimatedHeight = this.suggestions.length * ITEM_HEIGHT + 30
        let top = rect.top + 4
        if (top + estimatedHeight > window.innerHeight) {
            // Flip above the cursor line
            top = rect.top - rect.height - estimatedHeight - 4
        }
        this.position = {
            left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
            top: Math.max(8, top),
        }
    }

    private hide (): void {
        clearTimeout(this.debounceTimer)
        this.requestSeq++
        this.visible = false
        this.suggestions = []
        this.selectedIndex = null
        this.cdr.detectChanges()
    }

}
