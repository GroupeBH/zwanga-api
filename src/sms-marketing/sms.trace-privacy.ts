import { Injectable, OnModuleInit } from '@nestjs/common';
import { createRequire } from 'node:module';
import type { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

/** No raw query/short-code capture before Nest guards and exception filters. */
export function isSmsPrivateRequest(url?: string): boolean {
  let path = (url ?? '').split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Classify the raw path. */
  }
  return (
    /(?:^|\/)admin\/sms-marketing(?:\/|$)/i.test(path) ||
    /(?:^|\/)sms\/s(?:\/|$)/i.test(path)
  );
}

export function protectSmsIncomingTrace(instrument: HttpInstrumentation): void {
  const old = instrument.getConfig();
  const previous = old.ignoreIncomingRequestHook;
  instrument.setConfig({
    ...old,
    ignoreIncomingRequestHook: (request) =>
      isSmsPrivateRequest(request.url) || Boolean(previous?.(request)),
  });
}

@Injectable()
export class SmsTracePrivacy implements OnModuleInit {
  onModuleInit(): void {
    // Production already preloads ADOT through NODE_OPTIONS. Inspect its exported
    // instrumentation instances without starting an SDK/exporter in local runs.
    // Verified against the locked ADOT 0.12.0; no SDK monkey patch or global
    // tracing disable. Existing hooks and non-SMS telemetry remain unchanged.
    const localRequire = createRequire(__filename);
    const entry = localRequire.resolve(
      '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register',
    );
    const loaded = localRequire.cache[entry];
    if (!loaded) return;
    const instruments: HttpInstrumentation[] | undefined =
      loaded.exports.instrumentations;
    if (!Array.isArray(instruments))
      throw new Error('SMS_TRACE_PRIVACY_INITIALIZATION_FAILED');
    for (const instrument of instruments) {
      if (
        instrument.instrumentationName === '@opentelemetry/instrumentation-http'
      )
        protectSmsIncomingTrace(instrument);
    }
  }
}
