import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class YandexGeocodeDto {
  @ApiProperty({ description: 'Address or place text to geocode' })
  @IsString()
  address: string;

  @ApiPropertyOptional({
    description: 'Yandex language code, for example en_US, ru_RU, tr_TR',
    default: 'en_US',
  })
  @IsOptional()
  @IsString()
  lang?: string;

  @ApiPropertyOptional({ description: 'Longitude for search bias' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ description: 'Latitude for search bias' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({
    description: 'Viewport span as "longitudeDelta,latitudeDelta"',
  })
  @IsOptional()
  @IsString()
  span?: string;

  @ApiPropertyOptional({
    description: 'Bounding box as "lon1,lat1~lon2,lat2"',
  })
  @IsOptional()
  @IsString()
  bbox?: string;

  @ApiPropertyOptional({
    description: 'Restrict search to the provided ll/spn or bbox area',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  strictBounds?: boolean;

  @ApiPropertyOptional({ description: 'Maximum result count', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  results?: number;

  @ApiPropertyOptional({ description: 'Number of results to skip', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

export class YandexReverseGeocodeDto {
  @ApiProperty({ description: 'Latitude' })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ description: 'Longitude' })
  @Type(() => Number)
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({
    description:
      'Yandex object kind filter, for example house, street, metro, district, locality',
  })
  @IsOptional()
  @IsString()
  kind?: string;

  @ApiPropertyOptional({
    description: 'Yandex language code, for example en_US, ru_RU, tr_TR',
    default: 'en_US',
  })
  @IsOptional()
  @IsString()
  lang?: string;

  @ApiPropertyOptional({ description: 'Maximum result count', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  results?: number;
}

export class YandexPlacesSearchDto {
  @ApiProperty({ description: 'Free-text place search query' })
  @IsString()
  text: string;

  @ApiPropertyOptional({
    description: 'Yandex search type, usually biz for organizations or geo',
    default: 'biz',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Yandex language code, for example en_US, ru_RU, tr_TR',
    default: 'en_US',
  })
  @IsOptional()
  @IsString()
  lang?: string;

  @ApiPropertyOptional({ description: 'Location bias latitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ description: 'Location bias longitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({
    description: 'Viewport span as "longitudeDelta,latitudeDelta"',
  })
  @IsOptional()
  @IsString()
  span?: string;

  @ApiPropertyOptional({
    description: 'Bounding box as "lon1,lat1~lon2,lat2"',
  })
  @IsOptional()
  @IsString()
  bbox?: string;

  @ApiPropertyOptional({
    description: 'Restrict search to the provided ll/spn or bbox area',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  strictBounds?: boolean;

  @ApiPropertyOptional({ description: 'Maximum result count', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  results?: number;

  @ApiPropertyOptional({ description: 'Number of results to skip', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

export class YandexGeosuggestDto {
  @ApiProperty({ description: 'Text to suggest locations for' })
  @IsString()
  text: string;

  @ApiPropertyOptional({
    description: 'Response language code, for example fr, en, ru',
  })
  @IsOptional()
  @IsString()
  lang?: string;

  @ApiPropertyOptional({
    description: 'Unique session token used by Yandex for Geosuggest billing',
  })
  @IsOptional()
  @IsString()
  sessionToken?: string;

  @ApiPropertyOptional({
    description: 'Suggestion types supported by Yandex, comma separated',
  })
  @IsOptional()
  @IsString()
  types?: string;

  @ApiPropertyOptional({ description: 'Location bias latitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ description: 'Location bias longitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({
    description: 'Viewport span as "longitudeDelta,latitudeDelta"',
  })
  @IsOptional()
  @IsString()
  span?: string;

  @ApiPropertyOptional({
    description: 'Bounding box as "lon1,lat1~lon2,lat2"',
  })
  @IsOptional()
  @IsString()
  bbox?: string;

  @ApiPropertyOptional({
    description: 'Strictly limit suggestions to the provided search window',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  strictBounds?: boolean;

  @ApiPropertyOptional({
    description: 'Comma-separated ISO country codes, for example cd,ru,kz',
  })
  @IsOptional()
  @IsString()
  countries?: string;

  @ApiPropertyOptional({
    description: 'Return post-component address in the suggestion response',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  printAddress?: boolean;

  @ApiPropertyOptional({
    description: 'Additional attributes to return, for example uri',
  })
  @IsOptional()
  @IsString()
  attrs?: string;

  @ApiPropertyOptional({ description: 'Maximum result count', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  results?: number;
}

export class YandexPoint {
  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;
}

export class YandexBounds {
  @ApiProperty({ type: YandexPoint })
  southwest: YandexPoint;

  @ApiProperty({ type: YandexPoint })
  northeast: YandexPoint;
}

export class YandexGeocodeResult {
  @ApiProperty()
  formattedAddress: string;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiPropertyOptional()
  name?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  kind?: string;

  @ApiPropertyOptional()
  precision?: string;

  @ApiPropertyOptional()
  countryCode?: string;

  @ApiPropertyOptional()
  postalCode?: string;

  @ApiPropertyOptional({ type: YandexBounds })
  boundedBy?: YandexBounds;

  @ApiPropertyOptional()
  rawId?: string;
}

export class YandexPlaceResult {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  formattedAddress?: string;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  uri?: string;

  @ApiPropertyOptional()
  phoneNumber?: string;

  @ApiPropertyOptional()
  website?: string;

  @ApiPropertyOptional()
  rating?: number;

  @ApiPropertyOptional({ type: [String] })
  categories?: string[];

  @ApiPropertyOptional()
  source?: string;
}

export class YandexSuggestResult {
  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  subtitle?: string;

  @ApiPropertyOptional()
  uri?: string;

  @ApiPropertyOptional()
  formattedAddress?: string;

  @ApiPropertyOptional()
  lat?: number;

  @ApiPropertyOptional()
  lng?: number;

  @ApiPropertyOptional({ type: [String] })
  tags?: string[];

  @ApiPropertyOptional()
  distance?: number;
}
