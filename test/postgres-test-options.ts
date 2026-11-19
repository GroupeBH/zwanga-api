/** pg_ctl -o options for disposable test clusters, never the application DB. */
export function postgresTestServerOptions(port: number): string {
  // Debian/Ubuntu default to /var/run/postgresql, which the CI user cannot
  // write. Every test connects over loopback TCP, so no Unix socket is needed.
  // Keeping the empty value unquoted also works through pg_ctl on Windows.
  // When the runner explicitly uses UTC, align PostgreSQL too (notably on
  // Windows). Otherwise preserve the existing local test-runner timezone.
  const timezone = process.env.TZ === 'UTC' ? ' -c timezone=UTC' : '';
  return `-h 127.0.0.1 -p ${port} -c unix_socket_directories=${timezone}`;
}
