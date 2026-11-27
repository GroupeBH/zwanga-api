import {
  Controller,
  Get,
  Header,
  Optional,
  Param,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { PublicDriverService } from './public-driver.service';
import { publicDriverWebLink } from './public-driver.web-link';

@Controller('public/drivers')
@Public()
@SensitiveThrottle(30, 60000)
export class PublicDriverController {
  constructor(
    private readonly drivers: PublicDriverService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  getCard(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.drivers.getCard(id);
  }

  @Get(':id/card')
  page(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res() response: Response,
  ) {
    response.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    // Keep printed/shared legacy QR codes working, without rendering a profile here.
    const url = publicDriverWebLink(
      this.config?.get<string>('ZWANGA_PUBLIC_WEB_URL') ||
        this.config?.get<string>('FRONTEND_URL'),
      id,
    );
    return response.status(302).set('Location', url).end();
  }
}
