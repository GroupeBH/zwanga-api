import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, Request } from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../../users/entities/user.entity';
import { DriverDispatchService } from './dispatch.service';
import { RequestDispatchEventDto, DispatchResponseDto, DriverPositionDto, DriverPresenceDto, NotificationCapabilityDto, NotificationReceiptDto } from './dispatch.dto';

@Controller('driver-dispatch')
@Auth()
export class DriverDispatchController {
  constructor(private readonly dispatch: DriverDispatchService) {}

  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  status(@Request() req: { user: { userId: string } }) {
    return this.dispatch.status(req.user.userId);
  }

  @Post('notifications')
  @SensitiveThrottle(10, 60000)
  register(@Request() req: { user: { userId: string } }, @Body() _body: NotificationCapabilityDto) {
    return this.dispatch.registerNotifications(req.user.userId, _body.version);
  }

  @Put('presence')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(12, 60000)
  presence(@Request() req: { user: { userId: string } }, @Body() body: DriverPresenceDto) {
    return this.dispatch.setPresence(req.user.userId, body);
  }

  /** Call only after the recipient app received the invitation; never from a provider receipt. */
  @Post('notifications/:id/received')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(60, 60000)
  received(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string, @Body() body: NotificationReceiptDto) {
    return this.dispatch.acknowledgeNotification(req.user.userId, id, body.stage, body);
  }

  @Put('position')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(6, 60000)
  position(@Request() req: { user: { userId: string } }, @Body() body: DriverPositionDto) {
    return this.dispatch.recordPosition(req.user.userId, body);
  }

  @Get('offers/:id')
  @Roles(UserRole.DRIVER)
  @Header('Cache-Control', 'private, no-store')
  offer(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string) {
    return this.dispatch.getOffer(req.user.userId, id);
  }

  @Put('offers/:id/respond')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  respond(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DispatchResponseDto) {
    return this.dispatch.respond(req.user.userId, id, body.decision);
  }

  /** Authenticated event callback: neither identity nor timeout is trusted from the client. */
  @Post('requests/:id/events')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  event(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RequestDispatchEventDto) {
    return this.dispatch.receiveRequestEvent(req.user.userId, id, body.offerId);
  }

  @Put('nearby-requests/:id/decline')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  declineNearby(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string) {
    return this.dispatch.declineNearbyRequest(req.user.userId, id);
  }
}
