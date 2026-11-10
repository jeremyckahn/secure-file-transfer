import { Keychain } from 'wormhole-crypto'

/**
 * PBKDF2-HMAC-SHA256 iteration count. Matches the current OWASP
 * recommendation for PBKDF2-HMAC-SHA256.
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2
 */
export const PBKDF2_ITERATIONS = 600_000

const KEY_LENGTH_BYTES = 16

const SALT_DOMAIN = 'secure-file-transfer:v1:'

/**
 * Returns the Web Crypto `SubtleCrypto` instance, or throws a descriptive
 * error if it is unavailable (such as on non-secure origins).
 */
export const getSubtleCrypto = (
  cryptoImpl: Crypto | undefined = window.crypto
) => {
  const subtle = cryptoImpl?.subtle

  if (!subtle) {
    throw new Error(
      'secure-file-transfer requires the Web Crypto API, which is only available in secure contexts (HTTPS or localhost)'
    )
  }

  return subtle
}

/**
 * Derives a wormhole-crypto `Keychain` from a user-provided password.
 *
 * The full password is stretched with PBKDF2-HMAC-SHA256 into 32 bytes of key
 * material: the first 16 bytes are used as the Keychain's main key and the
 * remaining 16 bytes as the Keychain's salt. The file data itself is
 * encrypted by wormhole-crypto using RFC 8188 (AES-128-GCM), which uses a
 * random per-stream salt and authenticates every record.
 */
export const getKeychain = async (password: string) => {
  const subtle = getSubtleCrypto()
  const encoder = new TextEncoder()

  const passwordKey = await subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )

  const derivedBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encoder.encode(SALT_DOMAIN.concat(window.location.origin)),
      iterations: PBKDF2_ITERATIONS,
    },
    passwordKey,
    KEY_LENGTH_BYTES * 2 * 8
  )

  const derived = new Uint8Array(derivedBits)
  const key = derived.slice(0, KEY_LENGTH_BYTES)
  const salt = derived.slice(KEY_LENGTH_BYTES)

  return new Keychain(key, salt)
}
