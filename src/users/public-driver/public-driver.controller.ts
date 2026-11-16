import {
  Controller,
  Get,
  Header,
  HttpException,
  Param,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { PublicDriverService } from './public-driver.service';
import { PUBLIC_DRIVER_CSP, renderDriverCard } from './public-driver.html';

@Controller('public/drivers')
@Public()
@SensitiveThrottle(30, 60000)
export class PublicDriverController {
  constructor(private readonly drivers: PublicDriverService) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  getCard(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.drivers.getCard(id);
  }

  @Get(':id/card')
  async page(@Param('id') id: string, @Res() response: Response) {
    response
      .set({
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Content-Security-Policy': PUBLIC_DRIVER_CSP,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      })
      .type('html');
    try {
      await new ParseUUIDPipe({ version: '4' }).transform(id, {
        type: 'param',
      });
      const card = await this.drivers.getCard(id);
      return response.send(renderDriverCard(card));
    } catch (error) {
      const code = error instanceof HttpException ? error.getStatus() : 503;
      // No provider/DB error detail or cached personal page on failure.
      return response
        .status(code === 404 || code === 400 ? 404 : 503)
        .send(renderDriverCard());
    }
  }
}
