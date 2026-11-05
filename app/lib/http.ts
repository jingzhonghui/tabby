import { ipcMain, net } from 'electron'

export interface HttpRequestOptions {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30000

/**
 * Proxies HTTP requests from the renderer process through the main process.
 *
 * Rendering a third-party API call from the renderer is subject to the browser
 * CORS policy, and some providers (notably Gitee) do not send CORS headers at
 * all. Requests issued through Electron's `net` module are also routed through
 * the system proxy configuration, which is what desktop users expect.
 */
export function registerHttpHandler (): void {
    ipcMain.handle('app:http-request', async (_event, options: HttpRequestOptions) => {
        if (typeof options.url !== 'string' || !/^https?:\/\//i.test(options.url)) {
            throw new Error('Invalid HTTP request URL')
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

        try {
            const response = await net.fetch(options.url, {
                method: options.method ?? 'GET',
                headers: {
                    'User-Agent': 'tabby-config-sync',
                    ...options.headers,
                },
                body: options.body,
                signal: controller.signal,
            })

            const headers: Record<string, string> = {}
            response.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value
            })

            return {
                status: response.status,
                statusText: response.statusText,
                headers,
                body: await response.text(),
            }
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                throw new Error(`Request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`)
            }
            throw error
        } finally {
            clearTimeout(timeout)
        }
    })
}
