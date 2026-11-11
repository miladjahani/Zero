// Minimal ambient types for the Workers TCP Sockets API.
declare module 'cloudflare:sockets' {
  export interface Socket {
    opened: Promise<Socket>
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
    closed: Promise<void>
    write(data: string | Uint8Array): void
    close(): void
    startTls(options?: { expectedServerHostname?: string }): Socket
  }
  export function connect(
    address: string,
    options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowUntrustedTls?: boolean },
  ): Socket
}
