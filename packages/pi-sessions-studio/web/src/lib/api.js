async function get(url, params) {
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const res = await fetch(url + qs);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `请求失败: ${res.status}`);
  }
  return res.json();
}

export const api = {
  overview: () => get('/api/overview'),
  projects: () => get('/api/projects'),
  sessions: (params) => get('/api/sessions', params),
  session: (id) => get(`/api/sessions/${id}`),
  search: (params) => get('/api/search', params),
  stats: (params) => get('/api/stats', params),
};
