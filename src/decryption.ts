import { Keychain } from 'wormhole-crypto'
import nodeToWebStream from 'readable-stream-node-to-web'
import { ReadableWebToNodeStream } from 'readable-web-to-node-stream'
import { TorrentFile } from 'webtorrent'

/**
 * Why a {@link DecryptionError} was thrown.
 */
export enum DecryptionErrorReason {
  /**
   * The first record of a file could not be decrypted. This almost always
   * means the password differs from the one the files were offered with.
   */
  WRONG_PASSWORD = 'WRONG_PASSWORD',

  /**
   * Decryption failed partway through a file whose start decrypted
   * successfully, so the password is right but the data was corrupted or
   * tampered with.
   */
  CORRUPTED_DATA = 'CORRUPTED_DATA',
}

const messages: Record<DecryptionErrorReason, string> = {
  [DecryptionErrorReason.WRONG_PASSWORD]: 'The password may be incorrect.',
  [DecryptionErrorReason.CORRUPTED_DATA]:
    'The data may have been corrupted or tampered with.',
}

/**
 * Thrown by {@link FileTransfer#download | `download`}, or emitted as `error`
 * by a downloaded file's read stream, when downloaded data cannot be
 * decrypted. See `reason` for the likely cause.
 */
export class DecryptionError extends Error {
  readonly reason: DecryptionErrorReason

  constructor(
    fileName: string,
    reason: DecryptionErrorReason,
    options?: { cause?: unknown }
  ) {
    super(`Could not decrypt "${fileName}". ${messages[reason]}`)
    // Keep `instanceof` working when this class is compiled to ES5.
    Object.setPrototypeOf(this, DecryptionError.prototype)
    this.name = 'DecryptionError'
    this.reason = reason

    if (options && 'cause' in options) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * Errors emitted by the underlying torrent file streams, such as chunk store
 * read failures. They reach a decrypted stream's reader as the same object, so
 * they can be told apart from decryption failures and passed through as-is.
 */
const sourceErrors = new WeakSet<object>()

const isSourceError = (error: unknown) =>
  typeof error === 'object' && error !== null && sourceErrors.has(error)

/**
 * Returns `cause` unchanged if it came from the torrent data itself, and a
 * {@link DecryptionError} otherwise.
 */
const toDecryptionFailure = (
  cause: unknown,
  fileName: string,
  reason: DecryptionErrorReason
) =>
  isSourceError(cause)
    ? cause
    : new DecryptionError(fileName, reason, { cause })

/**
 * Opens a decrypted web stream of `file`'s contents. Decryption is lazy: data
 * is only decrypted (and authenticated) as the stream is read.
 */
export const getDecryptedStream = (
  file: TorrentFile,
  keychain: Keychain
): Promise<ReadableStream> => {
  const source = file.createReadStream()

  source.on('error', (error: unknown) => {
    if (typeof error === 'object' && error !== null) sourceErrors.add(error)
  })

  return keychain.decryptStream(nodeToWebStream(source))
}

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
    throw toDecryptionFailure(
      cause,
      file.name,
      DecryptionErrorReason.WRONG_PASSWORD
    )
  } finally {
    // Only the first record is needed. Cancelling also closes the underlying
    // torrent file stream. It rejects if the stream already errored, which
    // is expected and safe to ignore.
    reader.cancel().catch(() => {})
  }
}

/**
 * Wraps a decrypted web stream in a Node readable stream that emits `error`
 * when the web stream fails.
 *
 * `ReadableWebToNodeStream` does not handle a rejected read, so a decryption
 * failure would otherwise surface as an unhandled rejection and leave
 * consumers of the Node stream waiting forever. The password has already been
 * checked by {@link assertDecryptable}, so a failure here means the data is
 * corrupted.
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
    destroy(error: unknown): void
  }
  const read = nodeStream._read.bind(nodeStream)

  // Patch the instance rather than subclass: the library ships a native
  // class, which compiled ES5 subclasses cannot extend.
  nodeStream._read = async () => {
    try {
      await read()
    } catch (cause) {
      nodeStream.destroy(
        toDecryptionFailure(
          cause,
          fileName,
          DecryptionErrorReason.CORRUPTED_DATA
        )
      )
    }
  }

  // At runtime this is a Node Readable, which is what consumers of
  // `TorrentFile#createReadStream` expect.
  return (nodeStream as unknown) as NodeJS.ReadableStream
}
