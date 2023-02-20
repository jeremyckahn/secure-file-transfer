import { Keychain } from 'wormhole-crypto'

export const getKeychain = (password: string) => {
  const encoder = new TextEncoder()
  const keyLength = 16
  const padding = new Array(keyLength).join('0')
  const key = password.concat(padding).slice(0, keyLength)
  const salt = window.location.origin.concat(padding).slice(0, keyLength)

  const keychain = new Keychain(encoder.encode(key), encoder.encode(salt))

  return keychain
}
