import * as crypto from 'crypto'
import { Injectable } from '@angular/core'
import * as russh from 'russh'
import { posix as path } from 'path'
import { SSHSession } from '../session/ssh'
import { SSHShellSession } from '../session/shell'
import { execRemoteCommand } from '../utils/execCommand'

export type RemoteShellFamily = 'bash'|'zsh'

export type RemoteCWDIntegrationStatus = 'configured'|'not-configured'|'unsupported'|'unknown'

export interface RemoteCWDInspection {
    shell: RemoteShellFamily|null
    home: string|null
    configPath: string|null
    status: RemoteCWDIntegrationStatus
}

const BLOCK_START = '# >>> Tabby CurrentDir v1 >>>'
const BLOCK_END = '# <<< Tabby CurrentDir v1 <<<'
const SHELL_PROBE = 'printf "__TABBY_SHELL__%s\\n__TABBY_HOME__%s\\n" "$SHELL" "$HOME"'

@Injectable({ providedIn: 'root' })
export class RemoteCWDIntegrationService {
    private readonly inFlight = new WeakMap<SSHSession, Promise<RemoteCWDInspection>>()

    async inspect (session: SSHSession): Promise<RemoteCWDInspection> {
        const previous = this.inFlight.get(session)
        if (previous) {
            return previous
        }
        const current = this.inspectOnce(session)
        this.inFlight.set(session, current)
        try {
            return await current
        } finally {
            if (this.inFlight.get(session) === current) {
                this.inFlight.delete(session)
            }
        }
    }

    async enableForCurrentSession (session: SSHShellSession, shell: RemoteShellFamily): Promise<void> {
        session.enableCWDIntegration(shell)
    }

    async enablePermanently (session: SSHSession, inspection: RemoteCWDInspection): Promise<void> {
        if (!inspection.home || !inspection.configPath || !inspection.shell) {
            throw new Error('Remote shell configuration is unavailable')
        }

        const sftp = await session.openSFTP()
        const current = await this.readFile(sftp, inspection.configPath).catch(error => {
            if (this.isMissingFile(error)) {
                return { contents: '', mode: 0o600 }
            }
            throw error
        })
        const contents = this.updateManagedBlock(current.contents, inspection.shell)
        if (contents === current.contents) {
            return
        }

        const tempPath = `${inspection.configPath}.tabby-${crypto.randomBytes(8).toString('hex')}.tmp`
        try {
            const handle = await sftp.open(tempPath, russh.OPEN_WRITE | russh.OPEN_CREATE | russh.OPEN_TRUNCATE)
            await handle.write(new TextEncoder().encode(contents))
            await handle.close()
            await sftp.chmod(tempPath, current.mode)
            await sftp.rename(tempPath, inspection.configPath)
        } catch (error) {
            await sftp.unlink(tempPath).catch(() => null)
            throw error
        }
    }

    getConfigPath (home: string, shell: RemoteShellFamily): string {
        return path.join(home, shell === 'bash' ? '.bashrc' : '.zshrc')
    }

    getTemporaryHook (shell: RemoteShellFamily): string {
        return shell === 'bash' ? this.bashHook() : this.zshHook()
    }

    updateManagedBlock (contents: string, shell: RemoteShellFamily): string {
        const block = `${BLOCK_START}\n${this.getTemporaryHook(shell)}${BLOCK_END}`
        const start = contents.indexOf(BLOCK_START)
        const end = contents.indexOf(BLOCK_END)
        if (start !== -1 || end !== -1) {
            if (start === -1 || end === -1 || end < start) {
                throw new Error('The remote Tabby directory integration block is incomplete')
            }
            const endOffset = end + BLOCK_END.length
            return contents.substring(0, start) + block + contents.substring(endOffset)
        }
        const separator = contents.length === 0 || contents.endsWith('\n') ? '' : '\n'
        return `${contents}${separator}${contents.length ? '\n' : ''}${block}\n`
    }

