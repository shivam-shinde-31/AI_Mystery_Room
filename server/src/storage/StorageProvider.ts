export interface StorageProvider {
  put(key: string, content: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<{ content: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
