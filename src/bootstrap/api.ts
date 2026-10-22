import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { validateApiEnvironment } from '../config/api-runtime.config';
import { parseTrustProxy } from '../config/http.config';
import { configureHttpApplication } from '../http/app';
import { createSocketServer } from '../realtime/server';
import { initializeApiRedis } from '../realtime/redis';
import { createSocketContext } from '../realtime/context';
import { registerSocketHandlers } from '../realtime/register-handlers';
import { startApiLifecycle } from './api-lifecycle';

validateApiEnvironment();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

const io = createSocketServer(httpServer);
const redisStartupPromise = initializeApiRedis(io);
const socketContext = createSocketContext(io);
registerSocketHandlers(io, socketContext);
configureHttpApplication(app, PORT);
startApiLifecycle(httpServer, redisStartupPromise, HOST, PORT);
