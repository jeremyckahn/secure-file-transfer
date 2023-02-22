/// <reference path = "./external-types.d.ts" />
import WebTorrent, {
  Options as InstanceOptions,
  Torrent,
  TorrentFile as _TorrentFile,
  TorrentOptions,
} from 'webtorrent'
import streamSaver from 'streamsaver'
import { plaintextSize, encryptedSize } from 'wormhole-crypto'
import idbChunkStore from 'idb-chunk-store'
import { detectIncognito } from 'detectincognitojs'
import nodeToWebStream from 'readable-stream-node-to-web'
import { ReadableWebToNodeStream } from 'readable-web-to-node-stream'
import { getKeychain } from './getKeychain'

/**
 * @see https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#file-api
 */
export type TorrentFile = _TorrentFile

/**
 * The custom StreamSaver `mitm` string to use.
 * @see https://github.com/jimmywarting/StreamSaver.js/#configuration
 */
export const setStreamSaverMitm = (mitm: string) => {
  streamSaver.mitm = mitm
}

/**
 * The custom StreamSaver `mitm` string being used.
 * @see https://github.com/jimmywarting/StreamSaver.js/#configuration
 */
export const getStreamSaverMitm = () => streamSaver.mitm

export interface DownloadOpts {
  /**
   * Whether to save the downloaded files to the user's file system.
   */
  doSave?: boolean

  /**
   * Callback invoked every time a chunk of data is received. `progress` is the
   * normalized (0-1) percentage value of download progress.
   */
  onProgress?: (progress: number) => void

  /**
   * Additional `TorrentOptions` to provide to WebTorrent for the download.
   * Merges with and overrides any options provided via the {@link
   * FileTransfer} constructor's `torrentOpts` option.
   * @see https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#clientaddtorrentid-opts-function-ontorrent-torrent-
   */
  torrentOpts?: TorrentOptions
}

export interface OfferOpts {
  /**
   * Additional `TorrentOptions` to provide to WebTorrent for the offer. Merges
   * with and overrides any options provided via the {@link FileTransfer}
   * constructor's `torrentOpts` option.
   * @see https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#clientaddtorrentid-opts-function-ontorrent-torrent-
   */
  torrentOpts?: TorrentOptions
}

export interface FileTransferOpts {
  /**
   * Options to configure the internal WebTorrent instance with.
   * @see https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#client--new-webtorrentopts
   * @see
   * [`RTCConfiguration`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#parameters)
   * @see [How to configure WebTorrent to use a custom `rtcConfig` (such as for
   * STUN/TURN
   * servers)](https://gist.github.com/swapnilshrikhande/e694ceb7f51a7c4ed2986d6d6a43c4a6)
   */
  webtorrentInstanceOpts?: InstanceOptions &
    Partial<{
      tracker: { rtcConfig: RTCConfiguration }
    }>

  /**
   * Options to configure WebTorrent `seed` and `add` operations with.
   * @see https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#clientaddtorrentid-opts-function-ontorrent-torrent-
   */
  torrentOpts?: TorrentOptions
}

export class FileTransfer {
  private torrentOpts: TorrentOptions

  private webTorrentClient: WebTorrent.Instance

  private torrents: Record<Torrent['magnetURI'], Torrent> = {}

  private async getDecryptedFileReadStream(
    file: TorrentFile,
    password: string
  ) {
    const keychain = getKeychain(password)

    const decryptedStream: ReadableStream = await keychain.decryptStream(
      nodeToWebStream(file.createReadStream())
    )

    return decryptedStream
  }

  private async saveTorrentFiles(files: TorrentFile[]) {
    for (const file of files) {
      try {
        const readStream = nodeToWebStream(file.createReadStream())

        const writeStream = streamSaver.createWriteStream(file.name, {
          size: file.length,
        })

        await readStream.pipeTo(writeStream)
      } catch (e) {
        console.error(e)
        throw new Error('Download aborted')
      }
    }
  }

  constructor(options: FileTransferOpts = {}) {
    const { torrentOpts = {}, webtorrentInstanceOpts } = options
    this.webTorrentClient = new WebTorrent(webtorrentInstanceOpts)
    this.torrentOpts = torrentOpts
    window.addEventListener('beforeunload', () => this.destroy())
  }

  /**
   * General-purpose cleanup method for when this `FileTransfer` instance is no
   * longer needed.
   */
  destroy() {
    this.rescindAll()
  }

