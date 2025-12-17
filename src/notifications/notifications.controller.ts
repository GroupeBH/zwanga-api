import {
  Controller,
  Get,
  Put,
  Body,
  Request,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import { NotificationService } from './notifications.service';
import { MarkNotificationsAsReadDto } from './dto/notification.dto';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer toutes les notifications de l\'utilisateur' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Nombre de notifications à récupérer' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Nombre de notifications à ignorer' })
  @ApiResponse({ status: 200, description: 'Liste des notifications' })
  async findAll(
    @Request() req,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.notificationService.findAllByUser(req.user.userId, {
      limit: limit ? parseInt(String(limit)) : undefined,
      offset: offset ? parseInt(String(offset)) : undefined,
    });
  }

  @Put('mark-as-read')
  @ApiOperation({ summary: 'Marquer des notifications comme lues' })
  @ApiResponse({ status: 200, description: 'Notifications marquées comme lues' })
  async markAsRead(@Request() req, @Body() dto: MarkNotificationsAsReadDto) {
    return this.notificationService.markAsRead(req.user.userId, dto.notificationIds);
  }

  @Put('mark-all-as-read')
  @ApiOperation({ summary: 'Marquer toutes les notifications comme lues' })
  @ApiResponse({ status: 200, description: 'Toutes les notifications marquées comme lues' })
  async markAllAsRead(@Request() req) {
    return this.notificationService.markAllAsRead(req.user.userId);
  }

  @Put('mark-as-unread')
  @ApiOperation({ summary: 'Marquer des notifications comme non lues' })
  @ApiResponse({ status: 200, description: 'Notifications marquées comme non lues' })
  async markAsUnread(@Request() req, @Body() dto: MarkNotificationsAsReadDto) {
    return this.notificationService.markAsUnread(req.user.userId, dto.notificationIds);
  }
}

