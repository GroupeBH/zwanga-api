module.exports = {
  apps: [
    {
      name: 'zwanga-backend',
      script: './dist/main.js',
      // Laisse les instances et le mode d'exécution non spécifiés
      // par défaut, ce qui équivaut à instances: 1 et exec_mode: 'fork' (mode single instance)
      
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
        exec_mode: 'fork',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
        // **Ajouté/Déplacé pour la Production**
        instances: '2', // Ou 'max' pour tous les CPU
        exec_mode: 'cluster',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      merge_logs: true,
      autorestart: false,
      max_memory_restart: '1G',
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'dist'],
      instance_var: 'INSTANCE_ID',
    },
  ],
};