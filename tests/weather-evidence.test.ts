import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assessWeatherSubmission } from '../src/mastra/agents/weather/evidence';
import { dailyHumidityMean, expectedLocalHours } from '../src/mastra/agents/weather/aggregate';
import { weatherCodeLabel } from '../src/mastra/agents/weather/codes';
import type { WeatherSubmission } from '../src/mastra/agents/weather/types';

const url = 'https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47';

function submission(response: any, patch: (value: WeatherSubmission) => void = () => undefined): WeatherSubmission {
  const dates = response.daily.time;
  const value = {
    schemaVersion: 2 as const,
    kind: 'weather' as const,
    status: 'ready' as const,
    reason: '',
    title: '上海天气',
    dataset: {
      categories: dates,
      series: [
        { name: '最高温', unit: '°C', metric: 'temperature-max' as const, values: response.daily.temperature_2m_max },
        { name: '最低温', unit: '°C', metric: 'temperature-min' as const, values: response.daily.temperature_2m_min },
      ],
      sources: [{ kind: 'url' as const, label: 'Open-Meteo', url }],
    },
    weather: {
      location: { name: '上海', latitude: response.latitude, longitude: response.longitude },
      timezone: response.timezone,
      dates,
      weatherCodes: response.daily.weather_code,
      fieldSources: [
        source('temperature-max', 'temperature_2m_max'),
        source('temperature-min', 'temperature_2m_min'),
        source('weather-code', 'weather_code'),
      ],
    },
  };
  patch(value);
  return value;
}

function source(metric: WeatherSubmission['weather'] extends infer T ? T extends { fieldSources: Array<infer S> } ? S['metric'] : never : never, valueField: string) {
  return {
    kind: 'url' as const, metric, sourceUrl: url, recordPath: ['daily'], dateField: 'time', valueField,
    unitField: valueField, transform: 'identity' as const,
  };
}

test('weather evidence binds each field to the same dated record', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/task-quality/weather/open-meteo-sample.json', import.meta.url), 'utf8'));
  assert.equal(fixture.live, false);
  assert.match(fixture.note, /not a live/i);
  const response = fixture.response;
  const evidence = [{ url, value: response }];
  assert.equal(assessWeatherSubmission(submission(response), evidence).complete, true);

  const otherCode = submission(response, value => { value.weather!.weatherCodes = [3, 61]; });
  assert.equal(assessWeatherSubmission(otherCode, evidence).valid, false);

  const wrongYear = structuredClone(response);
  wrongYear.daily.time = ['2025-10-22', '2025-10-23'];
  assert.equal(assessWeatherSubmission(submission(response), [{ url, value: wrongYear }]).valid, false);

  const split = structuredClone(response);
  split.hourly = { temperature_2m_max: split.daily.temperature_2m_max };
  delete split.daily.temperature_2m_max;
  assert.equal(assessWeatherSubmission(submission(response, value => {
    value.weather!.fieldSources[0].recordPath = ['hourly'];
  }), [{ url, value: split }]).valid, false);

  assert.equal(assessWeatherSubmission(submission(response), [{ url: 'https://example.invalid/forecast', value: response }]).reason, 'unverified-source');

  const reversed = submission(response, value => { value.dataset!.series[1].values = [30, 30]; });
  assert.equal(assessWeatherSubmission(reversed, evidence).reason, 'invalid-data');

  const userText = '2026-10-22,2026-10-23 最高温 22.1,20.4';
  const user = submission(response, value => {
    value.dataset!.series = [value.dataset!.series[0]];
    value.dataset!.sources = [{ kind: 'user', label: '用户', url: '' }];
    value.weather!.weatherCodes = [null, null];
    value.weather!.fieldSources = [{
      kind: 'user', metric: 'temperature-max', sourceUrl: '', recordPath: [], dateField: 'time', valueField: 'temperature_2m_max',
      unitField: null, transform: 'identity',
    }];
  });
  assert.equal(assessWeatherSubmission(user, [], userText).valid, true);
  assert.equal(user.weather?.fieldSources[0].sourceUrl, '');

  const unknown = submission(response, value => { value.weather!.weatherCodes = [1, 123]; });
  const unknownEvidence = structuredClone(response);
  unknownEvidence.daily.weather_code = [1, 123];
  const assessed = assessWeatherSubmission(unknown, [{ url, value: unknownEvidence }]);
  assert.equal(assessed.valid, true);
  assert.equal(assessed.complete, false);
  assert.equal(weatherCodeLabel(123), null);
});

test('daily humidity is the mean of a complete local day and is null when an hour is missing', () => {
  assert.equal(expectedLocalHours('2026-03-29', 'Europe/Berlin'), 23);
  assert.equal(expectedLocalHours('2026-10-25', 'Europe/Berlin'), 25);
  const times = Array.from({ length: 24 }, (_unused, hour) => `2026-10-22T${String(hour).padStart(2, '0')}:00`);
  const values = Array.from({ length: 24 }, () => 50);
  assert.equal(dailyHumidityMean({ date: '2026-10-22', timeZone: 'Asia/Shanghai', times, values }), 50);
  assert.equal(dailyHumidityMean({ date: '2026-10-22', timeZone: 'Asia/Shanghai', times: times.slice(1), values: values.slice(1) }), null);
  const spring = Array.from({ length: 23 }, (_unused, hour) => `2026-03-29T${String(hour < 2 ? hour : hour + 1).padStart(2, '0')}:00`);
  assert.equal(dailyHumidityMean({
    date: '2026-03-29', timeZone: 'Europe/Berlin', times: spring, values: Array.from({ length: 23 }, () => 40),
  }), 40);
});
