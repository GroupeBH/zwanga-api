/** pg_ctl -o options for disposable test clusters, never the application DB. */
export function postgresTestServerOptions(port: number): string {
  // Debian/Ubuntu default to /var/run/postgresql, which the CI user cannot
  // write. Every test connects over loopback TCP, so no Unix socket is needed.
  // Keeping the empty value unquoted also works through pg_ctl on Windows.
  return `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`;
}
