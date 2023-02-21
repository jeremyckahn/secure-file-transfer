# `secure-file-transfer`

[**API documentation**](https://jeremyckahn.github.io/secure-file-transfer/)

## Install

```sh
npm i --save secure-file-transfer
```

`secure-file-transfer` (SFT) is the easiest solution for securely getting a file from one web browser to another. It works by connecting two people via WebTorrent and transferring files peer-to-peer via WebRTC. Files are encrypted prior to transmission and decrypted upon receipt, so data is never exposed to anyone other than the intended recipient. Files are never sent to a server, and no server setup is needed to use SFT.

SFT is the library that [Chitchatter](https://chitchatter.im/) uses to transfer files to connected peers.

## Why use `secure-file-transfer`?

SFT builds on top of WebTorrent and several other excellent JavaScript libraries. It is specially tuned to minimize memory usage, thus enabling the delivery of very large files (as much as [your browser can handle](#limitations)).

WebTorrent is a powerful library, but there are a number of important things it doesn't do:

  - File encryption
    - This is critical when using public WebTorrent trackers. Without encryption, anyone with access to the tracker could intercept files being transferred between peers. Short of running your own private tracker, [encrypting data prior to sending it](https://github.com/webtorrent/webtorrent/issues/386#issuecomment-125379219) is the best way to ensure that only the intended party can access transferred file. SFT uses [`wormhole-crypto`](https://github.com/SocketDev/wormhole-crypto) to do this automatically.
  - File saving
    - This functionality is left up to WebTorrent users to implement. The most straightforward solution for closing this gap is [FileSaver.js](https://github.com/eligrey/FileSaver.js/). However, FileSaver.js has [limited file size support](https://github.com/eligrey/FileSaver.js/#supported-browsers). A more scalable solution is to stream data to disk, which SFT uses [StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js) to do automatically.

By default, WebTorrent stores torrents in system memory. This is also not suitable for very large files. To work around this, SFT uses [idb-chunk-store](https://github.com/SocketDev/idb-chunk-store) to stream data directly from the sender's disk to the receiver's and keep memory usage low.

### Limitations

SFT has no hard limits around file sizes, but there are a number of browser limitations to keep in mind.

Since torrent data is temporarily held in IndexedDB via idb-chunk-store (to minimize memory usage), it is subject to browser [storage limits](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Browser_storage_limits_and_eviction_criteria#storage_limits). Once downloaded, the data is streamed from IndexedDB to the local file system as a plain file via StreamSaver.js. However, browsers will limit how long the stream can last. Currently, the time limit for this operation is [30 seconds for Firefox](https://github.com/jimmywarting/StreamSaver.js/issues/292) and [5 minutes for Chromium-based browsers](https://github.com/jimmywarting/StreamSaver.js#best-practice).

## Example

On one page have, [something like this](https://codesandbox.io/s/secure-file-transfer-offer-hhovi4?file=/src/index.ts) (in TypeScript):

```ts
import { fileTransfer } from "secure-file-transfer";

document.body.innerHTML = `
<input type="text" placeholder="Encryption key" />
<input type="file" multiple />
<h1>Magnet URI:</h1>
<p />
`;

const fileInput = document.querySelector('[type="file"]');
const passwordInput = document.querySelector('[type="text"]');
const p = document.querySelector("p");

const handleChange = async (evt: Event) => {
  const password = passwordInput.value;
  const magnetURI = await fileTransfer.offer(evt.target.files, password);
  p.innerText = magnetURI;
};

fileInput?.addEventListener("change", handleChange);
```

Then on another page, [something like this](https://codesandbox.io/s/secure-file-transfer-receive-5fsweg?file=/src/index.ts):

```ts
import { fileTransfer } from "secure-file-transfer";

document.body.innerHTML = `
<input type="text" placeholder="Encryption key" style="display: block;" />
<textarea placeholder="Magnet URI"></textarea>
<button style="display: block;">Download file(s)</button>
<p></p>
`;

const downloadButton = document.querySelector("button");
const passwordInput = document.querySelector('[type="text"]');
const magnetUriInput = document.querySelector("textarea");
const status = document.querySelector("p");

const handleDownloadClick = async (evt: Event) => {
  status?.innerText = "Downloading...";
  const password = passwordInput.value;
  const magnetUri = magnetUriInput.value;
  await fileTransfer.download(magnetUri, password, { doSave: true });
  status?.innerText = "Done!";
};

downloadButton.addEventListener("click", handleDownloadClick);
```

If the encryption keys match, the file will be transferred directly from the offerer to the receiver and saved to the local file system (so long as both peers keep their pages open).

## License

MIT.
