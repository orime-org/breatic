const tokenKey = 'auth';

interface CustomerLoginBodyState {
  isAuthenticated: boolean;
  token: string;
}

interface CustomerLoginBody {
  state: CustomerLoginBodyState;
  version: number;
}

const setToken = (data: CustomerLoginBody) => {
  localStorage.setItem(tokenKey, JSON.stringify(data));
};

const getToken = () => {
  return localStorage.getItem(tokenKey);
};

const removeToken = () => {
  localStorage.removeItem(tokenKey);
};

export { setToken, getToken, removeToken };