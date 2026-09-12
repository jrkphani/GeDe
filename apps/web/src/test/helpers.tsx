import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { setConfigForTests, type AppConfig } from '../config.js';

export const TEST_CONFIG: AppConfig = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_test',
  userPoolClientId: 'client',
  apiUrl: 'https://api.test',
  wsUrl: 'wss://api.test/ws',
  appleSignIn: false,
  statusUrl: null,
};

export function withConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config = { ...TEST_CONFIG, ...overrides };
  setConfigForTests(config);
  return config;
}

export function renderRoutes(routes: RouteObject[], initialEntries: string[] = ['/']) {
  const router = createMemoryRouter(routes, { initialEntries });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}
