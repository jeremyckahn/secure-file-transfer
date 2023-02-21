# `secure-file-transfer`

`secure-file-transfer` is the easiest solution for securely getting a file from one web browser to another. It works by connecting two people via WebTorrent and transferring files peer-to-peer via WebRTC. Files are encrypted prior to transmission and decrypted upon receipt, so data is never exposed to anyone other than the intended recipient. Files are never sent to a server.

`secure-file-transfer` builds on top of several excellent JavaScript libraries. It is specially tuned to minimize memory usage, thus enabling the delivery of very large files (as much as your browser has disk resources for).

`secure-file-transfer` is the library that [Chitchatter](https://chitchatter.im/) uses to transfer files to connected peers.

## Install

```sh
npm i --save secure-file-transfer
```

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

If the encryption keys match, the file will be transferred directly from the offerer to the receiver and saved to the local file system.

## License

MIT.
