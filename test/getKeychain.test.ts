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
import { getKeychain, PBKDF2_ITERATIONS } from '../src/getKeychain'

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

  it('does not use the password as the key', async () => {
    const { key } = await derive('abcdefghijklmnop')
    expect(key.toString('utf8')).not.toBe('abcdefghijklmnop')
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
