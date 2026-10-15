// Minimal API client, so the build carries the backend address and the endpoints it calls.
import { API_URL } from './config.js';

const call = (path, method, body, token) =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

export const health = () => call('/health', 'GET');
export const register = (email, password) => call('/auth/register', 'POST', { email, password });
export const login = (email, password) => call('/auth/login', 'POST', { email, password });
export const logout = (token) => call('/auth/logout', 'POST', null, token);
export const me = (token) => call('/me', 'GET', null, token);
export const sync = (token, since, habits, checkins) => call('/sync', 'POST', { since, habits, checkins }, token);
