# Weather Awareness

The backend refreshes current weather every 20 minutes for four default
Kinshasa zones: Gombe, Ngaliema, Mont-Ngafula and N'djili.

## Configuration

```env
OPENWEATHER_API_KEY=
OPENWEATHER_BASE_URL=https://api.openweathermap.org/data/2.5
WEATHER_HEAVY_RAIN_THRESHOLD_MM_PER_HOUR=7.6
WEATHER_ZONES_JSON=
```

`WEATHER_ZONES_JSON` can replace the default catalogue for deployment in the
rest of DR Congo or neighboring countries. Coordinates use
`[longitude, latitude]`.

```json
[
  {
    "id": "cd-nk-goma",
    "name": "Goma Centre",
    "city": "Goma",
    "province": "Nord-Kivu",
    "countryCode": "CD",
    "coordinates": [29.2205, -1.6585],
    "coverageRadiusKm": 25
  }
]
```

OpenWeather condition codes `202`, `502`, `503`, `504` and `522`, or rain at
or above the configured hourly threshold, activate a `1.3` price multiplier
and a `1.4` ETA multiplier. Missing, invalid or unavailable weather data always
uses neutral multipliers.
