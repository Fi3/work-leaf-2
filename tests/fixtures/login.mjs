export function loginModels(login, { provider = 'test', method = 'oauth', refresh = async () => ({ errors: new Map() }) } = {}) {
  const name = method === 'oauth' ? 'Account' : 'Key';
  return {
    refresh,
    getProvider: () => ({ id: provider, name: 'Test', auth: { [method === 'oauth' ? 'oauth' : 'apiKey']: { name, login() {} } } }),
    login,
  };
}
