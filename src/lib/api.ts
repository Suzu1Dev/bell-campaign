export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `讀取失敗（${res.status}）`);
  }
  return data;
}

export async function apiWrite<T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `操作失敗（${res.status}）`);
  }
  return data;
}
