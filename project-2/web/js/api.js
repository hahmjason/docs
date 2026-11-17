// 로컬 서버 API 클라이언트 (same-origin 전용 — CSP connect-src 'self')
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** SSE 구독. 끊기면 EventSource가 자동 재연결한다. */
export function openStream(handlers, onStatus) {
  const es = new EventSource("/api/stream");
  for (const [ev, fn] of Object.entries(handlers)) {
    es.addEventListener(ev, (e) => {
      try { fn(JSON.parse(e.data)); } catch (err) { console.error(ev, err); }
    });
  }
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  return es;
}
