import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import {
  YandexGeocodeDto,
  YandexGeocodeResult,
  YandexGeosuggestDto,
  YandexPlaceResult,
  YandexPlacesSearchDto,
  YandexReverseGeocodeDto,
  YandexSuggestResult,
} from './dto/yandex-maps.dto';
import { YandexMapsService } from './yandex-maps.service';

@ApiTags('Yandex Maps')
@Controller('yandex-maps')
export class YandexMapsController {
  constructor(private readonly yandexMapsService: YandexMapsService) {}

  @Post('geocode')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Geocode an address using Yandex Geocoder API' })
  @ApiResponse({
    status: 200,
    description: 'Address geocoded successfully',
    type: [YandexGeocodeResult],
  })
  async geocode(@Body() dto: YandexGeocodeDto): Promise<YandexGeocodeResult[]> {
    return this.yandexMapsService.geocode(dto);
  }

  @Post('reverse-geocode')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Reverse geocode coordinates using Yandex Geocoder API',
  })
  @ApiResponse({
    status: 200,
    description: 'Coordinates reverse geocoded successfully',
    type: [YandexGeocodeResult],
  })
  async reverseGeocode(
    @Body() dto: YandexReverseGeocodeDto,
  ): Promise<YandexGeocodeResult[]> {
    return this.yandexMapsService.reverseGeocode(dto);
  }

  @Get('places/search')
  @Public()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Search places using Yandex Places HTTP API' })
  @ApiResponse({
    status: 200,
    description: 'Places retrieved successfully',
    type: [YandexPlaceResult],
  })
  async searchPlaces(
    @Query() dto: YandexPlacesSearchDto,
  ): Promise<YandexPlaceResult[]> {
    return this.yandexMapsService.searchPlaces(dto);
  }

  @Get('geosuggest')
  @Public()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Get suggestions using Yandex Geosuggest API' })
  @ApiResponse({
    status: 200,
    description: 'Suggestions retrieved successfully',
    type: [YandexSuggestResult],
  })
  async geosuggest(
    @Query() dto: YandexGeosuggestDto,
  ): Promise<YandexSuggestResult[]> {
    return this.yandexMapsService.geosuggest(dto);
  }
}
