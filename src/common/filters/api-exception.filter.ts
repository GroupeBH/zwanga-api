import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

type ApiErrorMessage = string | string[];

interface ErrorDescriptor {
  statusCode: number;
  error: string;
  code: string;
  message: ApiErrorMessage;
}

interface TransportError extends Error {
  code?: string;
  type?: string;
  status?: number;
  statusCode?: number;
}

interface HttpExceptionPayload {
  statusCode?: number;
  error?: string;
  code?: string;
  message?: ApiErrorMessage;
}

const REQUEST_ABORTED_MESSAGE =
  'La connexion a été interrompue avant la réception complète de la requête. Vérifiez votre réseau puis réessayez.';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  private lastAbortedWarningAt = 0;
  private suppressedAbortedWarnings = 0;

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = this.getRequestId(request);
    const descriptor = this.describeException(exception);

    if (descriptor.code === 'REQUEST_ABORTED') {
      this.logAbortedRequest(request, requestId);
    } else if (descriptor.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const error = this.asError(exception);
      this.logger.error(
        `${request.method} ${this.getPath(request)} failed with ${descriptor.statusCode} (${descriptor.code}); requestId=${requestId}`,
        error?.stack,
      );
    }

    // An aborted request normally means that the peer has already closed the
    // socket. Attempting to write a JSON response would generate another error.
    if (
      response.headersSent ||
      response.writableEnded ||
      response.destroyed ||
      request.aborted
    ) {
      return;
    }

    response.setHeader('x-request-id', requestId);
    response.status(descriptor.statusCode).json({
      statusCode: descriptor.statusCode,
      error: descriptor.error,
      code: descriptor.code,
      message: descriptor.message,
      method: request.method,
      path: this.getPath(request),
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  private describeException(exception: unknown): ErrorDescriptor {
    const technicalError = this.asTransportError(exception);

    if (this.isRequestAborted(technicalError)) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Requête incomplète',
        code: 'REQUEST_ABORTED',
        message: REQUEST_ABORTED_MESSAGE,
      };
    }

    if (technicalError?.type === 'entity.too.large') {
      return {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        error: 'Fichier ou requête trop volumineux',
        code: 'PAYLOAD_TOO_LARGE',
        message:
          'La taille des données envoyées dépasse la limite autorisée. Réduisez la taille des fichiers puis réessayez.',
      };
    }

    if (
      technicalError?.type === 'entity.parse.failed' ||
      (technicalError?.name === 'SyntaxError' &&
        technicalError.status === HttpStatus.BAD_REQUEST)
    ) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Corps de requête invalide',
        code: 'INVALID_REQUEST_BODY',
        message:
          'Le corps de la requête est mal formé. Vérifiez le JSON ou les champs envoyés puis réessayez.',
      };
    }

    if (technicalError?.type === 'request.size.invalid') {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Taille de requête incorrecte',
        code: 'CONTENT_LENGTH_MISMATCH',
        message:
          'La taille reçue ne correspond pas à la taille annoncée par le client. Renvoyez la requête complète.',
      };
    }

    if (technicalError?.type === 'encoding.unsupported') {
      return {
        statusCode: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        error: 'Encodage non pris en charge',
        code: 'UNSUPPORTED_CONTENT_ENCODING',
        message:
          "L'encodage utilisé pour le corps de la requête n'est pas pris en charge.",
      };
    }

    if (this.isCorsError(technicalError)) {
      return {
        statusCode: HttpStatus.FORBIDDEN,
        error: 'Origine non autorisée',
        code: 'CORS_ORIGIN_FORBIDDEN',
        message:
          "Cette application web n'est pas autorisée à appeler l'API depuis son origine actuelle.",
      };
    }

    if (this.isTimeoutError(technicalError)) {
      return {
        statusCode: HttpStatus.REQUEST_TIMEOUT,
        error: "Délai d'attente dépassé",
        code: 'REQUEST_TIMEOUT',
        message:
          'La requête a pris trop de temps. Vérifiez votre connexion puis réessayez.',
      };
    }

    if (exception instanceof HttpException) {
      return this.describeHttpException(exception);
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Erreur interne',
      code: 'INTERNAL_SERVER_ERROR',
      message:
        "Une erreur interne est survenue. Réessayez plus tard et transmettez l'identifiant de la requête au support si le problème persiste.",
    };
  }

  private describeHttpException(exception: HttpException): ErrorDescriptor {
    const statusCode = exception.getStatus();
    const response = exception.getResponse();
    const payload =
      typeof response === 'object' && response !== null
        ? (response as HttpExceptionPayload)
        : null;
    const explicitMessage =
      typeof response === 'string' ? response : payload?.message;

    return {
      statusCode,
      error:
        payload?.error ||
        HttpStatus[statusCode]?.replaceAll('_', ' ') ||
        'Erreur HTTP',
      code: payload?.code || this.defaultCodeForStatus(statusCode),
      message: explicitMessage || this.defaultMessageForStatus(statusCode),
    };
  }

  private defaultCodeForStatus(statusCode: number): string {
    const codes: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
      [HttpStatus.UNAUTHORIZED]: 'AUTHENTICATION_REQUIRED',
      [HttpStatus.FORBIDDEN]: 'ACCESS_FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'RESOURCE_NOT_FOUND',
      [HttpStatus.CONFLICT]: 'RESOURCE_CONFLICT',
      [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
      [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMIT_EXCEEDED',
      [HttpStatus.BAD_GATEWAY]: 'UPSTREAM_SERVICE_ERROR',
      [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
      [HttpStatus.GATEWAY_TIMEOUT]: 'UPSTREAM_TIMEOUT',
    };

    return codes[statusCode] || `HTTP_${statusCode}`;
  }

  private defaultMessageForStatus(statusCode: number): string {
    const messages: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'La requête contient des données invalides.',
      [HttpStatus.UNAUTHORIZED]:
        'Votre session est absente ou expirée. Reconnectez-vous puis réessayez.',
      [HttpStatus.FORBIDDEN]:
        "Vous n'avez pas l'autorisation d'effectuer cette action.",
      [HttpStatus.NOT_FOUND]: "La ressource demandée n'existe pas ou plus.",
      [HttpStatus.CONFLICT]:
        "L'opération entre en conflit avec l'état actuel de la ressource.",
      [HttpStatus.PAYLOAD_TOO_LARGE]:
        'La taille des données envoyées dépasse la limite autorisée.',
      [HttpStatus.UNPROCESSABLE_ENTITY]:
        'Les données sont valides mais ne permettent pas cette opération.',
      [HttpStatus.TOO_MANY_REQUESTS]:
        'Trop de tentatives ont été effectuées. Patientez avant de réessayer.',
      [HttpStatus.BAD_GATEWAY]:
        'Un service externe a retourné une réponse invalide. Réessayez plus tard.',
      [HttpStatus.SERVICE_UNAVAILABLE]:
        'Le service est temporairement indisponible. Réessayez plus tard.',
      [HttpStatus.GATEWAY_TIMEOUT]:
        "Un service externe n'a pas répondu à temps. Réessayez plus tard.",
    };

    return (
      messages[statusCode] ||
      "Une erreur est survenue. Transmettez l'identifiant de la requête au support si elle persiste."
    );
  }

  private isRequestAborted(error: TransportError | null): boolean {
    if (!error) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      error.code === 'ECONNABORTED' ||
      error.type === 'request.aborted' ||
      message === 'request aborted'
    );
  }

  private isTimeoutError(error: TransportError | null): boolean {
    if (!error) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      error.code === 'ETIMEDOUT' ||
      error.code === 'ESOCKETTIMEDOUT' ||
      error.type === 'request.timeout' ||
      message.includes('request timeout')
    );
  }

  private isCorsError(error: TransportError | null): boolean {
    return Boolean(
      error?.message &&
      error.message.startsWith('Origin ') &&
      error.message.endsWith(' is not allowed by CORS'),
    );
  }

  private getRequestId(request: Request): string {
    const suppliedRequestId = request.headers?.['x-request-id'];
    if (
      typeof suppliedRequestId === 'string' &&
      suppliedRequestId.length <= 128
    ) {
      return suppliedRequestId;
    }

    const traceHeader = request.headers?.['x-amzn-trace-id'];
    if (typeof traceHeader === 'string') {
      const rootTraceId = traceHeader
        .split(';')
        .find((part) => part.startsWith('Root='))
        ?.slice('Root='.length);
      if (rootTraceId) {
        return rootTraceId;
      }
    }

    return randomUUID();
  }

  private getPath(request: Request): string {
    return request.originalUrl || request.url || '/';
  }

  private logAbortedRequest(request: Request, requestId: string): void {
    const now = Date.now();
    if (now - this.lastAbortedWarningAt < 60_000) {
      this.suppressedAbortedWarnings += 1;
      return;
    }

    const suppressedSuffix = this.suppressedAbortedWarnings
      ? `; ${this.suppressedAbortedWarnings} événement(s) similaire(s) regroupé(s)`
      : '';
    this.logger.warn(
      `Réception HTTP interrompue pour ${request.method} ${this.getPath(request)}; requestId=${requestId}${suppressedSuffix}`,
    );
    this.lastAbortedWarningAt = now;
    this.suppressedAbortedWarnings = 0;
  }

  private asTransportError(exception: unknown): TransportError | null {
    return exception instanceof Error ? (exception as TransportError) : null;
  }

  private asError(exception: unknown): Error | null {
    return exception instanceof Error ? exception : null;
  }
}
