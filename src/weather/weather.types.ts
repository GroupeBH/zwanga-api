export type WeatherCoordinates = [longitude: number, latitude: number];

export interface WeatherZone {
  id: string;
  name: string;
  city: string;
  province: string;
  countryCode: string;
  coordinates: WeatherCoordinates;
  coverageRadiusKm: number;
}

export interface WeatherObservation {
  zoneId: string;
  available: boolean;
  heavyRain: boolean;
  conditionCodes: number[];
  description: string | null;
  rainOneHourMm: number;
  observedAt: string;
}

export interface WeatherRouteImpact {
  heavyRain: boolean;
  dataAvailable: boolean;
  priceMultiplier: number;
  etaMultiplier: number;
  evaluatedZoneIds: string[];
  affectedZoneIds: string[];
}
