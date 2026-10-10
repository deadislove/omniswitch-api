import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { DeprecationHeaderInterceptor } from './deprecation-header.interceptor';
import { Deprecated } from '../decorators/deprecated.decorator';

class DeprecatedController {
  @Deprecated({ sunsetDate: '2027-01-01', migrationGuideUrl: 'https://example.com/migrate' })
  deprecatedHandler(): void {}

  currentHandler(): void {}
}

function buildContext(handlerName: keyof DeprecatedController): {
  context: ExecutionContext;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const instance = new DeprecatedController();
  const context = {
    getHandler: () => instance[handlerName],
    getClass: () => DeprecatedController,
    switchToHttp: () => ({
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

const nextHandler: CallHandler = { handle: () => of('ok') };

describe('DeprecationHeaderInterceptor', () => {
  const interceptor = new DeprecationHeaderInterceptor(new Reflector());

  it('adds Sunset/Deprecation/Link headers on a route decorated with @Deprecated()', (done) => {
    const { context, headers } = buildContext('deprecatedHandler');

    interceptor.intercept(context, nextHandler).subscribe(() => {
      expect(headers['Deprecation']).toBe('true');
      expect(headers['Sunset']).toBe(new Date('2027-01-01').toUTCString());
      expect(headers['Link']).toBe('<https://example.com/migrate>; rel="deprecation"');
      done();
    });
  });

  it('adds no headers on a route without the decorator', (done) => {
    const { context, headers } = buildContext('currentHandler');

    interceptor.intercept(context, nextHandler).subscribe(() => {
      expect(headers).toEqual({});
      done();
    });
  });
});
