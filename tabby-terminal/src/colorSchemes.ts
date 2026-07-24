import { Injectable } from '@angular/core'
import { TerminalColorSchemeProvider } from './api/colorSchemeProvider'
import { TerminalColorScheme } from 'tabby-core'

@Injectable({ providedIn: 'root' })
export class DefaultColorSchemes extends TerminalColorSchemeProvider {
    static defaultColorScheme: TerminalColorScheme = {
        name: 'Tabby Default',
        foreground: '#cacaca',
        background: '#171717',
        cursor: '#bbbbbb',
        colors: [
            '#000000',
            '#ff615a',
            '#b1e969',
            '#ebd99c',
            '#5da9f6',
            '#e86aff',
            '#82fff7',
            '#dedacf',
            '#313131',
            '#f58c80',
            '#ddf88f',
            '#eee5b2',
            '#a5c7ff',
            '#ddaaff',
            '#b7fff9',
            '#ffffff',
        ],
    }

    static defaultLightColorScheme: TerminalColorScheme = {
        name: 'Tabby Default Light',
        foreground: '#4d4d4c',
        background: '#ffffff',
        cursor: '#4d4d4c',
        colors: [
            '#000000',
            '#c82829',
            '#718c00',
            '#eab700',
            '#4271ae',
            '#8959a8',
            '#3e999f',
            '#ffffff',
            '#000000',
            '#c82829',
            '#718c00',
            '#eab700',
            '#4271ae',
            '#8959a8',
            '#3e999f',
            '#ffffff',
        ],
    }

    static jzhNightColorScheme: TerminalColorScheme = {
        name: 'jzh Night',
        foreground: '#a9b1d6',
        background: '#1a1b26',
        cursor: '#a9b1d6',
        selection: '#33467c',
        selectionForeground: '#a9b1d6',
        cursorAccent: '#1a1b26',
        colors: [
            '#23242f',
            '#f7768e',
            '#9ece6a',
            '#e0af68',
            '#7aa2f7',
            '#bb9af7',
            '#7dcfff',
            '#a9b1d6',
            '#23242f',
            '#f7768e',
            '#9ece6a',
            '#e0af68',
            '#7aa2f7',
            '#bb9af7',
            '#7dcfff',
            '#a9b1d6',
        ],
    }

    static jzhLatteColorScheme: TerminalColorScheme = {
        name: 'jzh Latte',
        foreground: '#acb0be',
        background: '#eff1f5',
        cursor: '#acb0be',
        selection: '#ccd0da',
        selectionForeground: '#5c5f77',
        cursorAccent: '#eff1f5',
        colors: [
            '#5c5f77',
            '#d20f39',
            '#40a02b',
            '#df8e1d',
            '#1e66f5',
            '#ea76cb',
            '#179299',
            '#acb0be',
            '#5c5f77',
            '#d20f39',
            '#40a02b',
            '#df8e1d',
            '#1e66f5',
            '#ea76cb',
            '#179299',
            '#acb0be',
        ],
    }

    async getSchemes (): Promise<TerminalColorScheme[]> {
        return [
            DefaultColorSchemes.defaultColorScheme,
            DefaultColorSchemes.defaultLightColorScheme,
            DefaultColorSchemes.jzhNightColorScheme,
            DefaultColorSchemes.jzhLatteColorScheme,
        ]
    }
}
