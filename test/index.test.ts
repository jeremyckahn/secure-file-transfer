import { FileTransfer, fileTransfer } from '../src'

describe('FileTransfer', () => {
  it('instantiates', () => {
    expect(fileTransfer).toBeInstanceOf(FileTransfer)
  })
})
