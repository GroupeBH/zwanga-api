import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  YandexGeocodeDto,
  YandexGeocodeResult,
  YandexGeosuggestDto,
  YandexPlaceResult,
  YandexPlacesSearchDto,
  YandexReverseGeocodeDto,
  YandexSuggestResult,
} from './dto/yandex-maps.dto';

@Injectable()
export class YandexMapsService {
  private readonly logger = new Logger(YandexMapsService.name);
  private readonly apiKey: string;
  private readonly geocoderUrl: string;
  private readonly placesUrl: string;
  private readonly geosuggestUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('YANDEX_MAPS_API_KEY') || '';
    this.geocoderUrl =
      this.configService.get<string>('YANDEX_GEOCODER_URL') ||
      'https://geocode-maps.yandex.ru/v1/';
    this.placesUrl =
      this.configService.get<string>('YANDEX_PLACES_URL') ||
      'https://search-maps.yandex.ru/v1/';
    this.geosuggestUrl =
      this.configService.get<string>('YANDEX_GEOSUGGEST_URL') ||
      'https://suggest-maps.yandex.ru/v1/suggest';

    if (!this.apiKey) {
      this.logger.warn(
        'YANDEX_MAPS_API_KEY is not configured. Yandex Maps services may not work properly.',
      );
    }
  }

  async geocode(dto: YandexGeocodeDto): Promise<YandexGeocodeResult[]> {
    this.ensureApiKey();

    try {
      const params = this.withCommonParams({
        geocode: dto.address,
        lang: dto.lang || 'en_US',
        format: 'json',
        results: dto.results,
        skip: dto.skip,
        ll: this.buildLl(dto.longitude, dto.latitude),
        spn: dto.span,
        bbox: dto.bbox,
        rspn: this.toFlag(dto.strictBounds),
      });

      const response = await firstValueFrom(
        this.httpService.get(this.geocoderUrl, { params }),
      );

      return this.mapGeocoderResponse(response.data);
    } catch (error) {
      this.handleProviderError(error, 'Yandex geocoding failed');
    }
  }

  async reverseGeocode(
    dto: YandexReverseGeocodeDto,
  ): Promise<YandexGeocodeResult[]> {
    this.ensureApiKey();

    try {
      const params = this.withCommonParams({
        geocode: `${dto.lng},${dto.lat}`,
        lang: dto.lang || 'en_US',
        format: 'json',
        kind: dto.kind,
        results: dto.results ?? 1,
      });

      const response = await firstValueFrom(
        this.httpService.get(this.geocoderUrl, { params }),
      );

      return this.mapGeocoderResponse(response.data);
    } catch (error) {
      this.handleProviderError(error, 'Yandex reverse geocoding failed');
    }
  }

  async searchPlaces(dto: YandexPlacesSearchDto): Promise<YandexPlaceResult[]> {
    this.ensureApiKey();

    try {
      const params = this.withCommonParams({
        text: dto.text,
        type: dto.type || 'biz',
        lang: dto.lang || 'en_US',
        results: dto.results,
        skip: dto.skip,
        ll: this.buildLl(dto.longitude, dto.latitude),
        spn: dto.span,
        bbox: dto.bbox,
        rspn: this.toFlag(dto.strictBounds),
      });

      const response = await firstValueFrom(
        this.httpService.get(this.placesUrl, { params }),
      );

      return this.mapPlacesResponse(response.data);
    } catch (error) {
      this.handleProviderError(error, 'Yandex places search failed');
    }
  }

  async geosuggest(dto: YandexGeosuggestDto): Promise<YandexSuggestResult[]> {
    this.ensureApiKey();

    try {
      const params = this.withCommonParams({
        text: dto.text,
        lang: dto.lang,
        sessiontoken: dto.sessionToken,
        types: dto.types,
        results: dto.results,
        ll: this.buildLl(dto.longitude, dto.latitude),
        spn: dto.span,
        bbox: dto.bbox,
        strict_bounds: this.toFlag(dto.strictBounds),
        countries: dto.countries,
        print_address: this.toFlag(dto.printAddress),
        attrs: dto.attrs,
      });

      const response = await firstValueFrom(
        this.httpService.get(this.geosuggestUrl, { params }),
      );

      return this.mapGeosuggestResponse(response.data);
    } catch (error) {
      this.handleProviderError(error, 'Yandex geosuggest failed');
    }
  }

  private ensureApiKey(): void {
    if (!this.apiKey) {
      throw new InternalServerErrorException(
        'YANDEX_MAPS_API_KEY is not configured',
      );
    }
  }

  private withCommonParams(
    params: Record<string, string | number | undefined>,
  ): Record<string, string> {
    const normalized: Record<string, string> = {
      apikey: this.apiKey,
    };

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        normalized[key] = String(value);
      }
    }

    return normalized;
  }

  private buildLl(longitude?: number, latitude?: number): string | undefined {
    if (longitude === undefined || latitude === undefined) {
      return undefined;
    }

    return `${longitude},${latitude}`;
  }

  private toFlag(value?: boolean): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    return value ? '1' : '0';
  }

  private mapGeocoderResponse(data: any): YandexGeocodeResult[] {
    const members =
      data?.response?.GeoObjectCollection?.featureMember ??
      data?.GeoObjectCollection?.featureMember ??
      [];

    return members
      .map((member: any) => this.mapGeoObject(member?.GeoObject))
      .filter(
        (result: YandexGeocodeResult | null): result is YandexGeocodeResult =>
          Boolean(result),
      );
  }

  private mapGeoObject(geoObject: any): YandexGeocodeResult | null {
    if (!geoObject) {
      return null;
    }

    const point = this.parsePos(geoObject?.Point?.pos);
    if (!point) {
      return null;
    }

    const geocoderMeta = geoObject?.metaDataProperty?.GeocoderMetaData;
    const address = geocoderMeta?.Address;

    return {
      formattedAddress:
        geocoderMeta?.text ||
        address?.formatted ||
        [geoObject?.name, geoObject?.description].filter(Boolean).join(', '),
      lat: point.lat,
      lng: point.lng,
      name: geoObject?.name,
      description: geoObject?.description,
      kind: geocoderMeta?.kind,
      precision: geocoderMeta?.precision,
      countryCode: address?.country_code,
      postalCode: address?.postal_code,
      boundedBy: this.mapEnvelope(geoObject?.boundedBy?.Envelope),
      rawId: geoObject?.metaDataProperty?.GeocoderMetaData?.id,
    };
  }

  private mapPlacesResponse(data: any): YandexPlaceResult[] {
    const features = data?.features ?? [];

    return features
      .map((feature: any) => this.mapPlaceFeature(feature))
      .filter((result: YandexPlaceResult | null): result is YandexPlaceResult =>
        Boolean(result),
      );
  }

  private mapPlaceFeature(feature: any): YandexPlaceResult | null {
    const coordinates = this.parseCoordinates(feature?.geometry?.coordinates);
    if (!coordinates) {
      return null;
    }

    const properties = feature?.properties ?? {};
    const company = properties?.CompanyMetaData ?? {};
    const geocoderMeta = properties?.GeocoderMetaData ?? {};
    const address =
      company?.address ||
      company?.Address?.formatted ||
      geocoderMeta?.text ||
      properties?.description;
    const name = company?.name || properties?.name;

    if (!name && !address) {
      return null;
    }

    return {
      id:
        company?.id ||
        feature?.id ||
        company?.uri ||
        `${coordinates.lng},${coordinates.lat}`,
      name: name || address,
      formattedAddress: address,
      lat: coordinates.lat,
      lng: coordinates.lng,
      description: properties?.description,
      uri: company?.uri || properties?.uri,
      phoneNumber: this.pickPhone(company),
      website: this.pickWebsite(company),
      rating: this.pickRating(company),
      categories: this.pickCategories(company),
      source: 'yandex',
    };
  }

  private mapGeosuggestResponse(data: any): YandexSuggestResult[] {
    const suggestions = data?.results ?? data?.suggestions ?? [];

    return suggestions.map((suggestion: any) => {
      const coordinates = this.pickSuggestionCoordinates(suggestion);

      return {
        title: this.pickText(suggestion?.title) || suggestion?.name || '',
        subtitle:
          this.pickText(suggestion?.subtitle) ||
          suggestion?.description ||
          suggestion?.address?.formatted_address,
        uri: suggestion?.uri,
        formattedAddress:
          suggestion?.address?.formatted_address ||
          suggestion?.address?.formatted ||
          this.pickText(suggestion?.subtitle),
        lat: coordinates?.lat,
        lng: coordinates?.lng,
        tags: Array.isArray(suggestion?.tags) ? suggestion.tags : undefined,
        distance:
          suggestion?.distance?.value ??
          suggestion?.distance ??
          suggestion?.properties?.distance,
      };
    });
  }

  private parsePos(pos?: string): { lat: number; lng: number } | null {
    if (!pos) {
      return null;
    }

    const [lng, lat] = pos.split(/\s+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  }

  private parseCoordinates(
    coordinates: any,
  ): { lat: number; lng: number } | null {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null;
    }

    const [lng, lat] = coordinates.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  }

  private mapEnvelope(envelope: any): YandexGeocodeResult['boundedBy'] {
    const lower = this.parsePos(envelope?.lowerCorner);
    const upper = this.parsePos(envelope?.upperCorner);

    if (!lower || !upper) {
      return undefined;
    }

    return {
      southwest: lower,
      northeast: upper,
    };
  }

  private pickPhone(company: any): string | undefined {
    const phones = company?.Phones;
    if (!Array.isArray(phones) || !phones.length) {
      return undefined;
    }

    return phones[0]?.formatted || phones[0]?.number;
  }

  private pickWebsite(company: any): string | undefined {
    if (company?.url) {
      return company.url;
    }

    const links = company?.Links;
    if (!Array.isArray(links) || !links.length) {
      return undefined;
    }

    return links[0]?.href;
  }

  private pickRating(company: any): number | undefined {
    const value = company?.Rating?.value ?? company?.rating;
    const rating = Number(value);

    return Number.isFinite(rating) ? rating : undefined;
  }

  private pickCategories(company: any): string[] | undefined {
    const categories = company?.Categories;
    if (!Array.isArray(categories)) {
      return undefined;
    }

    return categories
      .map((category: any) => category?.name || category?.class)
      .filter((category: string | undefined): category is string =>
        Boolean(category),
      );
  }

  private pickSuggestionCoordinates(
    suggestion: any,
  ): { lat: number; lng: number } | null {
    return (
      this.parseCoordinates(suggestion?.coordinates) ||
      this.parseCoordinates(suggestion?.center) ||
      this.parseCoordinates(suggestion?.geometry?.coordinates) ||
      this.parseSuggestionLatLng(suggestion)
    );
  }

  private parseSuggestionLatLng(
    suggestion: any,
  ): { lat: number; lng: number } | null {
    const lat = Number(suggestion?.lat ?? suggestion?.latitude);
    const lng = Number(
      suggestion?.lon ?? suggestion?.lng ?? suggestion?.longitude,
    );

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  }

  private pickText(value: any): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    return value?.text;
  }

  private handleProviderError(error: any, fallbackMessage: string): never {
    if (
      error instanceof BadRequestException ||
      error instanceof InternalServerErrorException
    ) {
      throw error;
    }

    const status = error?.response?.status;
    const providerData = error?.response?.data;
    const providerMessage =
      providerData?.message ||
      providerData?.error?.message ||
      providerData?.error ||
      error?.message ||
      fallbackMessage;

    this.logger.error(`${fallbackMessage}: ${providerMessage}`, error?.stack);

    if (status && status >= 400 && status < 500) {
      throw new BadRequestException(providerMessage);
    }

    throw new InternalServerErrorException(fallbackMessage);
  }
}
