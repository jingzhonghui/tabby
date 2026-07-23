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
        background: '#23242f',
        cursor: '#a9b1d6',
        selection: '#33467c',
        selectionForeground: '#c0caf5',
        cursorAccent: '#23242f',
        colors: [
            '#1a1b26',
            '#f7768e',
            '#9ece6a',
            '#e0af68',
            '#7aa2f7',
            '#bb9af7',
            '#7dcfff',
            '#a9b1d6',
            '#414868',
            '#f7768e',
            '#9ece6a',
            '#e0af68',
            '#7aa2f7',
            '#bb9af7',
            '#7dcfff',
            '#c0caf5',
        ],
    }

    async getSchemes (): Promise<TerminalColorScheme[]> {
        return [
            DefaultColorSchemes.defaultColorScheme,
            DefaultColorSchemes.defaultLightColorScheme,
            DefaultColorSchemes.jzhNightColorScheme,
        ]
    }
}
