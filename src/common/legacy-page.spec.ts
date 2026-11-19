import 'reflect-metadata';
import { optionalLegacyPage } from './legacy-page';

it('does not silently truncate legacy snapshots but bounds explicit pagination', () => {
  expect(optionalLegacyPage()).toEqual({});
  expect(optionalLegacyPage({ limit: undefined, page: undefined })).toEqual({});
  expect(optionalLegacyPage({ page: 2 })).toEqual({ take: 100, skip: 100 });
  expect(optionalLegacyPage({ limit: 20, page: 3 })).toEqual({
    take: 20,
    skip: 40,
  });
  expect(optionalLegacyPage({ limit: 10000, page: 1 })).toEqual({
    take: 100,
    skip: 0,
  });
});
