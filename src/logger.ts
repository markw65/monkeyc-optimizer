let loggerSettings: Map<string, number> | null = null;
let theLogger = console.log;

export function logger(module: string, level: number, message: unknown) {
  if (wouldLog(module, level)) {
    log(message);
  }
}

export function wouldLog(module: string, level: number) {
  if (!loggerSettings) {
    loggerSettings = getLoggerSettings();
  }
  return (loggerSettings.get(module) ?? 0) >= level;
}

export function log(message: unknown) {
  if (theLogger === console.log) {
    theLogger(message);
  } else {
    theLogger(`${message}`);
  }
}

export function setLogger(log: (message: string) => void) {
  theLogger = log;
}

function getLoggerSettings() {
  const ls = new Map();
  const settings = process.env["MC_LOGGER"];
  if (settings) {
    settings.split(";").forEach((setting) => {
      const results = setting.split(/[:=]/, 2);
      if (results.length === 1) {
        ls.set(results[0], 1);
      } else {
        ls.set(results[0], Number(results[1]));
      }
    });
  }
  return ls;
}