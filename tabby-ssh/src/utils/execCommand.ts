import * as russh from 'russh'
import { SSHSession } from '../session/ssh'

/**
 * Execute a command on the remote host through a one-shot exec channel
 * and return its stdout. Resolves with whatever was received if the
 * channel doesn't close within `timeoutMs`.
 */
export async function execRemoteCommand (session: SSHSession, command: string, timeoutMs = 5000): Promise<string> {
    if (!(session.ssh instanceof russh.AuthenticatedSSHClient)) {
        throw new Error('SSH session not authenticated')
    }

    const newChannel = await session.ssh.openSessionChannel()
    const channel = await session.ssh.activateChannel(newChannel)
    await channel.requestExec(command)

    return new Promise((resolve, reject) => {
        let output = ''
        let settled = false
        let flushTimer: any = null
        let dataSub: any = null
        let extDataSub: any = null
        let closeSub: any = null
        // Channel close may race the final stdout frames, so resolving on close
        // alone can return an empty/truncated output. After the last data/close
        // event we wait a short quiet window so any trailing frames are included.
        const FLUSH_DELAY_MS = 15

        const cleanup = () => {
            dataSub?.unsubscribe()
            extDataSub?.unsubscribe()
            closeSub?.unsubscribe()
        }

        const finish = () => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(flushTimer)
            cleanup()
            resolve(output)
        }

        const fail = (err: Error) => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(flushTimer)
            cleanup()
            reject(err)
        }

        const armFlush = () => {
            clearTimeout(flushTimer)
            flushTimer = setTimeout(finish, FLUSH_DELAY_MS)
        }

        dataSub = channel.data$.subscribe({
            next: (data: Uint8Array) => {
                if (settled) {
                    return
                }
                output += Buffer.from(data).toString('utf-8')
                armFlush()
            },
            error: (err: Error) => fail(err),
        })

        extDataSub = channel.extendedData$.subscribe({
            next: () => {
                // Ignore stderr for these commands
            },
        })

        closeSub = channel.closed$.subscribe(() => {
            if (!settled) {
                armFlush()
            }
        })

        setTimeout(finish, timeoutMs)
    })
}
