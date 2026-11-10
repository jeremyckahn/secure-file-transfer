import { Keychain } from 'wormhole-crypto'
import nodeToWebStream from 'readable-stream-node-to-web'
import { ReadableWebToNodeStream } from 'readable-web-to-node-stream'
import { TorrentFile } from 'webtorrent'

/**
 * Thrown by {@link FileTransfer#download | `download`} when downloaded data
 * cannot be decrypted. This almost always means the password differs from
 * the one the files were offered with, but it is also what tampered or
 * corrupted data produces.
 */
export class DecryptionError extends Error {
  constructor(fileName: string, options?: { cause?: unknown }) {
    super(`Could not decrypt "${fileName}". The password may be incorrect.`)
    // Keep `instanceof` working when this class is compiled to ES5.
    Object.setPrototypeOf(this, DecryptionError.prototype)
    this.name = 'DecryptionError'

    if (options && 'cause' in options) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * Opens a decrypted web stream of `file`'s contents. Decryption is lazy: data
 * is only decrypted (and authenticated) as the stream is read.
 */
export const getDecryptedStream = (
  file: TorrentFile,
  keychain: Keychain
): Promise<ReadableStream> =>
  keychain.decryptStream(nodeToWebStream(file.createReadStream()))

/**
 * Rejects with a {@link DecryptionError} if `file` cannot be decrypted with
 * `keychain`.
 *
 * Every record is authenticated (AES-GCM), so decrypting the first record of
 * a separate read stream is enough to detect a wrong password without
 * reading the whole file.
 */
export const assertDecryptable = async (
  file: TorrentFile,
  keychain: Keychain
) => {
  const reader = (await getDecryptedStream(file, keychain)).getReader()

  try {
    await reader.read()
  } catch (cause) {
    throw new DecryptionError(file.name, { cause })
  } finally {
    // Only the first record is needed. Cancelling also closes the underlying
    // torrent file stream. It rejects if the stream already errored, which
    // is expected and safe to ignore.
    reader.cancel().catch(() => {})
  }
}

/**
 * Wraps a web stream in a Node readable stream that emits `error` when the
 * web stream fails.
 *
 * `ReadableWebToNodeStream` does not handle a rejected read, so a decryption
 * failure would otherwise surface as an unhandled rejection and leave
 * consumers of the Node stream waiting forever.
 */
export const toNodeReadable = (
  webStream: ReadableStream,
  fileName: string
): NodeJS.ReadableStream => {
  // ReadableWebToNodeStream extends readable-stream's Readable, which ships
  // no types, so its stream methods (`on`, `destroy`, ...) are invisible to
  // TypeScript. Name the ones used here.
  const nodeStream = new ReadableWebToNodeStream(
    webStream
  ) as ReadableWebToNodeStream & {
    destroy(error: Error): void
  }
  const read = nodeStream._read.bind(nodeStream)

  // Patch the instance rather than subclass: the library ships a native
  // class, which compiled ES5 subclasses cannot extend.
  nodeStream._read = async () => {
    try {
      await read()
    } catch (cause) {
      nodeStream.destroy(new DecryptionError(fileName, { cause }))
    }
  }

  // At runtime this is a Node Readable, which is what consumers of
  // `TorrentFile#createReadStream` expect.
  return (nodeStream as unknown) as NodeJS.ReadableStream
}
