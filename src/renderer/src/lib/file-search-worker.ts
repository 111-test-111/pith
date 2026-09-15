import { searchFile, type FileSearchOptions } from './file-search'
self.onmessage = (event: MessageEvent<{ text: string; query: string; options: FileSearchOptions }>) => {
  self.postMessage(searchFile(event.data.text, event.data.query, event.data.options))
}
