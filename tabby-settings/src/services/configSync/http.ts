import { HttpRequestOptions, PlatformService } from 'tabby-core'

export class HttpError extends Error {
    constructor (
        message: string,
        public status: number,
        public body: string,
    ) {
        super(message)
    }
}

/**
 * Issues an HTTP request through the platform layer (bypassing browser CORS
 * restrictions on the desktop) and parses a JSON response.
 */
export async function requestJson (platform: PlatformService, options: HttpRequestOptions): Promise<any> {
    const response = await platform.httpRequest({ timeoutMs: 30000, ...options })
    if (response.status < 200 || response.status >= 300) {
        const statusLine = [response.status, response.statusText].filter(x => !!x).join(' ')
        const parts = [`${options.method ?? 'GET'} ${options.url} failed: ${statusLine}`]
        try {
            const parsed = JSON.parse(response.body)
            if (parsed?.message) {
                parts.push(parsed.message)
            }
        } catch {
            // Response body is not JSON, keep the status line only.
        }
        throw new HttpError(parts.join(' - '), response.status, response.body)
    }
    if (!response.body) {
        return undefined
    }
    try {
        return JSON.parse(response.body)
    } catch {
        return response.body
    }
}
