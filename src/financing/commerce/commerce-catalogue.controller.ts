import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditActor } from '../shared/credit.store';
import { CreditPageDto } from '../shared/credit.dto';
import { CommerceCatalogueService } from './commerce-catalogue.service';
import {
  CommerceCategoryDto,
  CommerceProductDto,
  PurchaseQuoteDto,
  CommercePageDto,
} from './commerce.dto';

@Controller('zwanga-pro/commerce')
@Auth()
@SensitiveThrottle(60, 60000)
export class CommerceCatalogueController {
  constructor(private readonly service: CommerceCatalogueService) {}
  @Public() @Get('categories') categories() {
    return this.service.categories();
  }
  @Public() @Get('products') list(@Query() page: CommercePageDto) {
    return this.service.list(page, page.categoryId);
  }
  @Public() @Get('products/:id') product(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.product(id);
  }
  @Auth() @Get('products/:id/quote') quote(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: PurchaseQuoteDto,
  ) {
    return this.service.quote(id, dto);
  }
  @Auth() @Get('admin/categories') adminCategories(
    @Request() req: { user: CreditActor },
  ) {
    return this.service.categories(req.user);
  }
  @Auth() @Post('admin/categories') category(
    @Request() req: { user: CreditActor },
    @Body() dto: CommerceCategoryDto,
  ) {
    return this.service.category(req.user, dto);
  }
  @Auth() @Post('admin/products/:id') configure(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommerceProductDto,
  ) {
    return this.service.configure(req.user, id, dto);
  }
}
