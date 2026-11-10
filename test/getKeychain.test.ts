import { webcrypto, pbkdf2Sync } from 'crypto'
import { TextEncoder } from 'util'

const keychainArgs: Uint8Array[][] = []

jest.mock('wormhole-crypto', () => ({
  __esModule: true,
  Keychain: class Keychain {
    constructor(key: Uint8Array, salt: Uint8Array) {
      keychainArgs.push([key, salt])
    }
  },
}))

// eslint-disable-next-line import/first
import * as getKeychainModule from '../src/getKeychain'
// eslint-disable-next-line import/first
import {
  getKeychain,
  getSubtleCrypto,
  PBKDF2_ITERATIONS,
} from '../src/getKeychain'
// eslint-disable-next-line import/first
import { FileTransfer } from '../src'

beforeAll(() => {
  Object.defineProperty(window, 'TextEncoder', {
    value: TextEncoder,
    configurable: true,
  })
  Object.defineProperty(window, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
})

beforeEach(() => {
  keychainArgs.length = 0
})

const derive = async (password: string) => {
  await getKeychain(password)
  const [key, salt] = keychainArgs[keychainArgs.length - 1]
  return { key: Buffer.from(key), salt: Buffer.from(salt) }
}

describe('getKeychain', () => {
  it('derives a 16-byte key and salt with PBKDF2-SHA256', async () => {
    const { key, salt } = await derive('correct horse battery staple')

    const expected = pbkdf2Sync(
      'correct horse battery staple',
      `secure-file-transfer:v1:${window.location.origin}`,
      PBKDF2_ITERATIONS,
      32,
      'sha256'
    )

    expect(key).toHaveLength(16)
    expect(salt).toHaveLength(16)
    expect(key.equals(expected.subarray(0, 16))).toBe(true)
    expect(salt.equals(expected.subarray(16))).toBe(true)
  })

  it('derives the same keychain for the same password', async () => {
    // offer() and download() derive their keychains independently, so they
    // must agree for a transfer to be decryptable.
    const a = await derive('shared secret')
    const b = await derive('shared secret')
    expect(a.key.equals(b.key)).toBe(true)
    expect(a.salt.equals(b.salt)).toBe(true)
  })

  it('derives different keychains for different passwords', async () => {
    const a = await derive('password one')
    const b = await derive('password two')
    expect(a.key.equals(b.key)).toBe(false)
    expect(a.salt.equals(b.salt)).toBe(false)
  })

  it('uses every character of long passwords', async () => {
    const a = await derive('0123456789abcdef-suffix-one')
    const b = await derive('0123456789abcdef-suffix-two')
    expect(a.key.equals(b.key)).toBe(false)
  })

  it('handles multi-byte passwords', async () => {
    const { key } = await derive('pässwörd-ünïcødé-🔐')
    expect(key).toHaveLength(16)
  })
})

describe('without Web Crypto', () => {
  const secureContextError = /requires the Web Crypto API/

  it('getSubtleCrypto throws a descriptive error', () => {
    // Non-secure browser contexts expose `crypto` but not `crypto.subtle`.
    expect(() => getSubtleCrypto({} as Crypto)).toThrow(secureContextError)
  })

  it('download fails before adding a torrent', async () => {
    jest.spyOn(getKeychainModule, 'getSubtleCrypto').mockImplementation(() => {
      throw new Error('secure-file-transfer requires the Web Crypto API')
    })

    const fileTransfer = new FileTransfer()
    const add = jest.fn()
    ;(fileTransfer as any).webTorrentClient.add = add

    await expect(
      fileTransfer.download('magnet:?xt=urn:btih:test', 'password')
    ).rejects.toThrow(secureContextError)
    expect(add).not.toHaveBeenCalled()
    expect(fileTransfer.isOffering('magnet:?xt=urn:btih:test')).toBe(false)
  })
})
