import type { Channel } from 'russh'

export const DEFAULT_SSH_TERMINAL_TYPE = 'xterm-256color'

export interface SSHShellChannelOptions {
    x11: boolean
    term: string | null | undefined
    columns?: number
    rows?: number
}

export interface SSHShellChannelSize {
    columns: number
    rows: number
}

interface SSHShellProfile {
    options: {
        x11: boolean
        term?: string | null
    }
}

interface SSHShellChannelOpener<T> {
    openShellChannel: (options: SSHShellChannelOptions) => Promise<T>
}

export function resolveSSHTerminalType (term: unknown): string {
    if (typeof term !== 'string') {
        return DEFAULT_SSH_TERMINAL_TYPE
    }
    return term.trim() || DEFAULT_SSH_TERMINAL_TYPE
}

export function openShellChannelForProfile<T> (
    ssh: SSHShellChannelOpener<T>,
    profile: SSHShellProfile,
    size?: SSHShellChannelSize,
): Promise<T> {
    return ssh.openShellChannel({
        x11: profile.options.x11,
        term: profile.options.term,
        // Only set these when known, so the option object stays free of undefined keys
        // for callers that don't care about the initial geometry.
        ...(size ? { columns: size.columns, rows: size.rows } : {}),
    })
}

export function requestShellPTY (
    channel: Pick<Channel, 'requestPTY'>,
    options: Pick<SSHShellChannelOptions, 'term'|'columns'|'rows'>,
): Promise<void> {
    return channel.requestPTY(resolveSSHTerminalType(options.term), {
        // Open the pty at the terminal's real size rather than 80x24, so the remote
        // shell doesn't start out with a wrong idea of the geometry.
        columns: options.columns ?? 80,
        rows: options.rows ?? 24,
        pixHeight: 0,
        pixWidth: 0,
    })
}
