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
        let closed = false
        const dataSub = channel.data$.subscribe({
            next: (data: Uint8Array) => {
                output += Buffer.from(data).toString('utf-8')
            },
            error: (err: Error) => {
                if (!closed) {
                    closed = true
                    reject(err)
                }
            },
        })

        const extDataSub = channel.extendedData$.subscribe({
            next: ([_type, _data]: [number, Uint8Array]) => {
                // Ignore stderr for these commands
            },
        })

        const closeSub = channel.closed$.subscribe(() => {
            if (closed) {
                return
            }
            closed = true
            dataSub.unsubscribe()
            extDataSub.unsubscribe()
            closeSub.unsubscribe()
            resolve(output)
        })

        setTimeout(() => {
            if (!closed) {
                closed = true
                dataSub.unsubscribe()
                extDataSub.unsubscribe()
                closeSub.unsubscribe()
                resolve(output)
            }
        }, timeoutMs)
    })
}
