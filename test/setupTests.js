afterEach(() => {
  jest.restoreAllMocks()
})

jest.mock('webtorrent', () => ({
  __esModule: true,
  default: class WebTorrent {},
}))

jest.mock('wormhole-crypto', () => ({
  __esModule: true,
  Keychain: class Keychain {},
}))
