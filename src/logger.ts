import pino from 'pino';
import { config } from './config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino/file', options: { destination: 1 } } }
    : {}),
});

export type Logger = typeof logger;
