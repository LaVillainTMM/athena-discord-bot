module.exports = {
  apps: [
    {
      name: "athena-discord-bot",
      script: "bot.js",
      interpreter: "node",
      interpreter_args: "--experimental-vm-modules",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
