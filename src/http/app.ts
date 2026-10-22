import type { Express } from 'express';
import { configureHttpMiddleware } from './middleware';
import { registerOperationalRoutes } from './operational-routes';
import { registerApiRoutes } from './routes';

/** Register HTTP layers in their original order; no listener is started here. */
export function configureHttpApplication(app: Express, port: string | number): void {
  configureHttpMiddleware(app);
  registerOperationalRoutes(app, port);
  registerApiRoutes(app);
}
