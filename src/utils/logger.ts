import pino from "pino";

// Logger pour la console. Il écrit sur stderr, pour que la ligne de commande
// garde stdout pour les résultats seuls.
const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:dd-mm-yyyy HH:MM:ss",
      ignore: "pid,hostname",
      destination: 2,
    },
  },
  base: {
    pid: false,
    hostname: false,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Sets the level of the reconciliation logs ("info" by default). */
export function setLogLevel(level: string): void {
  logger.level = level;
}

export default logger;
