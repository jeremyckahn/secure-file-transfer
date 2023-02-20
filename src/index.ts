/// <reference path = "./external-types.d.ts" />
import WebTorrent, { Torrent, TorrentFile, TorrentOptions } from 'webtorrent'
import streamSaver from 'streamsaver'
import { plaintextSize, encryptedSize } from 'wormhole-crypto'
import idbChunkStore from 'idb-chunk-store'
import { detectIncognito } from 'detectincognitojs'
import nodeToWebStream from 'readable-stream-node-to-web'
import { ReadableWebToNodeStream } from 'readable-web-to-node-stream'
import { getKeychain } from './getKeychain'

export const setStreamSaverMitm = (mitm: string) => {
  streamSaver.mitm = mitm
}

export const getStreamSaverMitm = () => streamSaver.mitm

export interface DownloadOpts {
  doSave?: boolean
  onProgress?: (progress: number) => void
}

export interface FileTransferOpts {
  /**
   * Options to configure WebTorrent operations with.
   * @see https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#clientaddtorrentid-opts-function-ontorrent-torrent-
   */
  torrentOpts?: TorrentOptions
}

export class FileTransfer {
  private torrentOpts: TorrentOptions

  private webTorrentClient = new WebTorrent()

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

  /**
   * @param
   */
  constructor(options: FileTransferOpts = {}) {
    const { torrentOpts = {} } = options
    this.torrentOpts = torrentOpts
    window.addEventListener('beforeunload', this.handleBeforePageUnload)
  }

  async download(
    magnetURI: string,
    password: string,
    { onProgress, doSave }: DownloadOpts = {}
  ) {
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
   */
  async offer(files: File[] | FileList, password: string) {
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

  rescind(magnetURI: string) {
    const torrent = this.torrents[magnetURI]

    if (torrent) {
      torrent.destroy()
    } else {
      console.error(`Attempted to clean up nonexistent torrent: ${magnetURI}`)
    }

    delete this.torrents[magnetURI]
  }

  rescindAll() {
    for (const magnetURI in this.torrents) {
      this.rescind(magnetURI)
    }
  }

  isOffering(magnetURI: string) {
    return magnetURI in this.torrents
  }

  handleBeforePageUnload = () => {
    this.rescindAll()
  }
}

export const fileTransfer = new FileTransfer()
