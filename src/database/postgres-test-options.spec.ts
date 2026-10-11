import { postgresTestServerOptions } from '../../test/postgres-test-options';

describe('disposable PostgreSQL server options', () => {
  it.each([1024, 37999, 65535])(
    'uses only loopback TCP on port %s without a system socket directory',
    port => {
      const options = postgresTestServerOptions(port).split(' ');
      expect(options).toEqual([
        '-h', '127.0.0.1', '-p', String(port), '-c', 'unix_socket_directories=',
      ]);
    },
  );
});
