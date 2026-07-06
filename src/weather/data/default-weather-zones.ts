import { WeatherZone } from '../weather.types';

export const DEFAULT_WEATHER_ZONES: WeatherZone[] = [
  {
    id: 'cd-kinshasa-gombe',
    name: 'Centre (Gombe)',
    city: 'Kinshasa',
    province: 'Kinshasa',
    countryCode: 'CD',
    coordinates: [15.3136, -4.3073],
    coverageRadiusKm: 20,
  },
  {
    id: 'cd-kinshasa-ngaliema',
    name: 'Ouest (Ngaliema)',
    city: 'Kinshasa',
    province: 'Kinshasa',
    countryCode: 'CD',
    coordinates: [15.2199, -4.3712],
    coverageRadiusKm: 20,
  },
  {
    id: 'cd-kinshasa-mont-ngafula',
    name: 'Sud (Mont-Ngafula)',
    city: 'Kinshasa',
    province: 'Kinshasa',
    countryCode: 'CD',
    coordinates: [15.2672, -4.4268],
    coverageRadiusKm: 20,
  },
  {
    id: 'cd-kinshasa-ndjili',
    name: "Est (N'djili)",
    city: 'Kinshasa',
    province: 'Kinshasa',
    countryCode: 'CD',
    coordinates: [15.403, -4.4075],
    coverageRadiusKm: 20,
  },
];
