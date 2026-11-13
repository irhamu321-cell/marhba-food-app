/*
 * PM2 configuration for Marhba.
 *
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup     # survive a reboot
 *   pm2 logs marhba             # follow the log
 *   pm2 reload marhba           # restart with no dropped request
 *
 * DEPLOY.md uses systemd instead, which needs nothing installed. Use this
 * file if you already run PM2, or if you want its log rotation and its
 * dashboard. Do not run both at once: two supervisors fighting over one port
 * is a confusing outage.
 */
module.exports = {
  apps: [
    {
      name: 'marhba',
      script: 'server/src/index.js',
      cwd: __dirname,

      /*
       * One process, not a cluster.
       *
       * On SQLite this is not a preference, it is a requirement: the database
       * is a file opened by this process, and several workers writing to it
       * would serialise at best and corrupt at worst. The app also keeps
       * state in memory that must not be split across workers — the live
       * order streams, the one-use stream tickets, the pilot code console and
       * the login rate limiter all live in one process on purpose.
       *
       * Move to PostgreSQL first (DATABASE_URL), move those four pieces of
       * state out second, and only then raise `instances`.
       */
      exec_mode: 'fork',
      instances: 1,

      // A Moroccan pilot does not need more, and a leak should be visible
      // rather than swallowed by a large ceiling.
      max_memory_restart: '500M',

      autorestart: true,
      watch: false,
      // Crash loops: stop retrying rather than hammering a broken config.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      // Reloads wait for in-flight requests; SSE clients reconnect by design.
      kill_timeout: 8000,
      listen_timeout: 10000,
      wait_ready: false,

      out_file: '/var/log/marhba.log',
      error_file: '/var/log/marhba.error.log',
      merge_logs: true,
      time: false, // the app already timestamps every line itself

      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        HOST: '127.0.0.1',
      },

      /*
       * Production values belong in /opt/marhba/.env, not here: this file is
       * committed to the repository and a secret in it is a secret in your
       * git history. PM2 reads .env through the app itself.
       */
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1',
        TRUST_PROXY: '1',
      },
    },
  ],
};
