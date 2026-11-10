import { EventEmitter } from 'events'
import { ReadableStream as NodeWebReadableStream } from 'stream/web'

// The real converter needs a global ReadableStream at import time, which
// jsdom lacks. These tests hand the keychain mock web streams directly.
jest.mock('readable-stream-node-to-web', () => ({
  __esModule: true,
  default: (stream: unknown) => stream,
}))

// The shared setup mocks wormhole-crypto with only a Keychain; download()
// also needs plaintextSize. Its exact formula does not matter here.
jest.mock('wormhole-crypto', () => ({
  __esModule: true,
  Keychain: class Keychain {},
  plaintextSize: (encryptedSize: number) => encryptedSize - 100,
}))

const mockGetKeychain = jest.fn()

jest.mock('../src/getKeychain', () => ({
  getSubtleCrypto: jest.fn(),
  getKeychain: (password: string) => mockGetKeychain(password),
}))

// eslint-disable-next-line import/first
import {
  assertDecryptable,
  DecryptionError,
  DecryptionErrorReason,
  getDecryptedStream,
  toNodeReadable,
} from '../src/decryption'
// eslint-disable-next-line import/first
import { FileTransfer } from '../src'

const authError = () =>
  Object.assign(new Error('The operation failed'), { name: 'OperationError' })

/**
 * A web stream that yields `chunks`, then errors with `error` (or the result
 * of `getError`) if either is given.
 */
const webStream = (
  chunks: Uint8Array[],
  error?: Error,
  getError?: () => Error
) => {
  let i = 0
  const cancel = jest.fn()
  const stream = (new NodeWebReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else if (error || getError) {
        controller.error(error ?? getError?.())
      } else {
        controller.close()
      }
    },
    cancel,
  }) as unknown) as ReadableStream
  return { stream, cancel }
}

/** A keychain whose decryptStream yields the given stream factory's output. */
const keychainFor = (makeStream: () => ReadableStream) => ({
  decryptStream: jest.fn(async () => makeStream()),
})

const torrentFile = (name: string) => ({
  name,
  length: 1000,
  createReadStream: jest.fn(() => new EventEmitter()),
})

/**
 * A keychain whose decrypted stream fails because the underlying torrent
 * stream errors, passing the source's error object through as a real
 * pipeThrough does.
 */
const keychainWithSourceError = (sourceError: Error) => ({
  decryptStream: jest.fn(
    async (source: EventEmitter) =>
      webStream([], undefined, () => {
        source.emit('error', sourceError)
        return sourceError
      }).stream
  ),
})

type EventSource = {
  on(event: string, listener: (arg: any) => void): unknown
}

/** Reads a Node stream to the end, returning each chunk as a byte array. */
const collect = (stream: EventSource) =>
  new Promise<{ data: number[][]; error?: unknown }>(resolve => {
    const data: number[][] = []
    stream.on('data', (chunk: Uint8Array) => data.push(Array.from(chunk)))
    stream.on('end', () => resolve({ data }))
    stream.on('error', error => resolve({ data, error }))
  })

describe('DecryptionError', () => {
  it('is an Error that names the file and keeps the reason and cause', () => {
    const cause = authError()
    const error = new DecryptionError(
      'photo.jpg',
      DecryptionErrorReason.WRONG_PASSWORD,
      { cause }
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(DecryptionError)
    expect(error.name).toBe('DecryptionError')
    expect(error.reason).toBe(DecryptionErrorReason.WRONG_PASSWORD)
    expect(error.message).toContain('photo.jpg')
    expect(error.message).toContain('password')
    expect((error as { cause?: unknown }).cause).toBe(cause)
  })
})

describe('toNodeReadable', () => {
  it('emits all data and ends when the web stream succeeds', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
    const { data, error } = await collect(
      toNodeReadable(webStream(chunks).stream, 'a.bin')
    )

    expect(error).toBeUndefined()
    expect(data).toEqual([[1, 2], [3]])
  })

  it('emits a DecryptionError instead of hanging when a read fails', async () => {
    const cause = authError()
    const { data, error } = await collect(
      toNodeReadable(webStream([new Uint8Array([1])], cause).stream, 'a.bin')
    )

    expect(data).toEqual([[1]])
    expect(error).toBeInstanceOf(DecryptionError)
    // download() already verified the password, so a failure partway
    // through means corrupted data, not a wrong password.
    expect((error as DecryptionError).reason).toBe(
      DecryptionErrorReason.CORRUPTED_DATA
    )
    expect((error as DecryptionError).message).not.toContain('password')
    expect((error as { cause?: unknown }).cause).toBe(cause)
  })

  it('passes errors from the torrent data through unchanged', async () => {
    const sourceError = new Error('chunk store read failed')
    const stream = await getDecryptedStream(
      torrentFile('a.bin') as any,
      keychainWithSourceError(sourceError) as any
    )
    const { error } = await collect(toNodeReadable(stream, 'a.bin'))

    expect(error).toBe(sourceError)
  })
})