  /**
   * Downloads and decrypts the files associated with `magnetURI`. For the
   * download operation to succeed, the peer offering the file **must**
   * maintain their offer until the downloading peer has finished downloading
   * the data.
   *
   * @param magnetURI A string that was returned by {@link FileTransfer#offer |
   * `offer`}.
   * @param password The password to decrypt the files with. Must be the same
   * as the `password` parameter that was provided to the {@link
   * FileTransfer#offer | `offer`} call that produced `magnetURI`.
   * @returns An array of downloaded {@link TorrentFile | files}.
   */
  async download(
    magnetURI: string,
    password: string,
    downloadOpts: DownloadOpts = {}
  ) {
    const { onProgress, doSave, torrentOpts } = downloadOpts
    let torrent = this.torrents[magnetURI]

    const handleDownload = () => {
      onProgress?.(torrent.progress)
    }

    if (!torrent) {
      const { isPrivate } = await detectIncognito()

      torrent = await new Promise<Torrent>(res => {
        this.webTorrentClient.add(
          magnetURI,
          {
            // If the user is using their browser's private mode, IndexedDB
            // will be unavailable and idbChunkStore will break all transfers.
            // In that case, fall back to the default in-memory data store.
            store: isPrivate ? undefined : idbChunkStore,
            destroyStoreOnDestroy: true,
            ...this.torrentOpts,
            ...torrentOpts,
          },
          torrent => {
            res(torrent)
          }
        )
      })

      this.torrents[torrent.magnetURI] = torrent

      torrent.on('download', handleDownload)

      await new Promise<void>(resolve => {
        torrent.on('done', () => {
          resolve()
        })
      })
    }

    const decryptedFiles = await Promise.all(
      torrent.files.map(async file => {
        const readableStream = await this.getDecryptedFileReadStream(
          file,
          password
        )
        const nodeReadableSteam = new ReadableWebToNodeStream(readableStream)

        const decryptedFile: TorrentFile = Object.setPrototypeOf(
          {
            ...file,
            length: plaintextSize(file.length),
            createReadStream: () => nodeReadableSteam,
          },
          Object.getPrototypeOf(file)
        )

        return decryptedFile
      })
    )

    if (doSave) {
      try {
        await this.saveTorrentFiles(decryptedFiles)
      } catch (e) {
        torrent.off('download', handleDownload)

        // Propagate error to the caller
        throw e
      }
    }

    return decryptedFiles
  }

  /**
   * Makes a list of files available to others to download.
   * @param files The
   * [`File`](https://developer.mozilla.org/docs/Web/API/File)s to offer to a
   * peer.
   * @param password The encryption key for the files.
   * @returns The [torrent magnet
   * URI](https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#torrentmagneturi)
   * that peers can use to download the offered file with {@link
   * FileTransfer#download | `download`}.
   */
  async offer(
    files: File[] | FileList,
    password: string,
    offerOpts: OfferOpts = {}
  ) {
    const { torrentOpts } = offerOpts
    const { isPrivate } = await detectIncognito()

    const filesToSeed: File[] =
      files instanceof FileList ? Array.from(files) : files

    const encryptedFiles = await Promise.all(
      filesToSeed.map(async file => {
        // Force a type conversion here to prevent stream from being typed as a
        // NodeJS.ReadableStream, which is the default overloaded return type
        // for file.stream().
        const stream = (file.stream() as any) as ReadableStream

        const encryptedStream = await getKeychain(password).encryptStream(
          stream
        )

        // WebTorrent internally opens the ReadableStream for file data twice.
        // Normally this would not be an issue for File instances provided to
        // WebTorrent for seeding. `encryptedFile` is implemented as a facade
        // for a File instance, with the key difference being that stream() is
        // overridden to return an encrypted instance of the file's stream
        // data. If this stream is reopened, an error would be thrown and the
        // operation would fail. To avoid this, `encryptedFile` streams are
        // tee'd and pooled beforehand so that reopening of the encrypted
        // stream data directly is avoided.
        //
        // See:
        //   - https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/tee
        const streamPool = encryptedStream.tee()

        // Providing the file data as a File instance rather than a
        // ReadableStream directly (which WebTorrent would accept) prevents
        // WebTorrent from loading the entire contents of the file into memory.
        //
        // See:
        //   - https://github.com/webtorrent/webtorrent/blob/e26b64c0d0b4bdd8222e19d90bfcf7a688203e3c/index.js#L376-L384
        //   - https://github.com/feross/simple-concat/blob/44134bf16667b6006a254135d5c8c76ea96823d4/index.js#L3-L8
        const encryptedFile = Object.setPrototypeOf(
          {
            lastModified: file.lastModified,
            name: file.name,
            size: encryptedSize(file.size),
            stream: () => streamPool.pop(),
            type: file.type,
          },
          File.prototype
        )

        return encryptedFile
      })
    )

    const offer = await new Promise<Torrent>(res => {
      this.webTorrentClient.seed(
        encryptedFiles,
        {
          // If the user is using their browser's private mode, IndexedDB will
          // be unavailable and idbChunkStore will break all transfers. In that
          // case, fall back to the default in-memory data store.
          store: isPrivate ? undefined : idbChunkStore,
          destroyStoreOnDestroy: true,
          ...this.torrentOpts,
          ...torrentOpts,
        },
        torrent => {
          res(torrent)
        }
      )
    })

    const { magnetURI } = offer
    this.torrents[magnetURI] = offer

    return magnetURI
  }

  /**
   * Rescinds a file offer that was made by {@link FileTransfer#offer |
   * `offer`}.
   */
  rescind(magnetURI: string) {
    const torrent = this.torrents[magnetURI]

    if (torrent) {
      torrent.destroy()
    } else {
      console.error(`Attempted to clean up nonexistent torrent: ${magnetURI}`)
    }

    delete this.torrents[magnetURI]
  }

  /**
   * Rescinds all file offers.
   */
  rescindAll() {
    for (const magnetURI in this.torrents) {
      this.rescind(magnetURI)
    }
  }

  /**
   * Whether or not an offer associated with `magnetURI` is currently being
   * made.
   */
  isOffering(magnetURI: string) {
    return magnetURI in this.torrents
  }
}

export const fileTransfer = new FileTransfer()
