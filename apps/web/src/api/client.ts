import axios from 'axios';

export interface ApiEnvelope<T> { code: number; message: string; data: T }
export interface Paged<T> { list: T[]; total: number; page: number; pageSize: number }

export const http = axios.create({ baseURL: '/api', timeout: 30_000 });

http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('tk_token');
  if (token) cfg.headers.authorization = `Bearer ${token}`;
  return cfg;
});

http.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !err.config?.url?.includes('/auth/login')) {
      localStorage.removeItem('tk_token');
      if (!location.hash.includes('/login')) location.hash = '#/login';
    }
    return Promise.reject(err);
  },
);

export const payload = <T>(res: { data: ApiEnvelope<T> }): T => res.data.data;
export const apiGet = async <T>(url: string, params?: unknown) => payload(await http.get<T, { data: ApiEnvelope<T> }>(url, { params }));
export const apiPost = async <T>(url: string, body?: unknown) => payload(await http.post<T, { data: ApiEnvelope<T> }>(url, body));
export const apiPut = async <T>(url: string, body?: unknown) => payload(await http.put<T, { data: ApiEnvelope<T> }>(url, body));
export const apiDelete = async <T>(url: string) => payload(await http.delete<T, { data: ApiEnvelope<T> }>(url));

export const errMsg = (e: unknown): string =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (e as Error)?.message ?? '请求失败';