describe('assertDecryptable', () => {
  it('resolves and cancels the probe stream when decryption works', async () => {
    // More data than the check reads, so the stream is still open when it
    // is cancelled.
    const probe = webStream([1, 2, 3].map(n => new Uint8Array([n])))
    const keychain = keychainFor(() => probe.stream)

    await expect(
      assertDecryptable(torrentFile('a.bin') as any, keychain as any)
    ).resolves.toBeUndefined()
    // Cancellation is not awaited by assertDecryptable; let it settle.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(probe.cancel).toHaveBeenCalled()
  })

  it('rejects with a DecryptionError when the first record fails', async () => {
    const keychain = keychainFor(() => webStream([], authError()).stream)

    const error = await assertDecryptable(
      torrentFile('a.bin') as any,
      keychain as any
    ).catch(e => e)
    expect(error).toBeInstanceOf(DecryptionError)
    expect(error.reason).toBe(DecryptionErrorReason.WRONG_PASSWORD)
  })

  it('rejects with the original error when the torrent data fails', async () => {
    const sourceError = new Error('chunk store read failed')

    await expect(
      assertDecryptable(
        torrentFile('a.bin') as any,
        keychainWithSourceError(sourceError) as any
      )
    ).rejects.toBe(sourceError)
  })
})

describe('FileTransfer#download', () => {
  const magnetURI = 'magnet:?xt=urn:btih:test'

  /** A FileTransfer with an already-downloaded torrent for `magnetURI`. */
  const withCachedTorrent = (files: ReturnType<typeof torrentFile>[]) => {
    const fileTransfer = new FileTransfer()
    const torrent = { files, off: jest.fn() }
    ;(fileTransfer as any).torrents[magnetURI] = torrent
    return { fileTransfer, torrent }
  }

  it('rejects with a DecryptionError for a wrong password', async () => {
    const keychain = keychainFor(() => webStream([], authError()).stream)
    mockGetKeychain.mockResolvedValue(keychain)
    const { fileTransfer, torrent } = withCachedTorrent([
      torrentFile('a.bin'),
      torrentFile('b.bin'),
    ])

    await expect(
      fileTransfer.download(magnetURI, 'wrong password')
    ).rejects.toBeInstanceOf(DecryptionError)
    // Every file shares the keychain, so only the first is probed.
    expect(keychain.decryptStream).toHaveBeenCalledTimes(1)
    expect(torrent.off).toHaveBeenCalledWith('download', expect.any(Function))
    // The torrent stays cached so a retry with the right password does not
    // download it again.
    expect(fileTransfer.isOffering(magnetURI)).toBe(true)
  })

  it('resolves with the files for the right password', async () => {
    mockGetKeychain.mockResolvedValue(
      keychainFor(() => webStream([new Uint8Array([1, 2, 3])]).stream)
    )
    const { fileTransfer } = withCachedTorrent([
      torrentFile('a.bin'),
      torrentFile('b.bin'),
    ])

    const files = await fileTransfer.download(magnetURI, 'right password')

    expect(files.map(file => file.name)).toEqual(['a.bin', 'b.bin'])
    expect(files[0].length).toBe(900)
    const { data, error } = await collect(files[0].createReadStream())
    expect(error).toBeUndefined()
    expect(data).toEqual([[1, 2, 3]])
  })
})
