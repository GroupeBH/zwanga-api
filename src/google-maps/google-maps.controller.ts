import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { GoogleMapsService } from './google-maps.service';
import {
  GeocodeDto,
  ReverseGeocodeDto,
  GeocodeResponse,
  PlacesAutocompleteDto,
  PlaceDetailsDto,
  PlacesSearchDto,
  PlacePrediction,
  PlaceDetails,
  DirectionsDto,
  DirectionsResponse,
} from './dto/google-maps.dto';

@ApiTags('Google Maps')
@Controller('google-maps')
export class GoogleMapsController {
  constructor(private readonly googleMapsService: GoogleMapsService) {}

  @Post('geocode')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Geocode an address to coordinates' })
  @ApiResponse({ status: 200, description: 'Address geocoded successfully', type: GeocodeResponse })
  async geocode(@Body() dto: GeocodeDto): Promise<GeocodeResponse> {
    return this.googleMapsService.geocode(dto);
  }

  @Post('reverse-geocode')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reverse geocode coordinates to address' })
  @ApiResponse({ status: 200, description: 'Coordinates reverse geocoded successfully', type: GeocodeResponse })
  async reverseGeocode(@Body() dto: ReverseGeocodeDto): Promise<GeocodeResponse> {
    return this.googleMapsService.reverseGeocode(dto);
  }

  @Get('places/autocomplete')
  @Public()
  @ApiOperation({ summary: 'Get place autocomplete predictions' })
  @ApiResponse({ status: 200, description: 'Autocomplete predictions retrieved successfully', type: [PlacePrediction] })
  async placesAutocomplete(@Query() dto: PlacesAutocompleteDto): Promise<PlacePrediction[]> {
    return this.googleMapsService.placesAutocomplete(dto);
  }

  @Get('places/details')
  @Public()
  @ApiOperation({ summary: 'Get place details by place ID' })
  @ApiResponse({ status: 200, description: 'Place details retrieved successfully', type: PlaceDetails })
  async getPlaceDetails(@Query() dto: PlaceDetailsDto): Promise<PlaceDetails> {
    return this.googleMapsService.getPlaceDetails(dto);
  }

  @Get('places/search')
  @Public()
  @ApiOperation({ summary: 'Search for places using text query' })
  @ApiResponse({ status: 200, description: 'Places found successfully', type: [PlaceDetails] })
  async placesSearch(@Query() dto: PlacesSearchDto): Promise<PlaceDetails[]> {
    return this.googleMapsService.placesSearch(dto);
  }

  @Post('directions')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get directions between origin and destination' })
  @ApiResponse({ status: 200, description: 'Directions retrieved successfully', type: DirectionsResponse })
  async getDirections(@Body() dto: DirectionsDto): Promise<DirectionsResponse> {
    return this.googleMapsService.getDirections(dto);
  }
}

