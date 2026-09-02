import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { randomUUID as uuidv4 } from 'crypto';

const { combine, timestamp, json, errors, colorize, printf } = winston.format;

/**
 * Structured JSON Logger Configuration
 * Uses Winston with correlation ID support for distributed tracing.
 *
 * The Console transport's production JSON output is what actually gets
 * centralized: a node-level log agent (see
 * k8s/log-shipping-example.yaml's Fluent Bit DaemonSet) tails container
 * stdout, not this process's own filesystem — it never reads
 * logs/error.log or logs/combined.log below. Those two File transports are
 * a local-disk convenience only (e.g. `docker compose logs` alternatives,
 * or a bare-metal deploy with no log agent at all); in k8s they land on
 * `k8s/deployment.yaml`'s `logs` emptyDir, which is lost on pod restart
 * and never shipped anywhere. Neither transport is the centralized or
 * tamper-evident audit trail PCI DSS Req 10.5 asks for — see
 * docs/technical/security-and-compliance.md for what closes that gap and
 * what still doesn't.
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
