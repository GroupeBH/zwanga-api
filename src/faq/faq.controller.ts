import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FaqService } from './faq.service';
import {
  CreateFaqEntryDto,
  ListFaqQueryDto,
  UpdateFaqEntryDto,
} from './dto/faq.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('FAQ')
@Controller('faq')
export class FaqController {
  constructor(private readonly faqService: FaqService) {}

  @Get()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Liste des questions fréquentes' })
  async findAll(@Query() query: ListFaqQueryDto) {
    return this.faqService.findAll(query);
  }

  @Get(':id')
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Récupérer une FAQ' })
  async findOne(@Param('id') id: string) {
    return this.faqService.findOne(id);
  }

  @Post()
  @Auth()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Créer une entrée FAQ' })
  async create(@Body() dto: CreateFaqEntryDto) {
    return this.faqService.create(dto);
  }

  @Put(':id')
  @Auth()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour une entrée FAQ' })
  async update(@Param('id') id: string, @Body() dto: UpdateFaqEntryDto) {
    return this.faqService.update(id, dto);
  }

  @Delete(':id')
  @Auth()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Supprimer une entrée FAQ' })
  async remove(@Param('id') id: string) {
    await this.faqService.remove(id);
    return { message: 'FAQ entry removed' };
  }
}