    private async inspectOnce (session: SSHSession): Promise<RemoteCWDInspection> {
        try {
            const probe = await this.execProbe(session)
            const shell = this.shellFamily(probe.shell)
            if (!shell || !probe.home) {
                return { shell: null, home: probe.home, configPath: null, status: 'unsupported' }
            }

            const configPath = this.getConfigPath(probe.home, shell)
            const sftp = await session.openSFTP()
            const files = await this.readFile(sftp, configPath).catch(error => {
                if (this.isMissingFile(error)) {
                    return { contents: '', mode: 0o600 }
                }
                throw error
            })
            if (this.hasManagedBlock(files.contents) || this.hasExternalIntegration(files.contents)) {
                return { shell, home: probe.home, configPath, status: 'configured' }
            }
            return { shell, home: probe.home, configPath, status: 'not-configured' }
        } catch {
            return { shell: null, home: null, configPath: null, status: 'unknown' }
        }
    }

    private async execProbe (session: SSHSession): Promise<{ shell: string, home: string }> {
        const output = await execRemoteCommand(session, SHELL_PROBE)
        const shell = this.findProbeValue(output, '__TABBY_SHELL__')
        const home = this.findProbeValue(output, '__TABBY_HOME__')
        if (!shell || !home || !home.startsWith('/')) {
            throw new Error('Unable to determine the remote shell')
        }
        return { shell, home }
    }

    private findProbeValue (output: string, marker: string): string|null {
        const line = output.split(/\r?\n/).find(item => item.startsWith(marker))
        return line ? line.substring(marker.length).trim() : null
    }

    private shellFamily (shell: string): RemoteShellFamily|null {
        const name = path.basename(shell)
        if (name === 'bash') {
            return 'bash'
        }
        if (name === 'zsh') {
            return 'zsh'
        }
        return null
    }

    private async readFile (sftp: any, filePath: string): Promise<{ contents: string, mode: number }> {
        const metadata = await sftp.stat(filePath)
        const handle = await sftp.open(filePath, russh.OPEN_READ)
        const chunks: Uint8Array[] = []
        try {
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                chunks.push(chunk)
            }
        } finally {
            await handle.close()
        }
        return {
            contents: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf-8'),
            mode: metadata.mode & 0o7777 || 0o600,
        }
    }

    private hasManagedBlock (contents: string): boolean {
        return contents.includes(BLOCK_START) && contents.includes(BLOCK_END)
    }

    private hasExternalIntegration (contents: string): boolean {
        const activeLines = contents.split(/\r?\n/).filter(line => !/^\s*#/.test(line))
        return activeLines.some(line =>
            line.includes('1337') && line.includes('CurrentDir') &&
            (line.includes('PROMPT_COMMAND') || line.includes('PS1') || line.includes('precmd') || line.includes('PROMPT')))
    }

    private isMissingFile (error: any): boolean {
        return /not found|no such file|failed to stat/i.test(String(error?.message ?? error))
    }

    private bashHook (): string {
        return `__tabby_report_cwd() { printf '\\033]1337;CurrentDir=%s\\007' "$PWD"; }\nif [[ -z "${'${__TABBY_CWD_HOOK_INSTALLED:-}'}" ]]; then\n    if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then\n        PROMPT_COMMAND+=(__tabby_report_cwd)\n    elif [[ " ${'${PROMPT_COMMAND:-}'} " != *" __tabby_report_cwd "* ]]; then\n        PROMPT_COMMAND="${'${PROMPT_COMMAND:+$PROMPT_COMMAND; }'}__tabby_report_cwd"\n    fi\n    __TABBY_CWD_HOOK_INSTALLED=1\nfi\n__tabby_report_cwd\n`
    }

    private zshHook (): string {
        return `function __tabby_report_cwd() { printf '\\033]1337;CurrentDir=%s\\007' "$PWD"; }\nif (( ${'${precmd_functions[(I)__tabby_report_cwd]}'} == 0 )); then\n    precmd_functions+=(__tabby_report_cwd)\nfi\n__tabby_report_cwd\n`
    }
}
