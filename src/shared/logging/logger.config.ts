import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

const { combine, timestamp, json, errors, colorize, printf } = winston.format;

/**
 * Structured JSON Logger Configuration
 * Uses Winston with correlation ID support for distributed tracing.
 */
export const createLoggerConfig = (serviceName: string, nodeEnv: string) => {
  const isProduction = nodeEnv === 'production';

  const formats = isProduction
    ? combine(
        errors({ stack: true }),
        timestamp({ format: 'ISO' }),
        json(),
      )
    : combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        colorize({ all: true }),
        printf(({ level, message, timestamp: ts, context, correlationId, ...meta }) => {
          const ctx = context ? `[${context}]` : '';
          const cid = correlationId ? ` cid=${correlationId}` : '';
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${ts} ${level} ${ctx}${cid}: ${message}${metaStr}`;
        }),
      );

  return WinstonModule.createLogger({
    level: isProduction ? 'info' : 'debug',
    defaultMeta: {
      service: serviceName,
      version: process.env.APP_VERSION || '1.0.0',
      environment: nodeEnv,
    },
    transports: [
      new winston.transports.Console({
        format: formats,
      }),
      ...(isProduction
        ? [
            new winston.transports.File({
              filename: 'logs/error.log',
              level: 'error',
              format: combine(timestamp(), json()),
            }),
            new winston.transports.File({
              filename: 'logs/combined.log',
              format: combine(timestamp(), json()),
            }),
          ]
        : []),
    ],
  });
};
