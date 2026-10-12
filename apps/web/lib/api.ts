export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 画面と同じオリジンの /api/* を呼ぶ（next.config.mjs でAPIサーバーへ中継される）。 */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? 'エラーが発生しました');
  }
  return data as T;
}

export interface UserInfo {
  id: string;
  displayName: string;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export type MatchStatus =
  | { status: 'waiting'; scenarioId: string; size: number; waiting: number }
  | { status: 'matched'; roomId: string }
  | { status: 'none' };
