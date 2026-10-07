// In-memory stand-in for a Workers KV namespace (get/put/delete with "json" reads).

export function memoryKv(): KVNamespace & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const kv = {
    data,
    async get(key: string, type?: unknown) {
      const v = data.get(key);
      if (v === undefined) return null;
      const t = typeof type === 'string' ? type : (type as { type?: string } | undefined)?.type;
      return t === 'json' ? (JSON.parse(v) as unknown) : v;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
  return kv as unknown as KVNamespace & { data: Map<string, string> };
}
